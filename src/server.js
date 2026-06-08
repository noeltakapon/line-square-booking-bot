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

    if (req.method === "GET" && req.url === "/calendar") {
      return serveCalendar(res);
    }

    if (req.method === "GET" && req.url.startsWith("/api/availability")) {
      return serveAvailability(req, res);
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
  const match = text.match(/^(.+?)[\s　,、]*(\d{4})$/);
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

// ============================================================
// カレンダー機能（既存コードには手を加えていません）
// ============================================================

const CALENDAR_LOCATION_ID = "LQ2HAT073YS1N";
const CALENDAR_STAFF = {
  takeshi: { id: "TM4KBBvc9KKU5Auf", name: "二瓶 武士" },
  naoko:   { id: "TMyoTzCPU06PeMxI",  name: "NAOKO" }
};
const CALENDAR_OPEN_HOUR  = 10;
const CALENDAR_CLOSE_HOUR = 19;
const CALENDAR_CLOSED_DOW = 2; // 火曜定休

function serveCalendar(res) {
  const html = buildCalendarHtml();
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

async function serveAvailability(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    const staffKey  = url.searchParams.get("staff");
    const startDate = url.searchParams.get("start");
    const endDate   = url.searchParams.get("end");

    if (!staffKey || !CALENDAR_STAFF[staffKey]) {
      return sendJson(res, 400, { error: "invalid staff" });
    }
    if (!startDate || !endDate) {
      return sendJson(res, 400, { error: "start and end required" });
    }

    const teamMemberId = CALENDAR_STAFF[staffKey].id;

    const body = {
      query: {
        filter: {
          start_at_range: {
            start_at: new Date(`${startDate}T${String(CALENDAR_OPEN_HOUR).padStart(2, "0")}:00:00+09:00`).toISOString(),
            end_at:   new Date(`${endDate}T${String(CALENDAR_CLOSE_HOUR).padStart(2, "0")}:00:00+09:00`).toISOString()
          },
          location_id: CALENDAR_LOCATION_ID,
          segment_filters: [
            {
              team_member_id_filter: { any: [teamMemberId] }
            }
          ]
        }
      }
    };

    const result = await squareRequest("/v2/bookings/availability/search", {
      method: "POST",
      body
    });

    const slots = buildHourlySlots(startDate, endDate, result.availabilities || []);
    sendJson(res, 200, { slots });

  } catch (err) {
    console.error("availability error:", err);
    sendJson(res, 500, { error: err.message });
  }
}

function buildHourlySlots(startDate, endDate, availabilities) {
  const openSet = new Set(
    availabilities.map(a => {
      const jst = new Date(new Date(a.start_at).getTime() + 9 * 60 * 60 * 1000);
      const dateStr = jst.toISOString().slice(0, 10);
      const hour    = jst.getUTCHours();
      return `${dateStr}:${hour}`;
    })
  );

  const result = {};
  const cur = new Date(`${startDate}T00:00:00+09:00`);
  const end = new Date(`${endDate}T00:00:00+09:00`);
  end.setDate(end.getDate() + 1);

  while (cur < end) {
    const jst     = new Date(cur.getTime() + 9 * 60 * 60 * 1000);
    const dateStr = jst.toISOString().slice(0, 10);
    const dow     = cur.getDay();
    const isClosed = dow === CALENDAR_CLOSED_DOW;

    if (!result[dateStr]) result[dateStr] = {};

    for (let h = CALENDAR_OPEN_HOUR; h < CALENDAR_CLOSE_HOUR; h++) {
      result[dateStr][h] = isClosed ? "holiday" : openSet.has(`${dateStr}:${h}`) ? "open" : "closed";
    }

    cur.setDate(cur.getDate() + 1);
  }

  return result;
}

function buildCalendarHtml() {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Noëlhair | ご予約</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;1,300&family=Noto+Sans+JP:wght@300;400&display=swap" rel="stylesheet">
<style>
  :root{--tiffany:#81D8D0;--tiffany-light:#b2ece8;--tiffany-dark:#5bbfb7;--bg:#f7fafa;--white:#ffffff;--ink:#1a2625;--ink-muted:#6b8280;}
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:'Noto Sans JP',sans-serif;background:var(--bg);color:var(--ink);min-height:100vh;}
  .header{background:var(--white);padding:16px 20px 12px;border-bottom:1px solid rgba(129,216,208,0.2);position:sticky;top:0;z-index:30;}
  .header-inner{max-width:600px;margin:0 auto;}
  .salon-name{font-family:'Cormorant Garamond',serif;font-size:21px;font-weight:300;letter-spacing:0.12em;}
  .salon-name span{color:var(--tiffany-dark);font-style:italic;}
  .subtitle{font-size:10px;color:var(--ink-muted);letter-spacing:0.08em;margin-top:2px;}
  .tabs-wrap{background:var(--white);border-bottom:2px solid rgba(129,216,208,0.2);position:sticky;top:58px;z-index:20;}
  .tabs{max-width:600px;margin:0 auto;display:flex;}
  .tab{flex:1;padding:14px 8px 12px;text-align:center;cursor:pointer;font-size:12px;color:var(--ink-muted);border-bottom:2px solid transparent;margin-bottom:-2px;transition:all 0.2s;}
  .tab.active{color:var(--tiffany-dark);border-bottom-color:var(--tiffany-dark);}
  .tab-name-jp{font-size:13px;font-weight:400;}
  .tab-name-en{font-size:9px;letter-spacing:0.08em;margin-top:1px;opacity:0.7;}
  .tab-role{font-size:9px;color:var(--tiffany-dark);opacity:0;}
  .tab.active .tab-role{opacity:1;}
  .main{max-width:600px;margin:0 auto;padding:14px 16px 40px;}
  .week-nav{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;}
  .week-label{font-family:'Cormorant Garamond',serif;font-size:16px;font-weight:300;letter-spacing:0.05em;}
  .nav-btn{width:28px;height:28px;border-radius:50%;border:1px solid var(--tiffany-light);background:transparent;color:var(--tiffany-dark);cursor:pointer;font-size:13px;display:flex;align-items:center;justify-content:center;transition:all 0.2s;}
  .nav-btn:hover{background:var(--tiffany);color:white;}
  .grid-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;border-radius:8px;border:1px solid rgba(129,216,208,0.2);}
  .grid-table{border-collapse:collapse;width:100%;font-size:11px;}
  .grid-table th{background:var(--white);font-weight:300;padding:7px 4px;text-align:center;border:1px solid rgba(129,216,208,0.15);white-space:nowrap;min-width:42px;}
  .grid-table th.time-col{min-width:42px;font-size:10px;color:var(--ink-muted);}
  .grid-table th.sun{color:#e08080;}.grid-table th.sat{color:#6080d0;}.grid-table th.today-h{background:rgba(129,216,208,0.08);}
  .grid-table th .dnum{font-size:14px;line-height:1.2;}.grid-table th .dname{font-size:9px;opacity:0.7;}
  .grid-table td{border:1px solid rgba(129,216,208,0.12);text-align:center;height:38px;min-width:42px;transition:background 0.12s;}
  .grid-table td.time-cell{font-size:10px;color:var(--ink-muted);background:var(--white);padding:0 5px;white-space:nowrap;}
  .grid-table td.c-closed{background:#f0f0f0;}.grid-table td.c-holiday{background:#faf0f0;}.grid-table td.c-open{background:rgba(129,216,208,0.15);cursor:pointer;}.grid-table td.c-open:hover{background:rgba(129,216,208,0.38);}.grid-table td.c-selected{background:var(--tiffany)!important;}
  .cell-in{display:flex;align-items:center;justify-content:center;height:100%;font-size:13px;}
  .c-open .cell-in{color:var(--tiffany-dark);}.c-closed .cell-in{color:#ccc;font-size:11px;}.c-holiday .cell-in{color:#dbb;font-size:10px;}.c-selected .cell-in{color:white;font-weight:400;}
  .loading{text-align:center;padding:20px;color:var(--ink-muted);font-size:12px;}
  .legend{display:flex;gap:14px;flex-wrap:wrap;margin:10px 0 16px;}
  .legend-item{display:flex;align-items:center;gap:5px;font-size:10px;color:var(--ink-muted);}
  .legend-box{width:13px;height:13px;border-radius:3px;}
  .lb-open{background:rgba(129,216,208,0.25);border:1px solid rgba(129,216,208,0.5);}.lb-closed{background:#f0f0f0;border:1px solid #ddd;}.lb-holiday{background:#faf0f0;border:1px solid #f0d0d0;}
  .menu-panel{background:var(--white);border:1.5px solid rgba(129,216,208,0.3);border-radius:12px;padding:16px;margin-top:4px;display:none;animation:fadeUp 0.25s ease;}
  .menu-panel.visible{display:block;}
  @keyframes fadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
  .menu-panel-header{font-family:'Cormorant Garamond',serif;font-size:15px;font-weight:300;letter-spacing:0.05em;margin-bottom:4px;}
  .menu-panel-sub{font-size:10px;color:var(--ink-muted);margin-bottom:12px;}
  .menu-list{display:flex;flex-direction:column;gap:7px;margin-bottom:14px;}
  .menu-item{border:1.5px solid rgba(129,216,208,0.22);border-radius:9px;background:var(--bg);padding:10px 12px;cursor:pointer;transition:all 0.18s;display:flex;align-items:center;justify-content:space-between;}
  .menu-item:hover{border-color:var(--tiffany);background:rgba(129,216,208,0.06);}
  .menu-item.selected{border-color:var(--tiffany-dark);background:rgba(129,216,208,0.12);}
  .menu-item-name{font-size:12px;font-weight:300;line-height:1.4;}.menu-item-cat{font-size:10px;color:var(--ink-muted);margin-top:1px;}
  .menu-item-right{display:flex;flex-direction:column;align-items:flex-end;gap:3px;flex-shrink:0;margin-left:8px;}
  .menu-item-price{font-size:11px;white-space:nowrap;}.menu-item-time{font-size:10px;color:var(--tiffany-dark);background:rgba(129,216,208,0.15);border-radius:4px;padding:2px 6px;white-space:nowrap;}
  .menu-unavail{opacity:0.35;cursor:not-allowed;}.menu-unavail:hover{border-color:rgba(129,216,208,0.22)!important;background:var(--bg)!important;}
  .confirm-block{border-top:1px solid rgba(129,216,208,0.2);padding-top:12px;display:none;}
  .confirm-block.visible{display:block;}
  .confirm-rows{display:flex;flex-direction:column;gap:6px;margin-bottom:14px;}
  .confirm-row{display:flex;justify-content:space-between;font-size:12px;}
  .confirm-label{color:var(--ink-muted);}
  .book-cta{background:var(--tiffany-dark);color:white;border:none;border-radius:10px;padding:13px;width:100%;font-family:'Noto Sans JP',sans-serif;font-size:13px;letter-spacing:0.08em;cursor:pointer;transition:all 0.2s;display:flex;align-items:center;justify-content:center;gap:6px;}
  .book-cta:hover{background:var(--tiffany);box-shadow:0 4px 14px rgba(129,216,208,0.35);}
  .book-cta-note{font-size:10px;color:var(--ink-muted);text-align:center;margin-top:6px;}
  .clear-btn{display:block;width:100%;background:transparent;border:1px solid rgba(129,216,208,0.3);color:var(--ink-muted);border-radius:8px;padding:8px;font-size:11px;cursor:pointer;margin-top:8px;transition:all 0.2s;text-align:center;}
  .clear-btn:hover{border-color:var(--tiffany);color:var(--tiffany-dark);}
</style>
</head>
<body>
<div class="header"><div class="header-inner">
  <div class="salon-name">Noël<span>hair</span></div>
  <div class="subtitle">空き状況 · AVAILABILITY</div>
</div></div>
<div class="tabs-wrap"><div class="tabs">
  <div class="tab active" id="tab-takeshi" onclick="switchStaff('takeshi')">
    <div class="tab-name-jp">二瓶 武士</div><div class="tab-name-en">TAKESHI NIHEI</div><div class="tab-role">Owner Stylist</div>
  </div>
  <div class="tab" id="tab-naoko" onclick="switchStaff('naoko')">
    <div class="tab-name-jp">NAOKO</div><div class="tab-name-en">NAOKO</div><div class="tab-role">Stylist</div>
  </div>
</div></div>
<div class="main">
  <div class="week-nav">
    <button class="nav-btn" onclick="changeWeek(-1)">‹</button>
    <div class="week-label" id="weekLabel"></div>
    <button class="nav-btn" onclick="changeWeek(1)">›</button>
  </div>
  <div class="grid-wrap"><table class="grid-table" id="gridTable"><tbody><tr><td class="loading" colspan="8">読み込み中...</td></tr></tbody></table></div>
  <div class="legend">
    <div class="legend-item"><div class="legend-box lb-open"></div>空きあり</div>
    <div class="legend-item"><div class="legend-box lb-closed"></div>満席</div>
    <div class="legend-item"><div class="legend-box lb-holiday"></div>定休 / 休み</div>
  </div>
  <div class="menu-panel" id="menuPanel">
    <div class="menu-panel-header" id="menuPanelHeader"></div>
    <div class="menu-panel-sub" id="menuPanelSub"></div>
    <div class="menu-list" id="menuList"></div>
    <div class="confirm-block" id="confirmBlock">
      <div class="confirm-rows" id="confirmRows"></div>
      <button class="book-cta" id="bookBtn">この内容で予約する →</button>
      <div class="book-cta-note">Squareの予約ページに移動します</div>
    </div>
    <button class="clear-btn" onclick="clearSelection()">← 日時を選び直す</button>
  </div>
</div>
<script>
const MENUS=[
  {id:'cut_mens',name:'メンズカット（カット＋シャンプー＋ブロー）',cat:'メンズ',duration:60,price:'¥2,000〜¥6,800'},
  {id:'recharge',name:'『リチャージ』カット＋シャンプー＋顔剃り＋炭酸パック＋ブロー',cat:'メンズプレミアム',duration:60,price:'¥4,700'},
  {id:'royal',name:'『ロイヤルリブート』頭皮から顔までの最上級カットコース',cat:'メンズプレミアム',duration:60,price:'¥7,800'},
  {id:'detox',name:'『THE 頭皮洗浄 –DEEP DETOX–』',cat:'メンズプレミアム',duration:60,price:'¥6,800'},
  {id:'color_only',name:'カラーのみ',cat:'カラー',duration:120,price:'¥5,500〜¥7,000'},
  {id:'herb_color',name:'カット＆香草カラー',cat:'メンズ',duration:120,price:'¥9,600'},
  {id:'silky',name:'シルキーコートプレミアムカラー（カット＆カラー＆シルキーコート）',cat:'レディースプレミアム',duration:120,price:'¥11,100〜¥14,000'},
  {id:'cut_color_mens',name:'メンズカット＆カラー',cat:'メンズ',duration:180,price:'¥8,600〜¥15,000'},
  {id:'cut_color_perm',name:'メンズカット＆カラー＆パーマ',cat:'メンズ',duration:180,price:'¥12,600〜¥13,700'},
  {id:'mesh',name:'メンズ限定 カット＆ホワイトメッシュ',cat:'メンズ',duration:180,price:'¥16,000'},
];
const OPEN_HOUR=10,CLOSE_HOUR=19;
const today=new Date();today.setHours(0,0,0,0);
let currentStaff='takeshi',weekOffset=0,selectedSlot=null,selectedMenu=null,slotsCache={};

function switchStaff(s){
  currentStaff=s;
  document.getElementById('tab-takeshi').classList.toggle('active',s==='takeshi');
  document.getElementById('tab-naoko').classList.toggle('active',s==='naoko');
  clearSelection();loadAndRender();
}
function getWeekDates(){
  const d=new Date(today);
  const dow=d.getDay()===0?6:d.getDay()-1;
  d.setDate(d.getDate()-dow+weekOffset*7);
  return Array.from({length:7},(_,i)=>{const x=new Date(d);x.setDate(d.getDate()+i);return x;});
}
function fmt(d){return d.toISOString().slice(0,10);}
async function loadAndRender(){
  const days=getWeekDates();
  const start=fmt(days[0]),end=fmt(days[6]);
  const cacheKey=currentStaff+start;
  document.getElementById('gridTable').innerHTML='<tbody><tr><td class="loading" colspan="8">読み込み中...</td></tr></tbody>';
  if(!slotsCache[cacheKey]){
    try{
      const r=await fetch('/api/availability?staff='+currentStaff+'&start='+start+'&end='+end);
      const data=await r.json();
      slotsCache[cacheKey]=data.slots||{};
    }catch(e){slotsCache[cacheKey]={};}
  }
  renderGrid(days,slotsCache[cacheKey]);
}
function renderGrid(days,slots){
  const dayNames=['日','月','火','水','木','金','土'];
  let html='<thead><tr><th class="time-col"></th>';
  days.forEach(d=>{
    const dow=d.getDay();
    const isToday=d.getTime()===today.getTime();
    const cls=(dow===0?'sun':dow===6?'sat':'')+(isToday?' today-h':'');
    html+=\`<th class="\${cls}"><div class="dnum">\${d.getDate()}</div><div class="dname">\${dayNames[dow]}</div></th>\`;
  });
  html+='</tr></thead><tbody>';
  for(let h=OPEN_HOUR;h<CLOSE_HOUR;h++){
    html+=\`<tr><td class="time-cell">\${String(h).padStart(2,'0')}:00</td>\`;
    days.forEach(d=>{
      const ds=fmt(d);
      const isPast=d<today||(d.getTime()===today.getTime()&&h<new Date().getHours());
      const isSelected=selectedSlot&&selectedSlot.ds===ds&&selectedSlot.hour===h;
      const status=isPast?'closed':(slots[ds]&&slots[ds][h])||'closed';
      let cls=status==='open'?'c-open':status==='holiday'?'c-holiday':'c-closed';
      if(isSelected)cls='c-selected';
      const icon=status==='open'?'○':status==='holiday'?'休':'×';
      const onclick=status==='open'&&!isPast?\`onclick="selectSlot('\${ds}',\${h})"\`:'';
      html+=\`<td class="\${cls}" \${onclick}><div class="cell-in">\${icon}</div></td>\`;
    });
    html+='</tr>';
  }
  html+='</tbody>';
  document.getElementById('gridTable').innerHTML=html;
}
function selectSlot(ds,hour){
  let avail=0;
  const daySlots=Object.values(slotsCache).find(s=>s[ds]);
  if(daySlots&&daySlots[ds]){
    for(let h=hour;h<CLOSE_HOUR;h++){
      if(daySlots[ds][h]==='open')avail++;else break;
    }
  }else{avail=1;}
  selectedSlot={ds,hour,avail};
  selectedMenu=null;
  const days=getWeekDates();
  renderGrid(days,slotsCache[currentStaff+fmt(days[0])]||{});
  showMenuPanel(ds,hour,avail);
}
function showMenuPanel(ds,hour,avail){
  const d=new Date(ds);
  const months=['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
  const dayNames=['日','月','火','水','木','金','土'];
  document.getElementById('menuPanelHeader').textContent=months[d.getMonth()]+' '+d.getDate()+'日（'+dayNames[d.getDay()]+'） '+String(hour).padStart(2,'0')+':00〜';
  document.getElementById('menuPanelSub').textContent='この時間から'+avail+'時間分空いています。入れるメニューを選んでください。';
  renderMenuList(avail);
  document.getElementById('confirmBlock').className='confirm-block';
  document.getElementById('menuPanel').className='menu-panel visible';
  document.getElementById('menuPanel').scrollIntoView({behavior:'smooth',block:'nearest'});
}
function renderMenuList(avail){
  const maxMins=avail*60;
  document.getElementById('menuList').innerHTML=MENUS.map(m=>{
    const fits=m.duration<=maxMins;
    return '<div class="menu-item'+(selectedMenu&&selectedMenu.id===m.id?' selected':'')+(fits?'':' menu-unavail')+'"'+(fits?' onclick="selectMenu(\''+m.id+'\')"':'')+'>'+
      '<div><div class="menu-item-name">'+m.name+'</div><div class="menu-item-cat">'+m.cat+'</div></div>'+
      '<div class="menu-item-right"><div class="menu-item-price">'+m.price+'</div><div class="menu-item-time">⏱ '+fmtDur(m.duration)+'</div></div>'+
    '</div>';
  }).join('');
}
function selectMenu(id){
  selectedMenu=MENUS.find(m=>m.id===id);
  renderMenuList(selectedSlot.avail);
  const d=new Date(selectedSlot.ds);
  const months=['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
  const dayNames=['日','月','火','水','木','金','土'];
  const endH=selectedSlot.hour+selectedMenu.duration/60;
  document.getElementById('confirmRows').innerHTML=
    '<div class="confirm-row"><span class="confirm-label">担当</span><span>'+(currentStaff==='takeshi'?'二瓶 武士':'NAOKO')+'</span></div>'+
    '<div class="confirm-row"><span class="confirm-label">日付</span><span>'+months[d.getMonth()]+' '+d.getDate()+'日（'+dayNames[d.getDay()]+'）</span></div>'+
    '<div class="confirm-row"><span class="confirm-label">時間</span><span>'+String(selectedSlot.hour).padStart(2,'0')+':00 〜 '+String(endH).padStart(2,'0')+':00</span></div>'+
    '<div class="confirm-row"><span class="confirm-label">メニュー</span><span>'+selectedMenu.name+'</span></div>'+
    '<div class="confirm-row"><span class="confirm-label">料金</span><span>'+selectedMenu.price+'</span></div>';
  document.getElementById('confirmBlock').className='confirm-block visible';
  document.getElementById('confirmBlock').scrollIntoView({behavior:'smooth',block:'nearest'});
}
function fmtDur(m){const h=Math.floor(m/60),r=m%60;return h+'時間'+(r?r+'分':'');}
function clearSelection(){
  selectedSlot=null;selectedMenu=null;
  document.getElementById('menuPanel').className='menu-panel';
  const days=getWeekDates();
  renderGrid(days,slotsCache[currentStaff+fmt(days[0])]||{});
}
function changeWeek(d){weekOffset+=d;clearSelection();loadAndRender();}
loadAndRender();
<\/script>
</body></html>`;
}
