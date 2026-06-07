import http from "node:http";
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  linksFile: path.resolve(__dirname, "..", process.env.LINKS_FILE || "./data/links.json"),
  redisUrl: process.env.UPSTASH_REDIS_REST_URL || "",
  redisToken: process.env.UPSTASH_REDIS_REST_TOKEN || "",
  linkKeyPrefix: process.env.LINK_KEY_PREFIX || "line-square-booking"
};
const serviceNameCache = new Map();

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && req.url === "/webhook") {
      const rawBody = await readBody(req);
      console.log(`Webhook received: ${rawBody.length} bytes`);
      if (!verifyLineSignature(rawBody, req.headers["x-line-signature"])) {
        console.warn("Webhook rejected: invalid LINE signature");
        return sendJson(res, 401, { error: "invalid LINE signature" });
      }

      const payload = JSON.parse(rawBody.toString("utf8"));
      console.log(`Webhook accepted: ${payload.events?.length || 0} event(s)`);
      for (const event of payload.events || []) {
        handleLineEventSafely(event);
      }
      return sendJson(res, 200, { ok: true });
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
  if (event.type !== "message" || event.message?.type !== "text" || !event.replyToken) {
    return;
  }

  const lineUserId = event.source?.userId;
  const text = event.message.text.trim();
  console.log(`LINE message received: user=${maskId(lineUserId || "")} text=${text}`);
  if (!lineUserId) {
    return replyText(event.replyToken, "個別チャットでご利用ください。");
  }

  if (isResetCommand(text)) {
    await unlinkLineUser(lineUserId);
    return replyText(event.replyToken, "登録を解除しました。もう一度「予約確認」と送ると再登録できます。");
  }

  if (isBookingCommand(text)) {
    const linkedCustomerId = await getLinkedCustomerId(lineUserId);
    if (!linkedCustomerId) {
      await markVerificationPending(lineUserId, "booking");
      return replyText(
        event.replyToken,
        "予約確認ですね。初回だけ本人確認をします。\nお名前と電話番号の下4桁を送ってください。\n例: 山田花子 1234"
      );
    }

    await replyText(event.replyToken, "予約情報を確認しています。少しだけお待ちください。");
    sendUpcomingBookings(lineUserId, linkedCustomerId);
    return;
  }

  if (isVisitHistoryCommand(text)) {
    const linkedCustomerId = await getLinkedCustomerId(lineUserId);
    if (!linkedCustomerId) {
      await markVerificationPending(lineUserId, "history");
      return replyText(
        event.replyToken,
        "来店履歴ですね。初回だけ本人確認をします。\nお名前と電話番号の下4桁を送ってください。\n例: 山田花子 1234"
      );
    }

    await replyText(event.replyToken, "来店履歴を確認しています。少しだけお待ちください。");
    sendPastBookings(lineUserId, linkedCustomerId);
    return;
  }

  const pendingAction = await getVerificationPendingAction(lineUserId);
  if (!pendingAction) {
    return;
  }

  const identity = parseIdentity(text);
  if (!identity) {
    return;
  }

  const matchedCustomer = await findCustomerByNameAndPhoneSuffix(identity.name, identity.phoneSuffix);
  if (!matchedCustomer) {
    return replyText(
      event.replyToken,
      "該当するお客様情報が見つかりませんでした。お名前の表記と電話番号下4桁を確認して、もう一度送ってください。"
    );
  }

  await linkLineUser(lineUserId, matchedCustomer.id);
  if (pendingAction === "history") {
    await replyText(event.replyToken, "本人確認ができました。来店履歴を確認しています。少しだけお待ちください。");
    sendPastBookings(lineUserId, matchedCustomer.id);
    return;
  }

  await replyText(event.replyToken, "本人確認ができました。予約情報を確認しています。少しだけお待ちください。");
  sendUpcomingBookings(lineUserId, matchedCustomer.id);
}

async function sendUpcomingBookings(lineUserId, customerId) {
  try {
    const bookings = await listUpcomingBookings(customerId);
    await pushText(lineUserId, await formatBookings(bookings));
  } catch (error) {
    console.error("Failed to send upcoming bookings:", error);
    await pushText(lineUserId, "予約情報の確認中にエラーが出ました。少し時間をおいて、もう一度「予約確認」と送ってください。");
  }
}

async function sendPastBookings(lineUserId, customerId) {
  try {
    const bookings = await listPastBookings(customerId);
    await pushText(lineUserId, await formatPastBookings(bookings));
  } catch (error) {
    console.error("Failed to send past bookings:", error);
    await pushText(lineUserId, "来店履歴の確認中にエラーが出ました。少し時間をおいて、もう一度「来店履歴」と送ってください。");
  }
}

async function handleLineEventSafely(event) {
  try {
    await handleLineEvent(event);
  } catch (error) {
    console.error("LINE event handling failed:", error);
    if (event.replyToken) {
      await replyText(
        event.replyToken,
        "予約情報の確認中にエラーが出ました。少し時間をおいて、もう一度「予約確認」と送ってください。"
      ).catch((replyError) => console.error("Fallback reply failed:", replyError));
    }
  }
}

function isBookingCommand(text) {
  return text.replace(/\s/g, "") === "予約確認";
}

function isVisitHistoryCommand(text) {
  return text.replace(/\s/g, "") === "来店履歴";
}

function isResetCommand(text) {
  return ["解除", "登録解除", "リセット"].includes(text.replace(/\s/g, ""));
}

function parseIdentity(text) {
  const match = text.match(/^(.+?)[\s　,、]+(\d{4})$/);
  if (!match) return null;
  return {
    name: normalizeText(match[1]),
    phoneSuffix: match[2]
  };
}

async function findCustomerByNameAndPhoneSuffix(name, phoneSuffix) {
  let cursor;
  for (let page = 0; page < 10; page += 1) {
    const params = new URLSearchParams({ limit: "100" });
    if (cursor) params.set("cursor", cursor);
    const result = await squareRequest(`/v2/customers?${params.toString()}`, { method: "GET" });

    const match = (result.customers || []).find((customer) => {
      const names = customerNameCandidates(customer);
      const phone = normalizePhone(customer.phone_number || "");
      return phone.endsWith(phoneSuffix) && names.some((candidate) => namesMatch(candidate, name));
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
    customer.reference_id || ""
  ].map(normalizeText).filter(Boolean);
}

function namesMatch(candidate, input) {
  return candidate === input || candidate.includes(input) || input.includes(candidate);
}

async function listUpcomingBookings(customerId) {
  const now = new Date();
  const daysAhead = Math.min(config.searchDaysAhead, 30);
  const max = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
  const bookings = await listBookingsInRange(customerId, now, max, 20);

  return bookings
    .filter((booking) => ["ACCEPTED", "PENDING"].includes(booking.status))
    .sort((a, b) => new Date(a.start_at) - new Date(b.start_at));
}

async function listPastBookings(customerId) {
  const results = [];
  const now = new Date();
  let rangeEnd = now;

  for (let chunk = 0; chunk < 12 && results.length < 5; chunk += 1) {
    const rangeStart = new Date(rangeEnd.getTime() - 30 * 24 * 60 * 60 * 1000);
    const bookings = await listBookingsInRange(customerId, rangeStart, rangeEnd, 20);
    results.push(
      ...bookings.filter((booking) =>
        new Date(booking.start_at) < now && !["CANCELLED_BY_CUSTOMER", "CANCELLED_BY_SELLER", "DECLINED"].includes(booking.status)
      )
    );
    rangeEnd = rangeStart;
  }

  return results
    .sort((a, b) => new Date(b.start_at) - new Date(a.start_at))
    .slice(0, 5);
}

async function listBookingsInRange(customerId, start, end, limit) {
  const params = new URLSearchParams({
    customer_id: customerId,
    start_at_min: start.toISOString(),
    start_at_max: end.toISOString(),
    limit: String(limit)
  });

  const result = await squareRequest(`/v2/bookings?${params.toString()}`, {
    method: "GET"
  });

  return result.bookings || [];
}

async function formatBookings(bookings) {
  if (!bookings.length) {
    return "現在、確認できる今後の予約はありません。";
  }

  const lines = await Promise.all(bookings.slice(0, 5).map(async (booking, index) => {
    const date = formatTokyoDate(booking.start_at);
    const segments = booking.appointment_segments || [];
    const menuNames = (await Promise.all(segments.map(getServiceName))).filter(Boolean);
    const menu = menuNames.length ? ` / ${menuNames.join("・")}` : "";
    const minutes = segments.reduce(
      (sum, segment) => sum + Number(segment.duration_minutes || 0),
      0
    );
    const duration = minutes ? ` / ${minutes}分` : "";
    return `${index + 1}. ${date}${menu}${duration}`;
  }));

  return `今後の予約はこちらです。\n${lines.join("\n")}`;
}

async function formatPastBookings(bookings) {
  if (!bookings.length) {
    return "確認できる過去の来店履歴はありません。";
  }

  const lines = await Promise.all(bookings.map(async (booking, index) => {
    const date = formatTokyoDate(booking.start_at);
    const segments = booking.appointment_segments || [];
    const menuNames = (await Promise.all(segments.map(getServiceName))).filter(Boolean);
    const menu = menuNames.length ? ` / ${menuNames.join("・")}` : "";
    const minutes = segments.reduce(
      (sum, segment) => sum + Number(segment.duration_minutes || 0),
      0
    );
    const duration = minutes ? ` / ${minutes}分` : "";
    return `${index + 1}. ${date}${menu}${duration}`;
  }));

  return `これまでの来店履歴はこちらです。\n${lines.join("\n")}`;
}

async function getServiceName(segment) {
  const serviceVariationId = segment.service_variation_id;
  if (!serviceVariationId) return "";
  if (serviceNameCache.has(serviceVariationId)) return serviceNameCache.get(serviceVariationId);

  try {
    const result = await squareRequest(`/v2/catalog/object/${encodeURIComponent(serviceVariationId)}`, {
      method: "GET"
    });
    const name = catalogObjectName(result.object, result.related_objects || []);
    serviceNameCache.set(serviceVariationId, name);
    return name;
  } catch (error) {
    console.error("Failed to load service name:", error);
    serviceNameCache.set(serviceVariationId, "");
    return "";
  }
}

function catalogObjectName(object, relatedObjects) {
  const variationName = object?.item_variation_data?.name || "";
  const itemId = object?.item_variation_data?.item_id || "";
  const item = relatedObjects.find((related) => related.id === itemId);
  const itemName = item?.item_data?.name || "";

  if (itemName && variationName && itemName !== variationName) {
    return `${itemName} ${variationName}`;
  }
  return itemName || variationName || "";
}

function formatTokyoDate(value) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

async function squareRequest(endpoint, options) {
  if (!config.squareAccessToken) {
    throw new Error("SQUARE_ACCESS_TOKEN is not set");
  }

  const response = await fetch(`${config.squareBaseUrl}${endpoint}`, {
    method: options.method,
    headers: {
      "Authorization": `Bearer ${config.squareAccessToken}`,
      "Square-Version": config.squareVersion,
      "Content-Type": "application/json"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const detail = data.errors?.map((error) => error.detail || error.code).join(", ") || response.statusText;
    throw new Error(`Square API error: ${detail}`);
  }
  return data;
}

async function replyText(replyToken, text) {
  if (!config.lineChannelAccessToken) {
    console.log("LINE reply skipped because LINE_CHANNEL_ACCESS_TOKEN is not set:", text);
    return;
  }

  const response = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.lineChannelAccessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }]
    })
  });

  if (!response.ok) {
    throw new Error(`LINE reply failed: ${response.status} ${await response.text()}`);
  }
}

async function pushText(lineUserId, text) {
  if (!config.lineChannelAccessToken) {
    console.log("LINE push skipped because LINE_CHANNEL_ACCESS_TOKEN is not set:", text);
    return;
  }

  const response = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.lineChannelAccessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      to: lineUserId,
      messages: [{ type: "text", text }]
    })
  });

  if (!response.ok) {
    throw new Error(`LINE push failed: ${response.status} ${await response.text()}`);
  }
}

function verifyLineSignature(rawBody, signature) {
  if (!config.lineChannelSecret || !signature) return false;
  const digest = crypto
    .createHmac("sha256", config.lineChannelSecret)
    .update(rawBody)
    .digest("base64");
  if (Buffer.byteLength(digest) !== Buffer.byteLength(signature)) return false;
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
}

async function getLinkedCustomerId(lineUserId) {
  const link = await readLink(lineUserId);
  return link?.squareCustomerId || null;
}

async function linkLineUser(lineUserId, squareCustomerId) {
  await writeLink(lineUserId, {
    squareCustomerId,
    verificationPending: false,
    pendingAction: null,
    linkedAt: new Date().toISOString()
  });
}

async function markVerificationPending(lineUserId, action) {
  const current = await readLink(lineUserId);
  await writeLink(lineUserId, {
    ...current,
    verificationPending: true,
    pendingAction: action,
    verificationRequestedAt: new Date().toISOString()
  });
}

async function getVerificationPendingAction(lineUserId) {
  const link = await readLink(lineUserId);
  if (link?.verificationPending !== true) return null;
  return link?.pendingAction || "booking";
}

async function unlinkLineUser(lineUserId) {
  await deleteLink(lineUserId);
}

async function readLink(lineUserId) {
  if (isRedisEnabled()) {
    const value = await redisCommand(["GET", linkKey(lineUserId)]);
    return value ? JSON.parse(value) : null;
  }

  const links = await readLinks();
  return links[lineUserId] || null;
}

async function writeLink(lineUserId, link) {
  if (isRedisEnabled()) {
    await redisCommand(["SET", linkKey(lineUserId), JSON.stringify(link)]);
    return;
  }

  const links = await readLinks();
  links[lineUserId] = link;
  await writeLinks(links);
}

async function deleteLink(lineUserId) {
  if (isRedisEnabled()) {
    await redisCommand(["DEL", linkKey(lineUserId)]);
    return;
  }

  const links = await readLinks();
  delete links[lineUserId];
  await writeLinks(links);
}

function isRedisEnabled() {
  return Boolean(config.redisUrl && config.redisToken);
}

function linkKey(lineUserId) {
  return `${config.linkKeyPrefix}:link:${lineUserId}`;
}

async function redisCommand(command) {
  const response = await fetch(config.redisUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.redisToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    throw new Error(`Redis error: ${data.error || response.statusText}`);
  }
  return data.result;
}

async function readLinks() {
  try {
    return JSON.parse(await fs.readFile(config.linksFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeLinks(links) {
  await fs.mkdir(path.dirname(config.linksFile), { recursive: true });
  await fs.writeFile(config.linksFile, `${JSON.stringify(links, null, 2)}\n`);
}

function normalizeText(value) {
  return value.normalize("NFKC").replace(/\s/g, "").toLowerCase();
}

function normalizePhone(value) {
  return value.replace(/\D/g, "");
}

function maskId(value) {
  if (!value) return "";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

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
