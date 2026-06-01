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
  linksFile: path.resolve(__dirname, "..", process.env.LINKS_FILE || "./data/links.json")
};

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
      await Promise.all((payload.events || []).map(handleLineEvent));
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
      return replyText(
        event.replyToken,
        "予約確認ですね。初回だけ本人確認をします。\nお名前と電話番号の下4桁を送ってください。\n例: 山田花子 1234"
      );
    }

    const bookings = await listUpcomingBookings(linkedCustomerId);
    return replyText(event.replyToken, formatBookings(bookings));
  }

  const identity = parseIdentity(text);
  if (!identity) {
    return replyText(
      event.replyToken,
      "「予約確認」と送ると予約を確認できます。初回は、お名前と電話番号の下4桁も必要です。"
    );
  }

  const matchedCustomer = await findCustomerByNameAndPhoneSuffix(identity.name, identity.phoneSuffix);
  if (!matchedCustomer) {
    return replyText(
      event.replyToken,
      "該当するお客様情報が見つかりませんでした。お名前の表記と電話番号下4桁を確認して、もう一度送ってください。"
    );
  }

  await linkLineUser(lineUserId, matchedCustomer.id);
  const bookings = await listUpcomingBookings(matchedCustomer.id);
  return replyText(event.replyToken, `本人確認ができました。\n\n${formatBookings(bookings)}`);
}

function isBookingCommand(text) {
  return ["予約確認", "予約", "確認"].includes(text.replace(/\s/g, ""));
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
    const body = { limit: 100, count: false };
    if (cursor) body.cursor = cursor;
    const result = await squareRequest("/v2/customers/search", {
      method: "POST",
      body
    });

    const match = (result.customers || []).find((customer) => {
      const fullName = normalizeText(`${customer.family_name || ""}${customer.given_name || ""}`);
      const reversedName = normalizeText(`${customer.given_name || ""}${customer.family_name || ""}`);
      const phone = normalizePhone(customer.phone_number || "");
      return (fullName === name || reversedName === name) && phone.endsWith(phoneSuffix);
    });

    if (match) return match;
    if (!result.cursor) return null;
    cursor = result.cursor;
  }

  return null;
}

async function listUpcomingBookings(customerId) {
  const now = new Date();
  const max = new Date(now.getTime() + config.searchDaysAhead * 24 * 60 * 60 * 1000);
  const params = new URLSearchParams({
    customer_id: customerId,
    start_at_min: now.toISOString(),
    start_at_max: max.toISOString(),
    limit: "20"
  });

  const result = await squareRequest(`/v2/bookings?${params.toString()}`, {
    method: "GET"
  });

  return (result.bookings || [])
    .filter((booking) => ["ACCEPTED", "PENDING"].includes(booking.status))
    .sort((a, b) => new Date(a.start_at) - new Date(b.start_at));
}

function formatBookings(bookings) {
  if (!bookings.length) {
    return "現在、確認できる今後の予約はありません。";
  }

  const lines = bookings.slice(0, 5).map((booking, index) => {
    const date = formatTokyoDate(booking.start_at);
    const minutes = (booking.appointment_segments || []).reduce(
      (sum, segment) => sum + Number(segment.duration_minutes || 0),
      0
    );
    const duration = minutes ? ` / ${minutes}分` : "";
    return `${index + 1}. ${date}${duration}`;
  });

  return `今後の予約はこちらです。\n${lines.join("\n")}`;
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
  const links = await readLinks();
  return links[lineUserId]?.squareCustomerId || null;
}

async function linkLineUser(lineUserId, squareCustomerId) {
  const links = await readLinks();
  links[lineUserId] = {
    squareCustomerId,
    linkedAt: new Date().toISOString()
  };
  await writeLinks(links);
}

async function unlinkLineUser(lineUserId) {
  const links = await readLinks();
  delete links[lineUserId];
  await writeLinks(links);
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
