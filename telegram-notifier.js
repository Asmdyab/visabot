// telegram-notifier.js - Telegram notification module
// Sends messages to one or more Telegram channels when appointment is found
// Aligned with working "النسخة 8" send path: direct undici fetch to api.telegram.org

import { fetch, Agent } from 'undici';
import fs from 'fs';
import os from 'os';
import path from 'path';
import dns from 'dns';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG_FILE = path.join(__dirname, 'visa-bot-api-config.json');
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
const FAKE_ACCOUNTS_FILE = path.join(__dirname, 'accounts-fake.json');

// Prefer IPv4 — same machines often break Telegram on IPv6 (undici "fetch failed")
try { dns.setDefaultResultOrder('ipv4first'); } catch (_) {}

/**
 * Resolve api.telegram.org via network DNS (dns.resolve4), NOT OS lookup/hosts.
 * Error was: connect ECONNREFUSED 127.0.0.1:443 → hosts/proxy hijack of telegram.
 */
function telegramLookup(hostname, options, callback) {
  const host = String(hostname || '');
  if (host === 'api.telegram.org' || host.endsWith('.telegram.org')) {
    const resolver = new dns.Resolver();
    try { resolver.setServers(['8.8.8.8', '1.1.1.1', '9.9.9.9']); } catch (_) {}
    resolver.resolve4(host, (err, addresses) => {
      if (err || !addresses || !addresses.length) {
        // Last resort: system lookup (may still hit hosts)
        return dns.lookup(host, { family: 4, all: false }, callback);
      }
      const ip = addresses[0];
      if (ip === '127.0.0.1' || ip === '0.0.0.0' || String(ip).startsWith('127.')) {
        return callback(new Error(`Telegram DNS blocked/hijacked → ${ip}`));
      }
      return callback(null, ip, 4);
    });
    return;
  }
  return dns.lookup(hostname, options, callback);
}

// Dedicated dispatcher for Telegram only (does not touch bot TLS stealth / proxy agents).
// Custom lookup bypasses hosts file redirects of api.telegram.org → 127.0.0.1
const telegramDispatcher = new Agent({
  connect: {
    family: 4,
    rejectUnauthorized: false,
    timeout: 20000,
    lookup: telegramLookup
  },
  bodyTimeout: 30000,
  headersTimeout: 30000,
  keepAliveTimeout: 10000,
  keepAliveMaxTimeout: 30000
});

function asciiHeader(value, fallback) {
  const s = String(value || '').trim();
  return /^[\x20-\x7E]+$/.test(s) ? s : fallback;
}

function getBotName() {
  try {
    const fromCfg = String(loadConfig()?.ntfy?.botName || '').trim();
    if (fromCfg) return fromCfg;
  } catch (_) {}
  const envName = String(process.env.BOT_OWNER || '').trim();
  if (envName) return envName;
  return 'البوت';
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) {
    console.log('⚠️ Error loading config for Telegram');
  }
  return {};
}

function loadAccounts() {
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    }
  } catch (e) {
    console.log('⚠️ Error loading accounts for Telegram');
  }
  return [];
}

function loadFakeAccounts() {
  try {
    if (fs.existsSync(FAKE_ACCOUNTS_FILE)) {
      return JSON.parse(fs.readFileSync(FAKE_ACCOUNTS_FILE, 'utf8'));
    }
  } catch (e) {
    console.log('⚠️ Error loading fake accounts for Telegram');
  }
  return [];
}

function findAccountForTelegram(email) {
  const key = String(email || '').trim().toLowerCase();
  if (!key) return null;
  const fromMain = loadAccounts().find(a => String(a.email || '').trim().toLowerCase() === key);
  if (fromMain) return fromMain;
  return loadFakeAccounts().find(a => String(a.email || '').trim().toLowerCase() === key) || null;
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Format date/time in Africa/Cairo like: 15/07/2026 and 09:20:03.022
 */
function formatCairoDateTime(dateInput = new Date()) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;

  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Cairo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    })
      .formatToParts(safeDate)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value])
  );

  // Milliseconds from the Date object (good enough for notification precision)
  const ms = String(safeDate.getMilliseconds()).padStart(3, '0');

  const dateFound = `${parts.day}/${parts.month}/${parts.year}`;
  const timeFound = `${parts.hour}:${parts.minute}:${parts.second}.${ms}`;

  return { dateFound, timeFound };
}

/**
 * Format Cairo time like Telegram test messages: 7/6/2026, 8:52:15 AM
 */
function formatTestTimestamp(dateInput = new Date()) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;

  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Africa/Cairo',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h12'
    })
      .formatToParts(safeDate)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value])
  );

  const ampm = (parts.dayPeriod || '').toLowerCase();
  return `${parts.month}/${parts.day}/${parts.year}, ${parts.hour}:${parts.minute}:${parts.second} ${ampm}`;
}

/**
 * Available message lines (editable from the UI: edit text / add / remove / reorder)
 */
export const TELEGRAM_MESSAGE_LINE_DEFS = [
  { id: 'title', label: '🎉 Title', defaultText: '🎉 APPOINTMENT FOUND! 🎉' },
  { id: 'account', label: '📧 Account', defaultText: '📧 Account:\n{account}' },
  { id: 'for', label: '👱 For', defaultText: '👱 For: {for}' },
  { id: 'phone', label: '📱 Phone', defaultText: '📱 Phone: {phone}' },
  { id: 'office', label: '🏢 Office', defaultText: '🏢 Office: {office}' },
  { id: 'visa', label: '🛂 Visa Type', defaultText: '🛂 Visa Type: {visa}' },
  { id: 'date', label: '📅 Date Found', defaultText: '📅 Date Found: {date}' },
  { id: 'requestSent', label: '📤 Request Sent', defaultText: '📤 Request Sent: {requestSent}' },
  { id: 'responseReceived', label: '📥 Response Received', defaultText: '📥 Response Received: {responseReceived}' },
  { id: 'responseTime', label: '⚡ Response Time', defaultText: '⚡ Response Time: {responseTime}' }
];

export const TELEGRAM_MESSAGE_LINE_IDS = TELEGRAM_MESSAGE_LINE_DEFS.map(d => d.id);

const TELEGRAM_LINE_DEFAULT_TEXT = Object.fromEntries(
  TELEGRAM_MESSAGE_LINE_DEFS.map(d => [d.id, d.defaultText])
);

/** Replace {placeholder} tokens with the (already escaped) values */
function fillPlaceholders(text, ctx) {
  return String(text ?? '').replace(/\{(\w+)\}/g, (match, key) => {
    const value = ctx[key];
    return (value === undefined || value === null) ? match : value;
  });
}

/** Normalize configured lines (objects or legacy string ids) to { id, text } */
export function normalizeTelegramMessageLines(lines) {
  const input = Array.isArray(lines) ? lines : [];
  const rows = [];
  for (const item of input) {
    if (typeof item === 'string') {
      rows.push({ id: item, text: TELEGRAM_LINE_DEFAULT_TEXT[item] || '' });
    } else if (item && typeof item === 'object') {
      const text = String(item.text ?? '');
      rows.push({
        id: item.id,
        text: text || (TELEGRAM_LINE_DEFAULT_TEXT[item.id] || '')
      });
    }
  }
  return rows;
}

/**
 * Build appointment found message from the configured lines (order matters).
 * lines: array of { id, text } — text is a template with {placeholders}.
 * plainText: true → don't HTML-escape values (for WhatsApp etc.)
 */
export function buildAppointmentTelegramMessage(options = {}) {
  const {
    accountEmail = 'N/A',
    office = 'N/A',
    visaType = 'N/A',
    customerFor = '',
    customerPhone = '',
    foundAtDate = new Date(),
    requestSentDate = null,
    responseReceivedDate = null,
    responseTimeMs = null,
    lines = TELEGRAM_MESSAGE_LINE_IDS,
    plainText = false
  } = options;

  const { dateFound } = formatCairoDateTime(foundAtDate);

  const formatTimeOnly = (value) => {
    if (value === null || value === undefined || value === '') return 'N/A';
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return 'N/A';
    return formatCairoDateTime(d).timeFound;
  };

  const responseTime = (responseTimeMs != null && !Number.isNaN(Number(responseTimeMs)))
    ? `${Math.round(Number(responseTimeMs))}ms`
    : 'N/A';

  const esc = (v) => (plainText ? String(v ?? '') : escapeHtml(v));

  const ctx = {
    account: esc(accountEmail),
    for: esc(customerFor || '-'),
    phone: esc(customerPhone || '-'),
    office: esc(office),
    visa: esc(visaType),
    date: dateFound,
    requestSent: formatTimeOnly(requestSentDate),
    responseReceived: formatTimeOnly(responseReceivedDate),
    responseTime
  };

  // Skip bot/version lines — appointment alerts should not show AMR / RAHMA / WATCH DOGS etc.
  const rows = normalizeTelegramMessageLines(lines).filter(
    (r) => r.id !== 'bot' && !/\{bot\}/.test(r.text || '') && !/النسخة/.test(r.text || '')
  );
  const parts = [];
  for (const row of rows) {
    const text = row.text.trim();
    if (!text) continue;
    parts.push(fillPlaceholders(text, ctx));
  }
  if (parts.length === 0) return '';

  // Blank line after the title for readability (keeps the original look)
  if (rows[0] && rows[0].id === 'title' && parts.length > 1) {
    return `${parts[0]}\n\n${parts.slice(1).join('\n')}`;
  }
  return parts.join('\n');
}

/**
 * Normalize telegram config to a list of channels.
 * Supports legacy { botToken, chatId } and new { botToken, channels: [...] }.
 */
export function getTelegramChannels(telegramConfig = {}) {
  if (!telegramConfig) return [];

  const sharedToken = (telegramConfig.botToken || '').trim();
  const channels = Array.isArray(telegramConfig.channels) ? telegramConfig.channels : [];

  if (channels.length > 0) {
    return channels
      .map((ch, index) => ({
        name: (ch.name || `قناة ${index + 1}`).trim(),
        chatId: String(ch.chatId || '').trim(),
        botToken: String(ch.botToken || sharedToken || '').trim(),
        enabled: ch.enabled !== false
      }))
      .filter(ch => ch.chatId && ch.botToken && ch.enabled);
  }

  // Legacy single-channel config
  const legacyChatId = String(telegramConfig.chatId || '').trim();
  if (legacyChatId && sharedToken) {
    return [{
      name: 'القناة الرئيسية',
      chatId: legacyChatId,
      botToken: sharedToken,
      enabled: true
    }];
  }

  return [];
}

async function sendToChannel(botToken, chatId, text, channelName = '', parseMode = 'HTML') {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const label = channelName ? ` [${channelName}]` : '';

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: parseMode,
        disable_web_page_preview: true
      }),
      dispatcher: telegramDispatcher
    });

    const data = await response.json();

    if (data.ok) {
      return { success: true, chatId, name: channelName };
    }

    console.log(`❌ Telegram API error${label}: ${data.description}`);
    return { success: false, chatId, name: channelName, error: data.description };
  } catch (error) {
    const cause = error?.cause?.message || error?.cause?.code || '';
    const detail = cause ? `${error.message} (${cause})` : error.message;
    console.log(`❌ Error sending Telegram notification${label}: ${detail}`);
    return { success: false, chatId, name: channelName, error: detail };
  }
}

/**
 * Send notification to all configured Telegram channels
 * @param {Object} options - Notification options
 * @returns {Promise<boolean>} true if at least one channel succeeded
 */
/**
 * Send a desktop push notification via ntfy.sh
 * @returns {Promise<boolean>} true if published successfully
 */
async function sendDesktopNotificationInternal(options = {}) {
  let ntfyCfg = null;
  try {
    const cfg = loadConfig();
    const ntfyConf = cfg.ntfy;
    if (ntfyConf && ntfyConf.enabled === true) {
      const topic = String(ntfyConf.topic || '').trim();
      if (topic) {
        ntfyCfg = {
          server: String(ntfyConf.server || 'https://ntfy.sh').replace(/\/+$/, ''),
          topic,
          title: asciiHeader(ntfyConf.title, 'APPOINTMENT FOUND!')
        };
      }
    }
  } catch (_) {
    ntfyCfg = null;
  }
  if (!ntfyCfg) return false;

  const converter = new TextEncoder();
  const body = converter.encode([
    'APPOINTMENT FOUND!',
    '',
    `Bot: ${getBotName()}`,
    `Account : ${options.accountEmail || 'N/A'}`,
    `Customer: ${options.customerFor || '-'}`,
    `Phone   : ${options.customerPhone || '-'}`,
    `Office  : ${options.office || 'N/A'}`,
    `Visa    : ${options.visaType || 'N/A'}`,
    `Time    : ${options.foundAtDate ? `${formatCairoDateTime(options.foundAtDate).dateFound} ${formatCairoDateTime(options.foundAtDate).timeFound}` : (options.foundAt || '')}`,
    `Epoch   : ${options.foundAtDate ? options.foundAtDate.getTime() : Date.now()}`
  ].join('\n'));

  try {
    const response = await fetch(`${ntfyCfg.server}/${encodeURIComponent(ntfyCfg.topic)}`, {
      method: 'POST',
      headers: {
        'Priority': 'max',
        'Title': ntfyCfg.title
      },
      body
    });
    if (!response.ok) {
      console.log(`⚠️ ntfy push failed: HTTP ${response.status}`);
    }
    return response.ok;
  } catch (e) {
    console.log(`⚠️ ntfy push failed: ${e.message}`);
    return false;
  }
}

// 💓 BOT HEARTBEAT — البوت بيبعت نبضة حياة لنفس topic النتفاي أول ما يشتغل وكل 5 دقايق،
//    فتقدر من أداه START-NOTIFIER (أو تطبيق ntfy على موبايلك) تعرف إن البوت شغال ولا لأ
//    من غير ما تحتاج تدخل على جهاز صاحبك. (مفيش نبض لمدة 10 دقايق = واقف)
const HEARTBEAT_MS = (() => {
  try {
    const hb = Number(loadConfig()?.ntfy?.heartbeatMinutes);
    return (Number.isFinite(hb) && hb > 0 ? hb : 5) * 60 * 1000;
  } catch (_) { return 5 * 60 * 1000; }
})();

// 🏷️ اسم النسخة — من BOT_OWNER في ملف التشغيل أو ntfy.botName

function getLocalIp() {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces() || {})) {
    for (const n of list || []) {
      const family = String(n.family);
      if ((family === 'IPv4' || family === '4') && !n.internal && n.address) ips.push(n.address);
    }
  }
  return ips[0] || '';
}

function getGatewayIp() {
  try {
    const out = String(execSync(
      'powershell -NoProfile -Command "(Get-NetRoute -DestinationPrefix \'0.0.0.0/0\' | Sort-Object RouteMetric | Select-Object -First 1).NextHop"',
      { encoding: 'utf8', timeout: 5000, windowsHide: false }
    ) || '').trim();
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(out)) return out;
  } catch (_) {}
  return '';
}

let cachedPublicIp = '';
let cachedPublicIpAt = 0;

async function getPublicIp() {
  if (cachedPublicIp && Date.now() - cachedPublicIpAt < 10 * 60 * 1000) return cachedPublicIp;
  const urls = ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com'];
  for (const url of urls) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    try {
      const r = await fetch(url, { signal: ac.signal });
      const ip = String(await r.text() || '').trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
        cachedPublicIp = ip;
        cachedPublicIpAt = Date.now();
        return ip;
      }
    } catch (_) {
    } finally {
      clearTimeout(timer);
    }
  }
  return cachedPublicIp || '';
}

function getNtfyPublishCfg() {
  try {
    const cfg = loadConfig();
    const ntfyConf = cfg.ntfy;
    if (ntfyConf && ntfyConf.enabled === true) {
      const topic = String(ntfyConf.topic || '').trim();
      if (topic) {
        return {
          server: String(ntfyConf.server || 'https://ntfy.sh').replace(/\/+$/, ''),
          topic
        };
      }
    }
  } catch (_) {}
  return null;
}

function describeActiveMode(config = {}) {
  if (config.sequentialMode?.enabled) {
    return { mode: 'تتابعي 9ص', interval: `${Number(config.sequentialMode.delayMs) || 0}ms`, detail: config.sequentialMode.stopAtTime ? `وقف ${config.sequentialMode.stopAtTime}` : '' };
  }
  if (config.sequentialParallelMode9?.enabled) {
    return { mode: 'تتابعي متوازي 9ص', interval: `${Number(config.sequentialParallelMode9.delayMs) || 0}ms`, detail: '' };
  }
  if (config.sequentialMode2?.enabled) {
    const m = config.sequentialMode2;
    const gap = m.repeatCycles ? `${Number(m.repeatIntervalMinutes) || 0}د` : `${Number(m.delayMs) || 0}ms`;
    return { mode: 'تتابعي', interval: gap, detail: m.repeatCycles ? 'دورات متكررة' : '' };
  }
  if (config.sequentialAggressiveFakeMode?.enabled) {
    const m = config.sequentialAggressiveFakeMode;
    const offices = Array.isArray(m.offices) ? m.offices.join('+') : '';
    const visas = Array.isArray(m.visaTypes) ? m.visaTypes.length : 0;
    return { mode: 'تيست/فيك متقدم', interval: `${Number(m.delayBetweenAccountsMs) || 0}ms / دورة ${Number(m.delayBetweenCyclesMs) || 0}ms`, detail: `${offices} · ${visas} تاشيرة` };
  }
  if (config.sequentialAggressivePlusMode?.enabled) {
    const m = config.sequentialAggressivePlusMode;
    return { mode: 'عدواني متتابع متقدم', interval: `${Number(m.delayBetweenAccountsMs) || 0}ms / دورة ${Number(m.delayBetweenCyclesMs) || 0}ms`, detail: '' };
  }
  if (config.sequentialAggressiveMode?.enabled) {
    const m = config.sequentialAggressiveMode;
    return { mode: 'عدواني متتابع', interval: `${Number(m.delayBetweenAccountsMs) || 0}ms / دورة ${Number(m.delayBetweenCyclesMs) || 0}ms`, detail: '' };
  }
  if (config.parallelRoundRobinMode?.enabled || config.enableRoundRobin) {
    const sec = config.parallelRoundRobinMode?.checkIntervalSeconds || config.rrInterval || 0;
    return { mode: 'Round-Robin', interval: `${sec}ث`, detail: '' };
  }
  if (config.aggressiveMode?.enabled) {
    return { mode: 'عدواني', interval: `${Number(config.aggressiveMode.intervalSeconds) || 0}ث`, detail: `متوازي ${Number(config.aggressiveMode.parallelRequests) || 1}` };
  }
  return { mode: 'متوازي', interval: '-', detail: '' };
}

function describeCheckStart(config = {}) {
  if (config.enableScheduledCheck && config.scheduledCheckTime) return String(config.scheduledCheckTime);
  if (config.enablePerAccountStartTime) return 'وقت لكل حساب';
  return 'فوري';
}

const STRATEGY_FILE = '.last-bot-strategy.json';

/** يتنشر عند /api/start — تفاصيل النوافذ والوضع للمراقبة */
export async function publishBotStrategy(payload = {}) {
  const ntfyCfg = getNtfyPublishCfg();
  if (!ntfyCfg) return false;

  const config = payload.config || loadConfig();
  const owner = getBotName();
  const modeInfo = describeActiveMode(config);
  const windows = Array.isArray(payload.windows) ? payload.windows : [];
  const grouping = payload.perAccountWindows
    ? 'نافذة لكل حساب'
    : (payload.groupByVisaOnly || config.groupByVisaOnly ? 'نافذة لكل تأشيرة' : 'نافذة لكل مكتب+تأشيرة');

  const snapshot = {
    bot: owner,
    mode: modeInfo.mode,
    interval: modeInfo.interval,
    modeDetail: modeInfo.detail || '',
    checkStart: describeCheckStart(config),
    grouping,
    windows: windows.map((w) => ({
      office: w.office || (w.email ? 'حساب' : 'كل المكاتب'),
      visa: w.visaType || '-',
      accounts: Number(w.accounts) || (w.email ? 1 : 0),
      email: w.email || ''
    })),
    at: Date.now()
  };

  try {
    fs.writeFileSync(STRATEGY_FILE, JSON.stringify(snapshot, null, 2), 'utf8');
  } catch (_) {}

  const lines = [
    'BOT-STRATEGY',
    '',
    `Bot: ${owner}`,
    `Mode: ${snapshot.mode}`,
    `Interval: ${snapshot.interval}`,
    `ModeDetail: ${snapshot.modeDetail || '-'}`,
    `CheckStart: ${snapshot.checkStart}`,
    `Grouping: ${snapshot.grouping}`,
    `Windows: ${snapshot.windows.length}`
  ];
  snapshot.windows.forEach((w, i) => {
    const who = w.email || w.office || '-';
    lines.push(`Window${i + 1}: ${who} | ${w.visa} | ${w.accounts}`);
  });
  lines.push(`Epoch: ${snapshot.at}`);

  try {
    const response = await fetch(`${ntfyCfg.server}/${encodeURIComponent(ntfyCfg.topic)}`, {
      method: 'POST',
      headers: {
        Priority: 'default',
        Title: 'Bot strategy'
      },
      body: new TextEncoder().encode(lines.join('\n'))
    });
    return response.ok;
  } catch (_) {
    return false;
  }
}

export async function sendBotHeartbeat(stage = 'beat') {
  const ntfyCfg = getNtfyPublishCfg();
  if (!ntfyCfg) return false;

  const now = new Date();
  const isStart = stage === 'start';
  const isStop = stage === 'stop';
  const owner = getBotName();
  const title = isStop ? 'Bot stopped' : (isStart ? 'Bot started' : 'Bot heartbeat');
  const stateLine = isStop ? 'واقف' : (isStart ? 'تشغيل' : 'شغال');
  const routerIp = getGatewayIp();
  const deviceIp = getLocalIp();
  const publicIp = await getPublicIp();
  const body = new TextEncoder().encode([
    'BOT-HEARTBEAT',
    '',
    `Bot: ${owner}`,
    `الحالة: ${stateLine}`,
    `Router: ${routerIp || '-'}`,
    `Device: ${deviceIp || '-'}`,
    `Public: ${publicIp || '-'}`,
    `الوقت: ${now.toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'medium', hour12: true })}`,
    `Epoch: ${now.getTime()}`
  ].join('\n'));

  try {
    const response = await fetch(`${ntfyCfg.server}/${encodeURIComponent(ntfyCfg.topic)}`, {
      method: 'POST',
      headers: {
        'Priority': isStop ? 'high' : (isStart ? 'default' : 'low'),
        'Title': title
      },
      body
    });
    return response.ok;
  } catch (_) {
    return false;
  }
}

// تشغيل تلقائي: موقوف — user disabled all outside sends
// HEARTBEAT_ENABLED = false → موقوفة مؤقتًا عشان حد ntfy (الكود موجود، رجّع true لو حابب)
const HEARTBEAT_ENABLED = false;
try {
  const _cfg = loadConfig();
  if (HEARTBEAT_ENABLED && _cfg.ntfy && _cfg.ntfy.enabled === true) {
    sendBotHeartbeat('start');
    setInterval(() => sendBotHeartbeat('beat'), HEARTBEAT_MS);
    const stopOnce = (() => {
      let sent = false;
      return () => {
        if (sent) return;
        sent = true;
        sendBotHeartbeat('stop');
      };
    })();
    process.on('SIGINT', stopOnce);
    process.on('SIGTERM', stopOnce);
    process.on('SIGHUP', stopOnce);
    process.on('exit', stopOnce);
  }
} catch (_) {}

export async function sendTelegramNotification(options = {}) {
  // 💻 Desktop push (ntfy) - fires on every appointment, independent of Telegram
  try {
    await sendDesktopNotificationInternal(options);
  } catch (e) {
    // never let desktop push failure break the appointment flow
  }

  // 💬 WhatsApp: bot windows POST to the manager. Do not load WhatsApp Web here.
  try {
    await fetch('http://127.0.0.1:3004/api/whatsapp/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...options, _viaNotifyApi: true })
    });
  } catch (e) {
    // never let WhatsApp failure break the appointment flow
  }

  const config = loadConfig();
  const telegramConfig = config.telegram;

  if (!telegramConfig || !telegramConfig.enabled) {
    return false;
  }

  // Skip Telegram for this account if its per-account toggle is off
  // (checks accounts.json then accounts-fake.json — fake defaults to ON)
  if (options.accountEmail) {
    const account = findAccountForTelegram(options.accountEmail);
    if (account && account.telegramEnabled === false) {
      console.log(`📱 Telegram skipped for ${options.accountEmail} (إشعارات تيليجرام معطلة للحساب)`);
      return false;
    }
  }

  const channels = getTelegramChannels(telegramConfig);
  if (channels.length === 0) {
    console.log('⚠️ No valid Telegram channels configured');
    return false;
  }

  const messageLines = (Array.isArray(telegramConfig.messageLines) && telegramConfig.messageLines.length > 0)
    ? telegramConfig.messageLines
    : TELEGRAM_MESSAGE_LINE_IDS;

  let text = options.message || buildAppointmentTelegramMessage({
    accountEmail: options.accountEmail,
    office: options.office,
    visaType: options.visaType,
    customerFor: options.customerFor,
    customerPhone: options.customerPhone,
    foundAtDate: options.foundAtDate || new Date(),
    requestSentDate: options.requestSentDate,
    responseReceivedDate: options.responseReceivedDate,
    responseTimeMs: options.responseTimeMs,
    lines: messageLines
  });

  if (options.isFakeProbe) {
    text = `🧪 <b>تيست / فيك — Fake Probe</b>\n${text}`;
  }

  const results = await Promise.all(
    channels.map(ch => sendToChannel(ch.botToken, ch.chatId, text, ch.name, 'HTML'))
  );

  const successCount = results.filter(r => r.success).length;
  return successCount > 0;
}

/**
 * Send a test message to verify Telegram configuration
 * @param {Object} [override] - Optional { botToken, chatId, channels } for UI test before save
 * @returns {Promise<boolean>} Success status
 */
export async function testTelegramConnection(override = null) {
  const config = loadConfig();
  const telegramConfig = override || config.telegram;

  if (!telegramConfig || (!override && !telegramConfig.enabled)) {
    console.log('⚠️ Telegram notifications are disabled');
    return false;
  }

  const channels = getTelegramChannels(telegramConfig);
  if (channels.length === 0) {
    console.log('⚠️ No valid Telegram channels configured');
    return false;
  }

  let message;
  if (typeof telegramConfig.testMessage === 'string' && telegramConfig.testMessage.trim()) {
    message = buildAppointmentTelegramMessage({
      accountEmail: 'test@example.com',
      office: 'Cairo',
      visaType: 'Tourism Visa (C)',
      customerFor: 'Test Customer',
      customerPhone: '01000000000',
      foundAtDate: new Date(),
      lines: [{ id: 'custom', text: telegramConfig.testMessage }]
    });
  } else {
    message = `✅ Telegram Integration Test

This is a test message from Visa Bot.
Integration is working correctly!

⏰ ${formatTestTimestamp()}`;
  }

  const results = await Promise.all(
    channels.map(ch => sendToChannel(ch.botToken, ch.chatId, message, ch.name, 'HTML'))
  );

  return results.some(r => r.success);
}
