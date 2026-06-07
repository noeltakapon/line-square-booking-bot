import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fsSync from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadDotEnv(path.resolve(__dirname, "../settings.env"));
loadDotEnv(path.resolve(__dirname, "../.env"));

const config = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || "0.0.0.0",
  lineChannelSecret: process.env.LINE_CHANNEL_SECRET || "",
  lineChannelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || "",
  squareAccessToken: process.env.SQUARE_ACCESS_TOKEN || "",
  squareVersion: process.env.SQUARE_VERSION || "2026-05-20",
  squareBaseUrl: process.env.SQUARE_BASE_URL || "https://connect.squareup.com",
  searchDaysAhead: Number(process.env.SEARCH_DAYS_AHEAD || 180),
  upstashUrl: process.env.UPSTASH_REDIS_REST_URL || "",
  upstashToken: process.env.UPSTASH_REDIS_REST_TOKEN || "",
};
const serviceNameCache = new Map();

async function redisGet(key) {
  const res = await fetch(`${config.upstashUrl}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${config.upstashToken}` },
  });
  const data = await res.json();
  return data.result ? JSON.parse(data.result) : null;
}

async function redisSet(key, value) {
  await fetch(`${config.upstashUrl}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.upstashToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ value: JSON.stringify(value) }),
  });
}

async function redisDel(key) {
  await fetch(`${config.upstashUrl}/del/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.upstashToken}` },
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "POST" && req.url === "/webhook") {
      const rawBody = await readBody(req);
      if (!verifyLineSignature(rawBody, req.headers["x-line-signature"])) {
        return sendJson(res, 401, { error: "invalid LINE signature" });
      }
      const payload = JSON.parse(rawBody.toString("utf8"));
      // すぐ200を返してからイベント処理（タイムアウト対策）
      sendJson(res, 200, { ok: true });
      await Promise.all((payload.events || []).map(handleLineEventSafely));
      return;
    }
    sendJson(res, 404, { error: "not found" });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "internal error" });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`LINE x Square booking bot listening on ${config.host}:${config.port}`);
});

async function handleLineEvent(event) {
  if (event.type !== "message" || event.message?.type !== "text" || !event.replyToken) return;
  const lineUserId = event.source?.userId;
  const text = event.message.text.trim();
  if (!lineUserId) {
    await replyText(event.replyToken, "個別チャットでご利用ください。");
    return;
  }

  if (isResetCommand(text)) {
    await redisDel(`link:${lineUserId}`);
    await replyText(event.replyToken, "登録を解除しました。もう一度「予約確認」と送ると再登録できます。");
    return;
  }

  if (isBookingCommand(text)) {
    const link = await redisGet(`link:${lineUserId}`);
    if (!link?.squareCustomerId) {
      await redisSet(`pending:${lineUserId}`, { action: "booking" });
      await replyText(event.replyToken, "予約確認ですね。初回だけ本人確認をします。\nお名前と電話番号の下4桁を送ってください。\n例: 山田花子 1234");
      return;
    }
    await replyText(event.replyToken, "確認中です...");
    const bookings = await listUpcomingBookings(link.squareCustomerId);
    await pushText(lineUserId, await formatBookings(bookings));
    return;
  }

  if (isVisitHistoryCommand(text)) {
    const link = await redisGet(`link:${lineUserId}`);
    if (!link?.squareCustomerId) {
      await redisSet(`pending:${lineUserId}`, { action: "history" });
      await replyText(event.replyToken, "来店履歴ですね。初回だけ本人確認をします。\nお名前と電話番号の下4桁を送ってください。\n例: 山田花子 1234");
      return;
    }
    await replyText(event.replyToken, "確認中です...");
    const bookings = await listPastBookings(link.squareCustomerId);
    await pushText(lineUserId, await formatPastBookings(bookings));
    return;
  }

  const pending = await redisGet(`pending:${lineUserId}`);
  if (!pending) return;

  const identity = parseIdentity(text);
  if (!identity) return;

  // 先に「確認中」と返信してからSquare処理
  await replyText(event.replyToken, "確認中です...");

  const matchedCustomer = await findCustomerByNameAndPhoneSuffix(identity.name, identity.phoneSuffix);
  if (!matchedCustomer) {
    await pushText(lineUserId, "該当するお客様情報が見つかりませんでした。お名前の表記と電話番号下4桁を確認して、もう一度送ってください。");
    return;
  }

  await redisSet(`link:${lineUserId}`, { squareCustomerId: matchedCustomer.id, linkedAt: new Date().toISOString() });
  await redisDel(`pending:${lineUserId}`);

  if (pending.action === "history") {
    const bookings = await listPastBookings(matchedCustomer.id);
    await pushText(lineUserId, `本人確認ができました。\n\n${await formatPastBookings(bookings)}`);
    return;
  }
  const bookings = await listUpcomingBookings(matchedCustomer.id);
  await pushText(lineUserId, `本人確認ができました。\n\n${await formatBookings(bookings)}`);
}

async function handleLineEventSafely(event) {
  try {
    await handleLineEvent(event);
  } catch (error) {
    console.error("LINE event handling failed:", error);
    if (event.source?.userId) {
      await pushText(event.source.userId, "予約情報の確認中にエラーが出ました。少し時間をおいて、もう一度送ってください。")
        .catch((e) => console.error("Fallback push failed:", e));
    }
  }
}

function isBookingCommand(text) { return text.replace(/\s/g, "") === "予約確認"; }
function isVisitHistoryCommand(text) { return text.replace(/\s/g, "") === "来店履歴"; }
function isResetCommand(text) { return ["解除", "登録解除", "リセット"].includes(text.replace(/\s/g, "")); }

function parseIdentity(text) {
  const match = text.match(/^(.+?)[\s　,、]+(\d{4})$/);
  if (!match) return null;
  return { name: normalizeText(match[1]), phoneSuffix: match[2] };
}

async function findCustomerByNameAndPhoneSuffix(name, phoneSuffix) {
  let cursor;
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({ limit: "100" });
    if (cursor) params.set("cursor", cursor);
    const result = await squareRequest(`/v2/customers?${params}`, { method: "GET" });
    const match = (result.customers || []).find((c) => {
      const names = customerNameCandidates(c);
      const phone = normalizePhone(c.phone_number || "");
      return phone.endsWith(phoneSuffix) && names.some((n) => namesMatch(n, name));
    });
    if (match) return match;
    if (!result.cursor) return null;
    cursor = result.cursor;
  }
  return null;
}

function customerNameCandidates(customer) {
  return [
    `${customer.family_name || ""}${customer.given_name || ""}`,
    `${customer.given_name || ""}${customer.family_name || ""}`,
    customer.nickname || "",
    customer.company_name || "",
    customer.reference_id || "",
  ].map(normalizeText).filter(Boolean);
}

function namesMatch(candidate, input) {
  return candidate === input || candidate.includes(input) || input.includes(candidate);
}

async function listUpcomingBookings(customerId) {
  const now = new Date();
  const max = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const bookings = await listBookingsInRange(customerId, now, max, 20);
  return bookings.filter((b) => ["ACCEPTED", "PENDING"].includes(b.status))
    .sort((a, b) => new Date(a.start_at) - new Date(b.start_at));
}

async function listPastBookings(customerId) {
  const results = [];
  const now = new Date();
  let rangeEnd = now;
  for (let chunk = 0; chunk < 6 && results.length < 5; chunk++) {
    const rangeStart = new Date(rangeEnd.getTime() - 60 * 24 * 60 * 60 * 1000);
    const bookings = await listBookingsInRange(customerId, rangeStart, rangeEnd, 20);
    results.push(...bookings.filter((b) =>
      new Date(b.start_at) < now && !["CANCELLED_BY_CUSTOMER", "CANCELLED_BY_SELLER", "DECLINED"].includes(b.status)
    ));
    rangeEnd = rangeStart;
  }
  return results.sort((a, b) => new Date(b.start_at) - new Date(a.start_at)).slice(0, 5);
}

async function listBookingsInRange(customerId, start, end, limit) {
  const params = new URLSearchParams({
    customer_id: customerId,
    start_at_min: start.toISOString(),
    start_at_max: end.toISOString(),
    limit: String(limit),
  });
  const result = await squareRequest(`/v2/bookings?${params}`, { method: "GET" });
  return result.bookings || [];
}

async function formatBookings(bookings) {
  if (!bookings.length) return "現在、確認できる今後の予約はありません。";
  const lines = await Promise.all(bookings.slice(0, 5).map(async (b, i) => {
    const date = formatTokyoDate(b.start_at);
    const segments = b.appointment_segments || [];
    const menuNames = (await Promise.all(segments.map(getServiceName))).filter(Boolean);
    const menu = menuNames.length ? ` / ${menuNames.join("・")}` : "";
    const minutes = segments.reduce((s, seg) => s + Number(seg.duration_minutes || 0), 0);
    return `${i + 1}. ${date}${menu}${minutes ? ` / ${minutes}分` : ""}`;
  }));
  return `今後の予約はこちらです。\n${lines.join("\n")}`;
}

async function formatPastBookings(bookings) {
  if (!bookings.length) return "確認できる過去の来店履歴はありません。";
  const lines = await Promise.all(bookings.map(async (b, i) => {
    const date = formatTokyoDate(b.start_at);
    const segments = b.appointment_segments || [];
    const menuNames = (await Promise.all(segments.map(getServiceName))).filter(Boolean);
    const menu = menuNames.length ? ` / ${menuNames.join("・")}` : "";
    const minutes = segments.reduce((s, seg) => s + Number(seg.duration_minutes || 0), 0);
    return `${i + 1}. ${date}${menu}${minutes ? ` / ${minutes}分` : ""}`;
  }));
  return `これまでの来店履歴はこちらです。\n${lines.join("\n")}`;
}

async function getServiceName(segment) {
  const id = segment.service_variation_id;
  if (!id) return "";
  if (serviceNameCache.has(id)) return serviceNameCache.get(id);
  try {
    const result = await squareRequest(`/v2/catalog/object/${encodeURIComponent(id)}`, { method: "GET" });
    const name = catalogObjectName(result.object, result.related_objects || []);
    serviceNameCache.set(id, name);
    return name;
  } catch (e) {
    serviceNameCache.set(id, "");
    return "";
  }
}

function catalogObjectName(object, relatedObjects) {
  const variationName = object?.item_variation_data?.name || "";
  const itemId = object?.item_variation_data?.item_id || "";
  const item = relatedObjects.find((r) => r.id === itemId);
  const itemName = item?.item_data?.name || "";
  if (itemName && variationName && itemName !== variationName) return `${itemName} ${variationName}`;
  return itemName || variationName || "";
}

function formatTokyoDate(value) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric", month: "numeric", day: "numeric",
    weekday: "short", hour: "2-digit", minute: "2-digit",
  }).format(new Date(value));
}

async function squareRequest(endpoint, options) {
  if (!config.squareAccessToken) throw new Error("SQUARE_ACCESS_TOKEN is not set");
  const response = await fetch(`${config.squareBaseUrl}${endpoint}`, {
    method: options.method,
    headers: {
      Authorization: `Bearer ${config.squareAccessToken}`,
      "Square-Version": config.squareVersion,
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const detail = data.errors?.map((e) => e.detail || e.code).join(", ") || response.statusText;
    throw new Error(`Square API error: ${detail}`);
  }
  return data;
}

async function replyText(replyToken, text) {
  if (!config.lineChannelAccessToken) {
    console.log("LINE reply skipped:", text);
    return;
  }
  const response = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.lineChannelAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text }] }),
  });
  if (!response.ok) throw new Error(`LINE reply failed: ${response.status} ${await response.text()}`);
}

async function pushText(userId, text) {
  if (!config.lineChannelAccessToken) {
    console.log("LINE push skipped:", text);
    return;
  }
  const response = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.lineChannelAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ to: userId, messages: [{ type: "text", text }] }),
  });
  if (!response.ok) throw new Error(`LINE push failed: ${response.status} ${await response.text()}`);
}

function verifyLineSignature(rawBody, signature) {
  if (!config.lineChannelSecret || !signature) return false;
  const digest = crypto.createHmac("sha256", config.lineChannelSecret).update(rawBody).digest("base64");
  if (Buffer.byteLength(digest) !== Buffer.byteLength(signature)) return false;
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
}

function normalizeText(value) { return value.normalize("NFKC").replace(/\s/g, "").toLowerCase(); }
function normalizePhone(value) { return value.replace(/\D/g, ""); }

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function loadDotEnv(filePath) {
  if (!fsSync.existsSync(filePath)) return;
  const content = fsSync.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}
