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

    if (req.method === "GET" && req.url === "/api/services") {
      return serveServices(res);
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

const CALENDAR_STAFF = {
  takeshi: {
    id: "TM4KBBvc9KKU5Auf",
    name: "二瓶 武士",
    serviceVariationId: "A23FMPXKLQ5C45K6Y5NXJYBG" // メンズカット60分
  },
  naoko: {
    id: "TMyoTzCPU06PeMxI",
    name: "NAOKO",
    serviceVariationId: "LUCUGMQKRAYIRYZQ2YTKRY42" // レディースカット60分
  }
};
const CALENDAR_LOCATION_ID = "LQ2HAT073YS1N";
const CALENDAR_OPEN_HOUR  = 9;
const CALENDAR_CLOSE_HOUR = 19;
// Square オンライン予約ページ
const SQUARE_BOOKING_URL = "https://squareup.com/appointments/book/LQ2HAT073YS1N";

function serveCalendar(res) {
  const html = buildCalendarHtml();
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

// サービス（メニュー）一覧とservice_variation_idを取得して、
// どのスタッフが担当しているかも併せて返す
async function serveServices(res) {
  try {
    // 1) カタログからAPPOINTMENTS_SERVICE（予約メニュー）を全部取得
    const catalog = await squareRequest("/v2/catalog/list?types=ITEM", { method: "GET" });
    const items = (catalog.objects || []).filter(
      (o) => o.item_data?.product_type === "APPOINTMENTS_SERVICE"
    );

    // 2) 各メニューのバリエーション（=予約に使うservice_variation_id）を展開
    const services = [];
    for (const item of items) {
      const itemName = item.item_data?.name || "";
      for (const v of item.item_data?.variations || []) {
        const vd = v.item_variation_data || {};
        // team_member_ids: そのバリエーションを担当できるスタッフ
        services.push({
          service_variation_id: v.id,
          name: itemName + (vd.name && vd.name !== itemName ? ` / ${vd.name}` : ""),
          duration_minutes: vd.service_duration ? Math.round(vd.service_duration / 60000) : null,
          team_member_ids: vd.team_member_ids || [],
          available_for_takeshi: (vd.team_member_ids || []).includes("TM4KBBvc9KKU5Auf"),
          available_for_naoko: (vd.team_member_ids || []).includes("TMyoTzCPU06PeMxI")
        });
      }
    }

    sendJson(res, 200, { total: services.length, services });
  } catch (err) {
    console.error("services error:", err);
    sendJson(res, 500, { error: err.message });
  }
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

    const staff = CALENDAR_STAFF[staffKey];
    const teamMemberId = staff.id;
    const serviceVariationId = staff.serviceVariationId;

    // 検索範囲（JST）。過去にならないよう、現在時刻以降に補正する
    let rangeStart = new Date(`${startDate}T00:00:00+09:00`);
    const now = new Date();
    if (rangeStart < now) rangeStart = now;
    const rangeEnd = new Date(`${endDate}T23:59:59+09:00`);

    // Square の空き枠検索（実際に予約できる枠だけが返る）
    const body = {
      query: {
        filter: {
          start_at_range: {
            start_at: rangeStart.toISOString(),
            end_at: rangeEnd.toISOString()
          },
          location_id: CALENDAR_LOCATION_ID,
          segment_filters: [
            {
              service_variation_id: serviceVariationId,
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

    const availabilities = result.availabilities || [];

    // 予約可能な時間帯（時単位）をセットに入れる
    const openSet = new Set();
    for (const a of availabilities) {
      if (!a.start_at) continue;
      const jst = new Date(new Date(a.start_at).getTime() + 9 * 60 * 60 * 1000);
      const dateStr = jst.toISOString().slice(0, 10);
      const hour    = jst.getUTCHours();
      openSet.add(`${dateStr}:${hour}`);
    }

    // 日付×時間のスロットを作る
    // open = Squareで予約できる / closed = 予約不可 / holiday = 定休日
    const slots = {};
    const cur = new Date(`${startDate}T00:00:00+09:00`);
    const end = new Date(`${endDate}T00:00:00+09:00`);
    end.setDate(end.getDate() + 1);

    while (cur < end) {
      const jst     = new Date(cur.getTime() + 9 * 60 * 60 * 1000);
      const dateStr = jst.toISOString().slice(0, 10);

      if (!slots[dateStr]) slots[dateStr] = {};

      for (let h = CALENDAR_OPEN_HOUR; h <= CALENDAR_CLOSE_HOUR; h++) {
        if (openSet.has(`${dateStr}:${h}`)) {
          slots[dateStr][h] = "open";
        } else {
          slots[dateStr][h] = "closed";
        }
      }

      cur.setDate(cur.getDate() + 1);
    }

    sendJson(res, 200, { slots });

  } catch (err) {
    console.error("availability error:", err);
    sendJson(res, 500, { error: err.message });
  }
}

function buildCalendarHtml() {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Noelhair | 空き状況</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400&family=Noto+Serif+JP:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root{
    --tiffany:#81D8D0;
    --tiffany-deep:#3CA89F;
    --tiffany-ink:#256A64;
    --bg:#fbfdfd;
    --white:#ffffff;
    --ink:#2b3a38;
    --ink-soft:#6a7d7b;
    --line:#dcebe9;
    --closed-bg:#f1f4f4;
    --closed-ink:#aebab9;
  }
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:'Noto Serif JP',serif;background:var(--bg);color:var(--ink);min-height:100vh;-webkit-font-smoothing:antialiased;line-height:1.7;max-width:640px;margin:0 auto;}
  .header{background:var(--white);padding:22px 16px 14px;border-bottom:1px solid var(--line);text-align:center;}
  .salon-name{font-family:'Cormorant Garamond',serif;font-size:30px;font-weight:500;letter-spacing:0.09em;color:var(--ink);}
  .salon-name span{color:var(--tiffany-deep);font-style:italic;}
  .subtitle{font-size:11px;color:var(--ink-soft);letter-spacing:0.2em;margin-top:5px;font-weight:500;}
  .tabs{display:flex;border-bottom:1px solid var(--line);background:var(--white);position:sticky;top:0;z-index:20;}
  .tab{flex:1;padding:15px 6px 13px;text-align:center;cursor:pointer;color:var(--ink-soft);border-bottom:3px solid transparent;margin-bottom:-1px;transition:all 0.25s;}
  .tab.active{color:var(--tiffany-ink);border-bottom-color:var(--tiffany-deep);background:rgba(129,216,208,0.05);}
  .tab-name-jp{font-size:17px;font-weight:600;letter-spacing:0.05em;}
  .tab-name-en{font-size:9px;letter-spacing:0.1em;margin-top:2px;opacity:0.6;font-family:'Cormorant Garamond',serif;font-weight:500;}
  .main{padding:18px 10px 44px;}
  .lead{font-size:13px;color:var(--ink);text-align:center;margin-bottom:16px;font-weight:500;}
  .week-nav{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;padding:0 4px;}
  .week-label{font-size:16px;font-weight:600;letter-spacing:0.02em;color:var(--ink);}
  .nav-btn{width:38px;height:38px;border-radius:50%;border:1.5px solid var(--tiffany);background:var(--white);color:var(--tiffany-deep);cursor:pointer;font-size:18px;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all 0.2s;}
  .nav-btn:hover{background:var(--tiffany-deep);color:white;border-color:var(--tiffany-deep);}
  .grid-wrap{border-radius:12px;border:1.5px solid var(--line);background:var(--white);box-shadow:0 3px 18px rgba(60,168,159,0.06);overflow:hidden;}
  .grid-table{border-collapse:separate;border-spacing:0;width:100%;table-layout:fixed;}
  .grid-table th{background:var(--white);font-weight:600;padding:10px 1px 8px;text-align:center;border-bottom:1.5px solid var(--line);}
  .grid-table th.time-col{width:48px;}
  .grid-table th.sun{color:#d97f7f;}
  .grid-table th.sat{color:#6f97cf;}
  .grid-table th .dnum{font-size:16px;line-height:1.1;font-weight:600;}
  .grid-table th .dname{font-size:10px;opacity:0.7;margin-top:2px;font-weight:500;}
  .grid-table th.today-h .dnum{color:var(--tiffany-deep);}
  .grid-table th.today-h .dname{color:var(--tiffany-deep);opacity:1;}
  .grid-table td{border-bottom:1px solid var(--line);border-left:1px solid var(--line);text-align:center;height:42px;}
  .grid-table td.time-cell{font-size:12px;font-weight:600;color:var(--ink);background:var(--white);padding:0;border-left:none;letter-spacing:-0.02em;}
  .grid-table tr:last-child td{border-bottom:none;}
  .grid-table td.c-open{background:rgba(129,216,208,0.2);}
  .grid-table td.c-closed{background:var(--closed-bg);}
  .grid-table td.c-past{background:#fafbfb;}
  .cell-in{display:flex;align-items:center;justify-content:center;height:100%;font-size:18px;font-weight:600;}
  .c-open .cell-in{color:var(--tiffany-deep);}
  .c-closed .cell-in{color:var(--closed-ink);font-size:14px;}
  .c-past .cell-in{color:#dde5e4;font-size:14px;}
  .legend{display:flex;gap:20px;justify-content:center;flex-wrap:wrap;margin:18px 0;}
  .legend-item{display:flex;align-items:center;gap:7px;font-size:13px;color:var(--ink);font-weight:500;}
  .legend-mark{font-size:18px;font-weight:600;}
  .legend-mark.open{color:var(--tiffany-deep);}
  .legend-mark.closed{color:var(--closed-ink);}
  .note{font-size:12px;color:var(--ink);text-align:left;padding:16px 18px;background:rgba(129,216,208,0.08);border-radius:11px;margin:0 4px;line-height:1.9;border:1px solid var(--line);}
  .note strong{color:var(--tiffany-ink);font-weight:700;}
  .book-link{display:block;margin:18px 4px 0;background:var(--tiffany);color:#ffffff;text-align:center;padding:18px;border-radius:12px;font-size:17px;letter-spacing:0.08em;text-decoration:none;transition:all 0.25s;font-weight:600;box-shadow:0 4px 16px rgba(129,216,208,0.45);}
  .book-link:hover{background:#6fcdc4;box-shadow:0 6px 22px rgba(129,216,208,0.55);transform:translateY(-1px);}
</style>
</head>
<body>
<div class="header">
  <div class="salon-name">Noël<span>hair</span></div>
  <div class="subtitle">ご予約 空き状況</div>
</div>
<div class="tabs">
  <div class="tab active" id="tab-takeshi" onclick="switchStaff('takeshi')">
    <div class="tab-name-jp">二瓶 武士</div><div class="tab-name-en">TAKESHI</div>
  </div>
  <div class="tab" id="tab-naoko" onclick="switchStaff('naoko')">
    <div class="tab-name-jp">NAOKO</div><div class="tab-name-en">NAOKO</div>
  </div>
</div>
<div class="main">
  <p class="lead">ご希望の担当者を選び、空き状況をご確認ください。</p>
  <div class="week-nav">
    <button class="nav-btn" onclick="changeWeek(-1)">&#x2039;</button>
    <div class="week-label" id="weekLabel"></div>
    <button class="nav-btn" onclick="changeWeek(1)">&#x203a;</button>
  </div>
  <div class="grid-wrap"><table class="grid-table" id="gridTable"><tbody><tr><td colspan="8" style="padding:24px;text-align:center;color:#6a7d7b;">読み込み中...</td></tr></tbody></table></div>
  <div class="legend">
    <div class="legend-item"><span class="legend-mark open">○</span>予約できます</div>
    <div class="legend-item"><span class="legend-mark closed">×</span>予約できません</div>
  </div>
  <div class="note">
    ○の時間帯は、現在ご予約をお受けできる時間です。<br>
    こちらのカレンダーは<strong>約1ヶ月先まで</strong>表示しております。<br>
    なお、この空き状況には<strong>多少の時間差</strong>がございます。ご予約のお手続き中に、別のお客様のご予約が入り満席となる場合がございますので、あらかじめご了承ください。<br>
    最新の空き状況は、下のご予約ページにてご確認いただけます。
  </div>
  <a href="https://noelhair.square.site" class="book-link" target="_blank">ご予約はこちら →</a>
</div>
<script>
var OPEN_HOUR=9,CLOSE_HOUR=19;
var today=new Date();today.setHours(0,0,0,0);
var currentStaff='takeshi',weekOffset=0,slotsCache={};
function switchStaff(s){
  currentStaff=s;
  document.getElementById('tab-takeshi').classList.toggle('active',s==='takeshi');
  document.getElementById('tab-naoko').classList.toggle('active',s==='naoko');
  slotsCache={};loadAndRender();
}
function getWeekDates(){
  var d=new Date(today);
  var dow=d.getDay()===0?6:d.getDay()-1;
  d.setDate(d.getDate()-dow+weekOffset*7);
  var arr=[];
  for(var i=0;i<7;i++){var x=new Date(d);x.setDate(d.getDate()+i);arr.push(x);}
  return arr;
}
function fmt(d){
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
async function loadAndRender(){
  var days=getWeekDates();
  var start=fmt(days[0]),end=fmt(days[6]);
  var cacheKey=currentStaff+start;
  document.getElementById('gridTable').innerHTML='<tbody><tr><td colspan="8" style="padding:24px;text-align:center;color:#6a7d7b;">読み込み中...</td></tr></tbody>';
  if(!slotsCache[cacheKey]){
    try{
      var r=await fetch('/api/availability?staff='+currentStaff+'&start='+start+'&end='+end);
      var data=await r.json();
      slotsCache[cacheKey]=data.slots||{};
    }catch(e){slotsCache[cacheKey]={};}
  }
  renderGrid(days,slotsCache[cacheKey]);
}
function renderGrid(days,slots){
  var dayNames=['日','月','火','水','木','金','土'];
  var months=['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
  var first=days[0],last=days[6];
  document.getElementById('weekLabel').textContent=
    months[first.getMonth()]+first.getDate()+'日 〜 '+months[last.getMonth()]+last.getDate()+'日';
  var html='<thead><tr><th class="time-col"></th>';
  days.forEach(function(d){
    var dow=d.getDay();
    var isToday=d.getTime()===today.getTime();
    var cls=(dow===0?'sun':dow===6?'sat':'')+(isToday?' today-h':'');
    html+='<th class="'+cls+'"><div class="dnum">'+d.getDate()+'</div><div class="dname">'+dayNames[dow]+'</div></th>';
  });
  html+='</tr></thead><tbody>';
  var nowHour=new Date().getHours();
  for(var h=OPEN_HOUR;h<=CLOSE_HOUR;h++){
    html+='<tr><td class="time-cell">'+String(h).padStart(2,'0')+':00</td>';
    days.forEach(function(d){
      var ds=fmt(d);
      var isPast=d<today||(d.getTime()===today.getTime()&&h<=nowHour);
      var status=isPast?'past':((slots[ds]&&slots[ds][h])||'closed');
      var cls,icon;
      if(status==='past'){cls='c-past';icon='—';}
      else if(status==='open'){cls='c-open';icon='○';}
      else{cls='c-closed';icon='×';}
      html+='<td class="'+cls+'"><div class="cell-in">'+icon+'</div></td>';
    });
    html+='</tr>';
  }
  html+='</tbody>';
  document.getElementById('gridTable').innerHTML=html;
}
function changeWeek(d){weekOffset+=d;loadAndRender();}
loadAndRender();
</script>
</body></html>`;
}
