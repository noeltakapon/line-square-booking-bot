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
  linkKeyPrefix: process.env.LINK_KEY_PREFIX || "line-square-booking",
  resendApiKey: process.env.RESEND_API_KEY || "",
  adminPassword: process.env.ADMIN_PASSWORD || "noelhair2024",
  googleReviewUrl: process.env.GOOGLE_REVIEW_URL || "https://g.page/r/YOUR_GOOGLE_REVIEW_ID/review",
  squareBookingUrl: process.env.SQUARE_BOOKING_URL || "https://noelhair.square.site"
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

    // ============================================================
    // 管理画面ルート（新規追加）
    // ============================================================

    if (req.method === "GET" && req.url === "/admin") {
      return serveAdminPage(res);
    }

    if (req.method === "GET" && req.url === "/api/today-visitors") {
      return serveTodayVisitors(res);
    }

    if (req.method === "POST" && req.url === "/api/send-email") {
      const rawBody = await readBody(req);
      const body = JSON.parse(rawBody.toString("utf8"));
      return handleSendEmail(body, res);
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

// ============================================================
// 管理画面：当日来店者取得
// ============================================================

async function serveTodayVisitors(res) {
  try {
    const now = new Date();
    const jstOffset = 9 * 60 * 60 * 1000;
    const todayJst = new Date(now.getTime() + jstOffset);
    const dateStr = todayJst.toISOString().slice(0, 10);

    const startAt = new Date(`${dateStr}T00:00:00+09:00`);
    const endAt   = new Date(`${dateStr}T23:59:59+09:00`);

    const params = new URLSearchParams({
      location_id: CALENDAR_LOCATION_ID,
      start_at_min: startAt.toISOString(),
      start_at_max: endAt.toISOString(),
      limit: "100"
    });

    const result = await squareRequest(`/v2/bookings?${params.toString()}`, { method: "GET" });
    const bookings = (result.bookings || []).filter(
      b => !["CANCELLED_BY_CUSTOMER", "CANCELLED_BY_SELLER", "DECLINED"].includes(b.status)
    );

    // 顧客情報を並行取得
    const visitors = await Promise.all(bookings.map(async (booking) => {
      const customerId = booking.customer_id;
      let customerName = "お名前不明";
      let email = null;

      if (customerId) {
        try {
          const cResult = await squareRequest(`/v2/customers/${customerId}`, { method: "GET" });
          const c = cResult.customer || {};
          customerName = [c.family_name, c.given_name].filter(Boolean).join(" ") || c.nickname || c.company_name || "お名前不明";
          email = c.email_address || null;
        } catch (e) {
          console.error("Customer fetch error:", e.message);
        }
      }

      const segments = booking.appointment_segments || [];
      const menuNames = (await Promise.all(segments.map(getServiceName))).filter(Boolean);
      const staffId = segments[0]?.team_member_id || "";

      return {
        bookingId: booking.id,
        customerId,
        customerName,
        email,
        hasEmail: Boolean(email),
        startAt: booking.start_at,
        timeLabel: formatTokyoTime(booking.start_at),
        menu: menuNames.join("・") || "メニュー不明",
        status: booking.status,
        staffId
      };
    }));

    // 時間順にソート
    visitors.sort((a, b) => new Date(a.startAt) - new Date(b.startAt));

    sendJson(res, 200, { date: dateStr, visitors });
  } catch (error) {
    console.error("today-visitors error:", error);
    sendJson(res, 500, { error: error.message });
  }
}

// ============================================================
// メール送信
// ============================================================

// メールの共通ラッパーHTML（v4デザイン）
function buildEmailWrapper(content, staffName) {
  return `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f4f0;font-family:Georgia,'Times New Roman',serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f4f0;padding:40px 0;">
  <tr><td align="center">
    <table width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#ffffff;">
      <tr><td style="height:3px;line-height:3px;font-size:0;background:#81D8D0;">&nbsp;</td></tr>
      <tr><td style="padding:48px 48px 0;text-align:center;">
        <div style="font-size:32px;font-weight:400;letter-spacing:0.18em;color:#1a1a1a;">Noël<span style="color:#81D8D0;font-style:italic;">hair</span></div>
      </td></tr>
      <tr><td style="padding:28px 48px 0;">
        <div style="height:0.5px;line-height:0.5px;font-size:0;background:#e8e8e8;">&nbsp;</div>
      </td></tr>
      <tr><td style="padding:36px 48px 0;">
        ${content}
      </td></tr>
      <tr><td style="padding:28px 48px 40px;text-align:center;">
        <div style="font-size:10px;letter-spacing:0.2em;color:#bbb;">NOËLHAIR&nbsp;&nbsp;・&nbsp;&nbsp;TSURUGASHIMA, SAITAMA</div>
      </td></tr>
      <tr><td style="height:3px;line-height:3px;font-size:0;background:#1a1a1a;">&nbsp;</td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

// 挨拶段落を組み立てる
function buildGreetingParagraphs(name) {
  return `
      <p style="font-size:15px;color:#1a1a1a;margin:0 0 24px;letter-spacing:0.03em;">${name} 様</p>
      <p style="font-size:14px;color:#444;line-height:2.2;margin:0 0 20px;letter-spacing:0.03em;">本日はご来店いただき、本当にありがとうございました。</p>
      <p style="font-size:14px;color:#444;line-height:2.2;margin:0 0 20px;letter-spacing:0.03em;">お会いできてとても嬉しかったです。<br>ご自宅に帰られてからも、ぜひゆっくりお過ごしください。</p>`;
}

// Tiffanyブルーの案内ブロック（口コミ／次回予約など）
function buildCtaBlock({ eyebrow, lead, sub, buttonLabel, url }) {
  return `
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#81D8D0;">
        <tr><td style="padding:36px;text-align:center;">
          <div style="font-size:10px;letter-spacing:0.35em;color:rgba(255,255,255,0.8);margin-bottom:16px;">${eyebrow}</div>
          <p style="font-size:14px;color:#fff;line-height:2;margin:0 0 8px;letter-spacing:0.02em;">${lead}</p>
          <p style="font-size:13px;color:rgba(255,255,255,0.85);line-height:1.9;margin:0 0 24px;letter-spacing:0.02em;">${sub}</p>
          <a href="${url}" style="display:inline-block;background:#fff;color:#1a1a1a;text-decoration:none;padding:14px 40px;font-size:11px;letter-spacing:0.2em;font-family:Georgia,'Times New Roman',serif;">${buttonLabel}</a>
        </td></tr>
      </table>`;
}

const EMAIL_TEMPLATES = {
  review: {
    label: "お礼 ＋ 口コミお願い",
    subject: "本日はありがとうございました｜Noëlhair",
    buildHtml: (name, urls, staffName) => buildEmailWrapper(`
      ${buildGreetingParagraphs(name)}
      <p style="font-size:14px;color:#444;line-height:2.2;margin:0 0 36px;letter-spacing:0.03em;">次回もお待ちしております。<br>何かご不明な点やご要望がありましたら、いつでもお気軽にご連絡ください。</p>
      ${buildCtaBlock({
        eyebrow: "YOUR VOICE MATTERS",
        lead: "もしよければ、今日の感想をひと言だけ<br>残していただけませんか？",
        sub: "口コミはお店にとって本当に大きな励みになります。<br>ほんの少しのお言葉でも、とても嬉しいです。",
        buttonLabel: "クチコミを書く",
        url: urls.review
      })}
    `, staffName)
  },
  nextvisit: {
    label: "お礼 ＋ 次回予約のご案内",
    subject: "本日はありがとうございました｜Noëlhair",
    buildHtml: (name, urls, staffName) => buildEmailWrapper(`
      ${buildGreetingParagraphs(name)}
      <p style="font-size:14px;color:#444;line-height:2.2;margin:0 0 36px;letter-spacing:0.03em;">次回もお待ちしております。<br>何かご不明な点やご要望がありましたら、いつでもお気軽にご連絡ください。</p>
      ${buildCtaBlock({
        eyebrow: "SEE YOU AGAIN SOON",
        lead: "次回のご来店を、<br>心よりお待ちしております。",
        sub: "ご都合のよい日時で、お気軽にご予約くださいませ。",
        buttonLabel: "次回を予約する",
        url: urls.booking
      })}
    `, staffName)
  },
  thanks: {
    label: "お礼のみ",
    subject: "本日はありがとうございました｜Noëlhair",
    buildHtml: (name, urls, staffName) => buildEmailWrapper(`
      ${buildGreetingParagraphs(name)}
      <p style="font-size:14px;color:#444;line-height:2.2;margin:0;letter-spacing:0.03em;">次回もお待ちしております。<br>何かご不明な点やご要望がありましたら、いつでもお気軽にご連絡ください。</p>
    `, staffName)
  }
};

async function handleSendEmail(body, res) {
  const { email, customerName, templateKey, staffId, customBody } = body;

  if (!email || !customerName || !templateKey) {
    return sendJson(res, 400, { error: "missing parameters" });
  }

  const template = EMAIL_TEMPLATES[templateKey];
  if (!template) {
    return sendJson(res, 400, { error: "invalid template" });
  }

  if (!config.resendApiKey) {
    return sendJson(res, 500, { error: "RESEND_API_KEY not set" });
  }

  const staffName = staffId === "TMyoTzCPU06PeMxI" ? "NAOKO" : "二瓶武士";

  const urls = {
    review: config.googleReviewUrl,
    booking: config.squareBookingUrl
  };

  let html;
  if (customBody) {
    const escapedBody = customBody
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br>");
    html = buildEmailWrapper(`<div style="font-size:14px;line-height:2.2;color:#444;letter-spacing:0.03em;">${escapedBody}</div>`, staffName);
  } else {
    html = template.buildHtml(customerName, urls, staffName);
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.resendApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: "Noëlhair 二瓶武士 <noreply@noelhair.com>",
        to: [email],
        subject: template.subject,
        html
      })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.message || "Resend error");
    }

    console.log(`Email sent to ${email} (template: ${templateKey})`);
    sendJson(res, 200, { ok: true, id: data.id });
  } catch (error) {
    console.error("Email send error:", error);
    sendJson(res, 500, { error: error.message });
  }
}

// ============================================================
// 管理画面HTML
// ============================================================

function serveAdminPage(res) {
  const templateOptions = Object.entries(EMAIL_TEMPLATES)
    .map(([key, t]) => `<option value="${key}">${t.label}</option>`)
    .join("");

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Noëlhair | 管理</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;1,400&family=Noto+Serif+JP:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root{
    --tiffany:#81D8D0;
    --tiffany-deep:#3CA89F;
    --tiffany-ink:#256A64;
    --bg:#F7F5EF;
    --white:#ffffff;
    --ink:#111111;
    --ink-soft:#555;
    --line:#dce8e6;
  }
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:'Noto Serif JP',serif;background:var(--bg);color:var(--ink);min-height:100vh;max-width:600px;margin:0 auto;-webkit-font-smoothing:antialiased;}
  .header{background:var(--white);padding:20px 16px 14px;border-bottom:1px solid var(--line);text-align:center;}
  .salon-name{font-family:'Cormorant Garamond',serif;font-size:26px;letter-spacing:0.08em;}
  .salon-name em{color:var(--tiffany-deep);font-style:italic;}
  .subtitle{font-size:11px;color:var(--ink-soft);letter-spacing:0.2em;margin-top:4px;}
  .main{padding:16px 14px 60px;}
  .date-label{font-size:18px;font-weight:600;color:var(--tiffany-ink);margin-bottom:14px;text-align:center;}
  .loading{text-align:center;padding:40px;color:var(--ink-soft);font-size:14px;}
  .visitor-card{background:var(--white);border-radius:12px;border:1px solid var(--line);padding:16px;margin-bottom:12px;box-shadow:0 2px 8px rgba(60,168,159,0.06);}
  .visitor-card.sent{opacity:0.5;}
  .visitor-top{display:flex;align-items:flex-start;gap:12px;margin-bottom:12px;}
  .visitor-time{font-size:13px;color:var(--tiffany-ink);font-weight:600;white-space:nowrap;padding-top:2px;}
  .visitor-info{flex:1;}
  .visitor-name{font-size:17px;font-weight:600;line-height:1.3;}
  .visitor-menu{font-size:12px;color:var(--ink-soft);margin-top:3px;}
  .no-email{font-size:11px;color:#c0806a;margin-top:4px;background:#fff5f2;padding:3px 8px;border-radius:20px;display:inline-block;}
  .visitor-actions{display:flex;gap:8px;align-items:center;}
  .template-select{flex:1;padding:10px 10px;border-radius:8px;border:1.5px solid var(--line);font-size:13px;font-family:'Noto Serif JP',serif;background:var(--white);color:var(--ink);appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%233CA89F' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center;padding-right:30px;}
  .edit-btn{padding:10px 16px;background:var(--white);color:var(--tiffany-ink);border:1.5px solid var(--tiffany);border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:'Noto Serif JP',serif;white-space:nowrap;transition:all 0.2s;}
  .edit-btn:hover{background:rgba(129,216,208,0.1);}
  .send-btn{padding:10px 16px;background:var(--tiffany-deep);color:white;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:'Noto Serif JP',serif;white-space:nowrap;transition:all 0.2s;}
  .send-btn:hover{background:var(--tiffany-ink);}
  .send-btn:disabled{background:#ccc;cursor:not-allowed;}
  .sent-badge{font-size:12px;color:var(--tiffany-ink);font-weight:600;text-align:right;margin-top:8px;}
  .empty{text-align:center;padding:50px 20px;color:var(--ink-soft);}
  .empty-icon{font-size:36px;margin-bottom:12px;}
  .reload-btn{display:block;margin:16px auto 0;padding:10px 24px;background:var(--white);border:1.5px solid var(--line);border-radius:8px;font-size:13px;cursor:pointer;font-family:'Noto Serif JP',serif;color:var(--tiffany-ink);font-weight:600;}
  .modal-overlay{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:100;align-items:flex-end;justify-content:center;}
  .modal-overlay.open{display:flex;}
  .modal{background:var(--white);border-radius:16px 16px 0 0;padding:20px 16px 32px;width:100%;max-width:600px;max-height:90vh;overflow-y:auto;}
  .modal-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;}
  .modal-title{font-size:15px;font-weight:600;color:var(--tiffany-ink);}
  .modal-close{background:none;border:none;font-size:22px;cursor:pointer;color:var(--ink-soft);padding:0 4px;}
  .modal-to{font-size:13px;color:var(--ink-soft);margin-bottom:12px;padding:10px 12px;background:var(--bg);border-radius:8px;}
  .modal-label{font-size:12px;color:var(--ink-soft);margin-bottom:6px;font-weight:600;letter-spacing:0.05em;}
  .modal-textarea{width:100%;border:1.5px solid var(--line);border-radius:10px;padding:14px;font-size:14px;font-family:'Noto Serif JP',serif;line-height:1.9;color:var(--ink);resize:vertical;min-height:220px;background:var(--white);}
  .modal-textarea:focus{outline:none;border-color:var(--tiffany);}
  .modal-actions{display:flex;gap:10px;margin-top:16px;}
  .modal-cancel{flex:1;padding:13px;background:var(--white);border:1.5px solid var(--line);border-radius:8px;font-size:14px;cursor:pointer;font-family:'Noto Serif JP',serif;color:var(--ink-soft);}
  .modal-send{flex:2;padding:13px;background:var(--tiffany-deep);color:white;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;font-family:'Noto Serif JP',serif;transition:all 0.2s;}
  .modal-send:hover{background:var(--tiffany-ink);}
  .modal-send:disabled{background:#ccc;cursor:not-allowed;}
</style>
</head>
<body>
<div class="header">
  <div class="salon-name">Noël<em>hair</em></div>
  <div class="subtitle">来店者メール送信</div>
</div>
<div class="main">
  <div class="date-label" id="dateLabel">読み込み中...</div>
  <div id="visitorList"><div class="loading">来店者を確認しています...</div></div>
  <button class="reload-btn" onclick="loadVisitors()">🔄 再読み込み</button>
</div>

<div class="modal-overlay" id="modalOverlay">
  <div class="modal">
    <div class="modal-header">
      <div class="modal-title" id="modalTitle">メール内容を確認・編集</div>
      <button class="modal-close" onclick="closeModal()">×</button>
    </div>
    <div class="modal-to" id="modalTo"></div>
    <div class="modal-label">本文（自由に編集できます）</div>
    <textarea class="modal-textarea" id="modalBody"></textarea>
    <div class="modal-actions">
      <button class="modal-cancel" onclick="closeModal()">キャンセル</button>
      <button class="modal-send" id="modalSendBtn" onclick="confirmSend()">この内容で送信する</button>
    </div>
  </div>
</div>

<script>
const TEMPLATES = ${JSON.stringify(
    Object.fromEntries(Object.entries(EMAIL_TEMPLATES).map(([k, t]) => [k, t.label]))
  )};

const TEMPLATE_BODIES = ${JSON.stringify(
    Object.fromEntries(Object.entries(EMAIL_TEMPLATES).map(([k, t]) => {
      const staffName = "二瓶武士";
      const reviewUrl = "https://g.page/r/CXxYjKYZZaSHEAE/review";
      const bookingUrl = "https://noelhair.square.site";
      const previewName = "お客様";
      const body = t.buildHtml(previewName, { review: reviewUrl, booking: bookingUrl }, staffName);
      const textBody = body
        .replace(/<div[^>]*>/g, "").replace(/<\/div>/g, "\n")
        .replace(/<p[^>]*>/g, "").replace(/<\/p>/g, "\n")
        .replace(/<a[^>]*>([^<]*)<\/a>/g, "$1")
        .replace(/<span[^>]*>([^<]*)<\/span>/g, "$1")
        .replace(/<br\s*\/?>/g, "\n")
        .replace(/&nbsp;/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      return [k, textBody];
    }))
  )};

const sentSet = new Set(JSON.parse(localStorage.getItem('noelhair_sent') || '[]'));
let currentModal = null;

function saveSent() {
  localStorage.setItem('noelhair_sent', JSON.stringify([...sentSet]));
}

async function loadVisitors() {
  document.getElementById('visitorList').innerHTML = '<div class="loading">来店者を確認しています...</div>';
  try {
    const res = await fetch('/api/today-visitors');
    const data = await res.json();

    const d = new Date();
    const label = d.getFullYear() + '年' + (d.getMonth()+1) + '月' + d.getDate() + '日（本日）';
    document.getElementById('dateLabel').textContent = label;

    if (!data.visitors || data.visitors.length === 0) {
      document.getElementById('visitorList').innerHTML = \`
        <div class="empty">
          <div class="empty-icon">📋</div>
          <div>本日の来店者はまだいません</div>
        </div>\`;
      return;
    }

    let html = '';
    data.visitors.forEach(v => {
      const isSent = sentSet.has(v.bookingId);
      const hasEmail = v.hasEmail;
      html += \`<div class="visitor-card\${isSent ? ' sent' : ''}" id="card-\${v.bookingId}">
        <div class="visitor-top">
          <div class="visitor-time">\${v.timeLabel}</div>
          <div class="visitor-info">
            <div class="visitor-name">\${v.customerName}</div>
            <div class="visitor-menu">\${v.menu}</div>
            \${!hasEmail ? '<div class="no-email">メールアドレス未登録</div>' : ''}
          </div>
        </div>
        \${hasEmail && !isSent ? \`
        <div class="visitor-actions">
          <select class="template-select" id="tmpl-\${v.bookingId}">
            \${Object.entries(TEMPLATES).map(([k,l]) => \`<option value="\${k}">\${l}</option>\`).join('')}
          </select>
          <button class="edit-btn" onclick="openModal('\${v.bookingId}','\${v.email}','\${v.customerName}','\${v.staffId}')">内容を確認・編集</button>
        </div>\` : ''}
        \${isSent ? '<div class="sent-badge">✅ 送信済み</div>' : ''}
      </div>\`;
    });
    document.getElementById('visitorList').innerHTML = html;
  } catch(e) {
    document.getElementById('visitorList').innerHTML = '<div class="loading">読み込みエラー。再読み込みしてください。</div>';
  }
}

function openModal(bookingId, email, customerName, staffId) {
  const templateKey = document.getElementById('tmpl-' + bookingId).value;
  const staffName = staffId === 'TMyoTzCPU06PeMxI' ? 'NAOKO' : '二瓶武士';

  let bodyText = (TEMPLATE_BODIES[templateKey] || '').replace(/お客様/g, customerName).replace(/二瓶武士/g, staffName);

  currentModal = { bookingId, email, customerName, staffId, templateKey };

  document.getElementById('modalTitle').textContent = customerName + ' 様へのメール';
  document.getElementById('modalTo').textContent = '宛先：' + email;
  document.getElementById('modalBody').value = bodyText;
  document.getElementById('modalOverlay').classList.add('open');
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('open');
  currentModal = null;
}

async function confirmSend() {
  if (!currentModal) return;
  const btn = document.getElementById('modalSendBtn');
  btn.disabled = true;
  btn.textContent = '送信中...';

  const customBody = document.getElementById('modalBody').value;

  try {
    const res = await fetch('/api/send-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: currentModal.email,
        customerName: currentModal.customerName,
        templateKey: currentModal.templateKey,
        staffId: currentModal.staffId,
        customBody
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'エラー');

    sentSet.add(currentModal.bookingId);
    saveSent();
    document.getElementById('card-' + currentModal.bookingId).classList.add('sent');
    document.querySelector('#card-' + currentModal.bookingId + ' .visitor-actions').innerHTML = '<div class="sent-badge">✅ 送信済み</div>';
    closeModal();
  } catch(e) {
    alert('送信失敗: ' + e.message);
    btn.disabled = false;
    btn.textContent = 'この内容で送信する';
  }
}

loadVisitors();
</script>
</body>
</html>`;

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

// ============================================================
// 以下、既存コード（変更なし）
// ============================================================

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

function formatTokyoTime(value) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
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
    serviceVariationId: "A23FMPXKLQ5C45K6Y5NXJYBG"
  },
  naoko: {
    id: "TMyoTzCPU06PeMxI",
    name: "NAOKO",
    serviceVariationId: "LUCUGMQKRAYIRYZQ2YTKRY42"
  }
};
const CALENDAR_LOCATION_ID = "LQ2HAT073YS1N";
const CALENDAR_OPEN_HOUR  = 9;
const CALENDAR_CLOSE_HOUR = 19;
const SQUARE_BOOKING_URL = "https://squareup.com/appointments/book/LQ2HAT073YS1N";

function serveCalendar(res) {
  const html = buildCalendarHtml();
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

async function serveServices(res) {
  try {
    const catalog = await squareRequest("/v2/catalog/list?types=ITEM", { method: "GET" });
    const items = (catalog.objects || []).filter(
      (o) => o.item_data?.product_type === "APPOINTMENTS_SERVICE"
    );

    const services = [];
    for (const item of items) {
      const itemName = item.item_data?.name || "";
      for (const v of item.item_data?.variations || []) {
        const vd = v.item_variation_data || {};
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

    let rangeStart = new Date(`${startDate}T00:00:00+09:00`);
    const now = new Date();
    if (rangeStart < now) rangeStart = now;
    const rangeEnd = new Date(`${endDate}T23:59:59+09:00`);

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

    const openSet = new Set();
    for (const a of availabilities) {
      if (!a.start_at) continue;
      const jst = new Date(new Date(a.start_at).getTime() + 9 * 60 * 60 * 1000);
      const dateStr = jst.toISOString().slice(0, 10);
      const hour    = jst.getUTCHours();
      openSet.add(`${dateStr}:${hour}`);
    }

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
    --bg:#F7F5EF;
    --white:#ffffff;
    --ink:#111111;
    --ink-soft:#333333;
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
  .note{font-size:13px;color:var(--ink);text-align:left;padding:16px 18px;background:rgba(129,216,208,0.08);border-radius:11px;margin:0 4px;line-height:1.95;border:1px solid var(--line);font-weight:500;}
  .note strong{color:var(--tiffany-ink);font-weight:700;}
  .book-link{display:block;margin:18px 4px 0;background:var(--tiffany);color:#ffffff;text-align:center;padding:18px;border-radius:12px;font-size:17px;letter-spacing:0.08em;text-decoration:none;transition:all 0.25s;font-weight:600;box-shadow:0 4px 16px rgba(129,216,208,0.45);}
  .book-link:hover{background:#6fcdc4;box-shadow:0 6px 22px rgba(129,216,208,0.55);transform:translateY(-1px);}
  .mt{background:var(--white);border:1px solid var(--line);border-radius:13px;padding:17px 17px 15px;margin:0 4px 14px;}
  .mt-ttl{font-size:14px;font-weight:700;color:var(--tiffany-ink);margin-bottom:5px;text-align:center;}
  .mt-sub{font-size:12px;color:var(--ink-soft);text-align:center;margin-bottom:14px;}
  .mt-item{display:flex;align-items:center;gap:12px;padding:11px 4px;border-bottom:1px dashed var(--line);}
  .mt-item:last-child{border-bottom:none;}
  .mt-marks{flex-shrink:0;display:flex;gap:3px;width:80px;}
  .mt-marks span{width:23px;height:23px;border-radius:50%;background:rgba(129,216,208,0.22);color:var(--tiffany-deep);display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:600;}
  .mt-name{font-size:14px;font-weight:500;flex:1;}
  .mt-time{font-size:12.5px;color:var(--ink-soft);white-space:nowrap;}
  .mt-ex{font-size:12.5px;color:var(--ink);text-align:center;margin-top:13px;line-height:1.85;padding-top:13px;border-top:1px solid var(--line);font-weight:500;}
  .mt-ex b{color:var(--tiffany-ink);font-weight:600;}
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
  <div class="mt">
    <div class="mt-ttl">メニューと空き時間の見かた</div>
    <div class="mt-sub">○がいくつ続いているかで、入れるメニューがわかります</div>
    <div class="mt-item">
      <div class="mt-marks"><span>○</span></div>
      <div class="mt-name">カット</div>
      <div class="mt-time">1時間</div>
    </div>
    <div class="mt-item">
      <div class="mt-marks"><span>○</span><span>○</span></div>
      <div class="mt-name">カット＋カラー</div>
      <div class="mt-time">2時間</div>
    </div>
    <div class="mt-item">
      <div class="mt-marks"><span>○</span><span>○</span></div>
      <div class="mt-name">カット＋パーマ</div>
      <div class="mt-time">2時間</div>
    </div>
    <div class="mt-item">
      <div class="mt-marks"><span>○</span><span>○</span><span>○</span></div>
      <div class="mt-name">カット＋カラー＋パーマ</div>
      <div class="mt-time">3時間</div>
    </div>
    <div class="mt-ex">例えば、<b>○が2つ続いている</b>時間帯なら、<br>カット＋カラーをご予約いただけます。</div>
  </div>
  <div class="note">
    ○の時間帯は、現在ご予約をお受けできる時間です。<br>
    こちらのカレンダーは<strong>約1ヶ月先まで</strong>表示しております。<br>
    なお、この空き状況には<strong>多少の時間差</strong>がございます。ご予約のお手続き中に満席となる場合がございますので、最新は下のご予約ページにてご確認ください。
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
