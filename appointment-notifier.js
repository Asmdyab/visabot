// appointment-notifier.js - Desktop listener + local dashboard server
// Run this on YOUR PC (the owner). It subscribes to the ntfy topic that the bot
// publishes to the moment an appointment is found, then:
//   1. Shows a Windows popup + sound (show-notification.ps1)
//   2. Feeds a professional local dashboard (notifier-dashboard.html)
//   3. When Pay now appears, sends the payable URL (ntfy + popup + dashboard)
//
// Usage:  node appointment-notifier.js
// Or use the included START-NOTIFIER.bat (opens the dashboard in your browser)

import { spawn, execSync } from 'child_process';
import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, 'visa-bot-api-config.json');
const DASHBOARD_FILE = path.join(__dirname, 'notifier-dashboard.html');
const HISTORY_FILE = path.join(__dirname, 'notifier-history.json');
const STRATEGY_LOG_FILE = path.join(__dirname, 'notifier-strategy-logs.json');
const CLEAR_STATE_FILE = path.join(__dirname, 'notifier-clear-state.json');
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
const PDF_FOLDER = path.join(__dirname, 'profile-files');
const PORT = 4185;

const IAM_BASE = 'https://egyiam.almaviva-visa.it/realms/oauth2-visaSystem-realm-pkce';
const RM_BASE = 'https://egyapi.almaviva-visa.it/reservation-manager';
const COMMON_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0'
];

function loadAccounts() {
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      const arr = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
      if (Array.isArray(arr)) return arr;
    }
  } catch (_) {}
  return [];
}
let accounts = loadAccounts();

function accountByEmail(email) {
  return accounts.find(a => String(a.email).trim().toLowerCase() === String(email).trim().toLowerCase()) || null;
}

function generateRandomString(length) {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  let result = '';
  for (let i = 0; i < length; i++) result += charset.charAt(Math.floor(Math.random() * charset.length));
  return result;
}
async function generateCodeChallenge(verifier) {
  const hash = crypto.createHash('sha256').update(verifier).digest('base64');
  return hash.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function loginAndGetToken(account) {
  const tokenUrl = `${IAM_BASE}/protocol/openid-connect/token`;
  const headers = {
    'User-Agent': COMMON_AGENTS[Math.floor(Math.random() * COMMON_AGENTS.length)],
    'Accept': 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded'
  };

  // Step 0: direct ROPC grant (fastest, may bypass OTP)
  try {
    const ropc = await fetch(tokenUrl, {
      method: 'POST',
      headers,
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'aa-visasys-public',
        username: account.email,
        password: account.password,
        scope: 'openid profile email'
      }).toString()
    });
    if (ropc.ok) {
      const data = await ropc.json();
      if (data.access_token) return { token: data.access_token, refreshToken: data.refresh_token || null };
    }
  } catch (_) {}

  // Step 1: PKCE form flow
  const state = generateRandomString(43);
  const codeVerifier = generateRandomString(43);
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const nonce = generateRandomString(43);
  const loginPageUrl = `${IAM_BASE}/protocol/openid-connect/auth?` +
    'client_id=aa-visasys-public&' +
    'redirect_uri=https://egy.almaviva-visa.it/&' +
    'response_type=code&' +
    `state=${state}&nonce=${nonce}&` +
    `code_challenge=${codeChallenge}&code_challenge_method=S256&` +
    'scope=openid%20profile%20email';

  const pageRes = await fetch(loginPageUrl, {
    headers: {
      'User-Agent': headers['User-Agent'],
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    },
    redirect: 'manual'
  });
  const cookies = (pageRes.headers.getSetCookie ? pageRes.headers.getSetCookie() : []).map(c => c.split(';')[0]).join('; ');
  const html = await pageRes.text();
  const actionMatch = html.match(/action="([^"]+)"/);
  if (!cookies || !actionMatch) return null;
  let actionUrl = actionMatch[1].replace(/&amp;/g, '&');
  if (!actionUrl.startsWith('http')) actionUrl = `https://egyiam.almaviva-visa.it${actionUrl}`;

  const loginRes = await fetch(actionUrl, {
    method: 'POST',
    headers: {
      'User-Agent': headers['User-Agent'],
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookies,
      'Origin': 'https://egyiam.almaviva-visa.it',
      'Referer': loginPageUrl
    },
    body: new URLSearchParams({ username: account.email, password: account.password, credentialId: '' }).toString(),
    redirect: 'manual'
  });
  if (loginRes.status !== 302) return null;
  const location = loginRes.headers.get('location');
  const codeMatch = location ? location.match(/code=([^&]+)/) : null;
  if (!codeMatch) return null;

  const tokenRes = await fetch(tokenUrl, {
    method: 'POST',
    headers,
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: codeMatch[1],
      redirect_uri: 'https://egy.almaviva-visa.it/',
      client_id: 'aa-visasys-public',
      code_verifier: codeVerifier
    }).toString()
  });
  if (!tokenRes.ok) return null;
  const data = await tokenRes.json();
  if (!data.access_token) return null;
  return { token: data.access_token, refreshToken: data.refresh_token || null };
}

// ---------- Config ----------
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      let raw = fs.readFileSync(CONFIG_FILE, 'utf8');
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
      return JSON.parse(raw);
    }
  } catch (e) {}
  return {};
}

function ensureNtfyConfig(cfg) {
  const ntfy = (cfg.ntfy && typeof cfg.ntfy === 'object') ? { ...cfg.ntfy } : {};
  // Respect user choice: never force-enable. Only fill defaults, never flip enabled to true.
  if (ntfy.enabled !== true && ntfy.enabled !== false) {
    ntfy.enabled = false;
  }
  let changed = false;
  if (!String(ntfy.server || '').trim()) {
    ntfy.server = 'https://ntfy.sh';
    changed = true;
  }
  if (!String(ntfy.topic || '').trim()) {
    // لو التوبيك فاضي متولّدش توبيك جديد لو في إعدادات تانية ناقصة — استخدم الثابت المشترك
    ntfy.topic = 'almaviva-55665b51c2eeb5f99ea9e6bb';
    changed = true;
  }
  if (!ntfy.title) {
    ntfy.title = 'APPOINTMENT FOUND!';
    changed = true;
  }
  if (changed) {
    cfg.ntfy = ntfy;
    try {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
      console.log('✅ ntfy config defaults saved in visa-bot-api-config.json (enabled=false, local-only)');
    } catch (e) {
      console.log('⚠️ Could not save ntfy config:', e.message);
    }
  }
  return ntfy;
}

const config = loadConfig();
const ntfy = ensureNtfyConfig(config);

const NTFY_DISABLED = ntfy.enabled !== true;
const SERVER = String(ntfy.server || 'https://ntfy.sh').replace(/\/+$/, '');
const TOPIC = String(ntfy.topic || '').trim();
if (!TOPIC && !NTFY_DISABLED) {
  console.log('❌ No ntfy topic configured in visa-bot-api-config.json');
  process.exit(1);
}
if (NTFY_DISABLED) {
  console.log('🔕 ntfy disabled — local-only mode, no outside sends.');
}

// ---------- Bot status (heartbeat) ----------
// كل نسخة بوت بيبعت رسالة BOT-HEARTBEAT عليها `Bot: <اسمها>` لنفس الـ topic أول ما يشتغل
// وكل 5 دقايق. هنا بنحتفظ بحالة كل بوت لوحده، وبنبلغ الـ topic (وبوب-أب) أول ما أي بوت
// يوقف أو يرجع — فتقدر تراقب بوت 1 وبوت 2 (وأي عدد) من بعيد حتى من غير ما تدخل على أجهزتهم.
const botStatuses = {}; // اسم البوت -> { state, lastAt, offlineSince, onlineAt }
const botStateNotified = {}; // اسم البوت -> 'offline' | 'online'
const HEARTBEAT_OFFLINE_MS = (() => {
  const v = Number(config.ntfy && config.ntfy.heartbeatOfflineMinutes);
  return (Number.isFinite(v) && v > 0 ? v : 12) * 60 * 1000;
})();

function botKey(name) {
  const n = String(name || '').trim();
  return n || 'البوت';
}

function ensureBot(name) {
  const k = botKey(name);
  if (!botStatuses[k]) botStatuses[k] = { state: 'unknown', lastAt: 0, offlineSince: null, onlineAt: 0, routerIp: '', deviceIp: '', publicIp: '', strategy: null };
  return botStatuses[k];
}

['WATCH DOGS TEAM', 'AMR', 'ALY', 'RAHMA'].forEach((n) => ensureBot(n));

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

function isPrivateIp(ip) {
  return /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(String(ip || ''));
}

let cachedPublicIp = '';
async function refreshPublicIp() {
  const urls = ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com'];
  for (const url of urls) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    try {
      const r = await fetch(url, { signal: ac.signal });
      const ip = String(await r.text() || '').trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
        cachedPublicIp = ip;
        const localName = botKey(ntfy.botName || config.ntfy && config.ntfy.botName);
        if (localName && localName !== 'البوت') {
          const s = ensureBot(localName);
          s.deviceIp = getLocalIp() || s.deviceIp;
          s.routerIp = getGatewayIp() || s.routerIp;
          s.publicIp = cachedPublicIp;
        }
        return;
      }
    } catch (_) {
    } finally {
      clearTimeout(timer);
    }
  }
}
refreshPublicIp();
setInterval(refreshPublicIp, 10 * 60 * 1000);

function touchBotHeartbeat(name, epochMs, extra = {}) {
  const k = botKey(name);
  const s = ensureBot(k);
  const at = epochMs > 0 ? epochMs : Date.now();
  const wasOffline = s.state === 'offline';
  s.state = 'online';
  s.lastAt = at;
  s.offlineSince = null;
  if (!s.onlineAt) s.onlineAt = at;
  if (extra.routerIp) s.routerIp = extra.routerIp;
  if (extra.deviceIp) s.deviceIp = extra.deviceIp;
  if (extra.publicIp) s.publicIp = extra.publicIp;
  return wasOffline;
}

function markBotOffline(name) {
  const k = botKey(name);
  if (!k || k === 'البوت') return;
  const s = ensureBot(k);
  s.state = 'offline';
  s.offlineSince = Date.now();
}

function liveBots() {
  const now = Date.now();
  const localName = botKey(ntfy.botName || (config.ntfy && config.ntfy.botName));
  if (localName && localName !== 'البوت') {
    const local = ensureBot(localName);
    local.deviceIp = getLocalIp() || local.deviceIp;
    local.routerIp = getGatewayIp() || local.routerIp;
    if (cachedPublicIp) local.publicIp = cachedPublicIp;
  }
  const out = {};
  for (const [k, s] of Object.entries(botStatuses)) {
    const silentFor = s.lastAt > 0 ? now - s.lastAt : Infinity;
    const online = s.state !== 'offline' && s.lastAt > 0 && silentFor <= HEARTBEAT_OFFLINE_MS;
    out[k] = { ...s, state: online ? 'online' : 'offline' };
  }
  return out;
}

async function publishBotState(name, state, extraLine) {
  if (NTFY_DISABLED) return;
  try {
    const k = botKey(name);
    const s = ensureBot(k);
    const now = new Date();
    const isOffline = state === 'offline';
    const body = new TextEncoder().encode([
      isOffline ? `🔴 BOT-STATUS:OFFLINE — ${k} واقف!` : `🟢 BOT-STATUS:ONLINE — ${k} رجع شغال!`,
      '',
      `Bot: ${k}`,
      `الحالة: ${isOffline ? 'واقف' : 'شغال'}`
    ].concat(
      s.lastAt ? [`آخر نبض: ${cairoNow(s.lastAt)}`] : [],
      extraLine ? [extraLine] : [],
      [`Epoch: ${now.getTime()}`]
    ).join('\n'));
    await fetch(`${SERVER}/${encodeURIComponent(TOPIC)}`, {
      method: 'POST',
      headers: {
        'Priority': 'high',
        'Title': isOffline ? `🔴 ${k} واقف!` : `🟢 ${k} شغال`
      },
      body
    });
  } catch (_) {}
}

function onBotBackOnline(name) {
  const k = botKey(name);
  botStateNotified[k] = 'online';
  publishBotState(k, 'online');
  showPopup(`🟢 ${k} رجع شغال!`, cairoNow());
}

async function checkBotHeartbeat() {
  for (const k of Object.keys(botStatuses)) {
    const s = botStatuses[k];
    if (s.state === 'unknown') continue;
    const now = Date.now();
    const silentFor = now - s.lastAt;
    if (s.state === 'online' && silentFor > HEARTBEAT_OFFLINE_MS) {
      s.state = 'offline';
      s.offlineSince = now;
      if (botStateNotified[k] !== 'offline') {
        botStateNotified[k] = 'offline';
        const mins = Math.max(1, Math.round(silentFor / 60000));
        await publishBotState(k, 'offline', `مفيش نبض من ${mins} دقيقة`);
        showPopup(`🔴 ${k} واقف!`, `آخر نبض كان: ${cairoNow(s.lastAt)}`);
      }
    } else if (s.state === 'offline' && now - s.lastAt <= HEARTBEAT_OFFLINE_MS) {
      s.state = 'online';
      if (botStateNotified[k] !== 'online') onBotBackOnline(k);
    }
  }
}

// فحص دوري كل 20 ثانية (مفيش نبض 10 دقايق = البوت واقف)
setInterval(checkBotHeartbeat, 20000);

// ---------- Event history ----------
let events = [];
let serial = 0;
let profiles = {};
let clearedAt = 0;
let strategyClearedAt = 0;
try {
  if (fs.existsSync(CLEAR_STATE_FILE)) {
    const st = JSON.parse(fs.readFileSync(CLEAR_STATE_FILE, 'utf8'));
    clearedAt = Number(st.clearedAt) || 0;
    strategyClearedAt = Number(st.strategyClearedAt) || 0;
  }
} catch (_) {}
try {
  if (fs.existsSync(HISTORY_FILE)) {
    const saved = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    if (Array.isArray(saved)) events = saved;
    else if (Array.isArray(saved.events)) events = saved.events;
    if (saved.profiles && typeof saved.profiles === 'object') profiles = saved.profiles;
    if (Number(saved.clearedAt) > clearedAt) clearedAt = Number(saved.clearedAt);
    events = events.map((e) => {
      const ts = Number(e && e.ts);
      if (!Number.isFinite(ts) || ts <= 0) return e;
      return { ...e, time: cairoNow(ts) };
    });
    if (clearedAt > 0) {
      events = events.filter((e) => !(e.ts > 0 && e.ts <= clearedAt));
    }
  }
} catch (_) {}

function persistClearState() {
  try {
    fs.writeFileSync(CLEAR_STATE_FILE, JSON.stringify({ clearedAt, strategyClearedAt }, null, 2), 'utf8');
  } catch (_) {}
}

function persistHistory() {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify({
      events: events.slice(0, 100),
      profiles,
      clearedAt
    }, null, 2), 'utf8');
  } catch (_) {}
}

// ---------- Strategy / log-window rows (manual clear only) ----------
let strategyLogs = [];
let strategySerial = 0;
try {
  if (fs.existsSync(STRATEGY_LOG_FILE)) {
    const saved = JSON.parse(fs.readFileSync(STRATEGY_LOG_FILE, 'utf8'));
    if (Array.isArray(saved)) strategyLogs = saved;
    else if (Array.isArray(saved.logs)) strategyLogs = saved.logs;
    if (Number(saved.strategyClearedAt) > strategyClearedAt) strategyClearedAt = Number(saved.strategyClearedAt);
    if (strategyClearedAt > 0) {
      strategyLogs = strategyLogs.filter((r) => !(r.ts > 0 && r.ts <= strategyClearedAt));
    }
  }
} catch (_) {}

function persistStrategyLogs() {
  try {
    fs.writeFileSync(STRATEGY_LOG_FILE, JSON.stringify({
      logs: strategyLogs.slice(0, 500),
      strategyClearedAt
    }, null, 2), 'utf8');
  } catch (_) {}
}

function officeLabel(office) {
  const o = String(office || '').trim();
  if (/alex/i.test(o)) return 'إسكندرية';
  if (/cairo/i.test(o)) return 'القاهرة';
  if (!o || o === '-' || o === 'كل المكاتب') return 'كل المراكز';
  if (o === 'حساب') return 'حساب منفصل';
  return o;
}

function appendStrategyWindows(botName, meta, windows) {
  const at = meta.at || Date.now();
  if (strategyClearedAt > 0 && at <= strategyClearedAt) return 0;
  const modeText = [meta.mode || '-', meta.interval || '', meta.modeDetail && meta.modeDetail !== '-' ? meta.modeDetail : '']
    .filter(Boolean)
    .join(' · ');
  const list = (windows && windows.length) ? windows : [{ office: '-', visa: '-', accounts: 0 }];
  let added = 0;
  for (const w of list) {
    const row = {
      id: `${botName}|${at}|${w.office}|${w.visa}|${w.accounts || 0}`,
      bot: botName,
      checkStart: meta.checkStart || '-',
      mode: modeText,
      visa: w.visa || '-',
      office: officeLabel(w.office),
      accounts: Number(w.accounts) || 0,
      ts: at,
      time: cairoNow(at)
    };
    if (strategyLogs.some((x) => x.id === row.id)) continue;
    strategyLogs.unshift(row);
    added++;
  }
  if (added) {
    if (strategyLogs.length > 500) strategyLogs.length = 500;
    strategySerial++;
    persistStrategyLogs();
  }
  return added;
}

function profileFor(account, foundAtMs = null) {
  const email = String(account || '').trim();
  if (!email) return null;
  if (!profiles[email]) {
    profiles[email] = { account: email, foundAt: (foundAtMs || 0) > 0 ? foundAtMs : Date.now(), payAt: null, pdfAt: null, monitor: null, monitorEnabled: false };
  }
  return profiles[email];
}

// ---------- Profile API monitoring (reservation-manager) ----------
// For every account that found an appointment, this module logs in with that
// account's own credentials (accounts.json next to the notifier), then polls the
// visa-applications API to detect when the pay button appears and when PDFs get
// downloadable, and records that state on the profile for the dashboard.
let monitoredProfiles = {}; // email -> { token, tokenAt, expiresIn, busy, lastPoll }

function apiHeaders(token) {
  return {
    'Host': 'egyapi.almaviva-visa.it',
    'Accept': 'application/json, text/plain, */*',
    'User-Agent': COMMON_AGENTS[Math.floor(Math.random() * COMMON_AGENTS.length)],
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://egy.almaviva-visa.it',
    'Sec-Fetch-Site': 'same-site',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    'Referer': 'https://egy.almaviva-visa.it/',
    'Accept-Encoding': 'gzip, deflate, br',
    'Priority': 'u=1, i',
    'Authorization': `Bearer ${token}`
  };
}

async function apiRequest(path, email, options = {}) {
  const token = await getApiToken(email);
  if (!token) return null;
  const res = await fetch(`${RM_BASE}${path}`, {
    method: options.method || 'GET',
    headers: apiHeaders(token),
    body: options.body,
    signal: options.signal
  });
  if (res.status === 401) {
    // token expired -> clear cache and try once with a fresh login
    monitoredProfiles[email].token = null;
    const token2 = await getApiToken(email);
    if (!token2) return null;
    const retry = await fetch(`${RM_BASE}${path}`, {
      method: options.method || 'GET',
      headers: apiHeaders(token2),
      body: options.body,
      signal: options.signal
    });
    return { status: retry.status, res: retry };
  }
  return { status: res.status, res };
}

async function getApiToken(email) {
  const acc = accountByEmail(email);
  if (!acc) return null;
  let mon = monitoredProfiles[email];
  if (!mon) mon = monitoredProfiles[email] = { token: null, tokenAt: 0, expiresIn: 0, busy: false, lastPoll: 0 };
  const ttl = mon.expiresIn ? mon.expiresIn * 1000 - 60000 : 5 * 60 * 1000;
  if (mon.token && mon.tokenAt && Date.now() - mon.tokenAt < ttl) return mon.token;
  const t = await loginAndGetToken(acc);
  if (t) {
    mon.token = t.token;
    mon.tokenAt = Date.now();
    mon.expiresIn = t.expiresIn || 300;
  }
  return mon.token || null;
}

// Defensive deep-scan: pull every `id` / `$id` / `applicationId` style value from a JSON body.
function extractAppIds(body) {
  const ids = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const cand = node.id ?? node.applicationId ?? node.visaApplicationId ?? node.appId ?? null;
    if (cand && !ids.includes(cand)) ids.push(cand);
    for (const k of Object.keys(node)) walk(node[k]);
  };
  walk(body);
  return ids;
}

async function monitorProfile(email) {
  const profile = profileFor(email);
  let mon = monitoredProfiles[email];
  if (!mon) mon = monitoredProfiles[email] = { token: null, tokenAt: 0, expiresIn: 0, busy: false, lastPoll: 0 };
  if (mon.busy) return profile;
  mon.busy = true;
  try {
    const account = accountByEmail(email);
    if (!account) {
      profile.monitor = { ok: false, error: 'الحساب غير موجود في accounts.json' };
      return profile;
    }
    profile.monitor = { ok: true, polling: true, lastPoll: Date.now() };
    const active = await apiRequest('/api/visa-applications/v1/active', email);
    if (!active) {
      profile.monitor = { ok: false, error: 'فشل تسجيل الدخول — راجع بيانات الحساب' };
      return profile;
    }
    if (active.status === 404 || active.status >= 500) {
      const snap = await safeJson(active.res);
      profile.monitor = { ok: false, error: `الـ API رد ${active.status}`, status: active.status, raw: trimSnapshot(snap) };
      return profile;
    }
    const body = active.status === 200 ? await active.res.json().catch(() => null) : null;
    if (body) profile.monitor.raw = trimSnapshot(body);
    const ids = extractAppIds(body);

    let payReady = false;
    let payAmount = null;
    let pdfReady = false;

    // The active-application object (single object or {data:[...]}) exposes the real flags:
    //   canPayVideocall: true   -> the Pay (checkout) button is shown
    //   paymentLink: <url>      -> the same URL you get from right-click → Copy link
    //   hasPayed: true          -> already paid
    const actObj = Array.isArray(body) ? body[0] : (body?.data ? body.data[0] : body);
    if (actObj && typeof actObj === 'object') {
      const canPay = actObj.canPayVideocall === true || actObj.canPay === true;
      const hasPaid = actObj.hasPayed === true || actObj.paid === true || actObj.isPaid === true;
      const directLink = actObj.paymentLink || actObj.checkoutUrl || null;
      if (!hasPaid && (canPay || directLink)) {
        payReady = true;
        profile.appId = actObj.id || ids[0] || null;
        if (directLink) profile.payLink = directLink;
        if (actObj.id) {
          profile.payEndpoint = `${RM_BASE}/api/visa-applications/v1/${actObj.id}/videocall-pay`;
        }
      }
    }

    if (payReady) {
      profile.appId = actObj?.id || ids[0] || profile.appId || null;
      if (!profile.payAt) profile.payAt = Date.now();
      if (payAmount) profile.payAmount = payAmount;
      if (!profile.payLinkSent || !profile.payLink) {
        try {
          let url = profile.payLink || null;
          if (!url) {
            const built = await buildPayLink(email);
            if (built && built.ok) url = built.url;
          }
          if (url) {
            profile.payLink = url;
            profile.payLinkSent = true;
            profile.payLinkSentAt = Date.now();
            persistHistory();
            await publishPayLink(email, url);
          }
        } catch (_) {}
      }
    }

    // Check downloadable PDFs
    for (const id of ids.slice(0, 3)) {
      const kind = [
        `/api/visa-applications/v1/${id}/reports/payment-receipt`,
        `/api/visa-applications/v1/${id}/reports/summary-reservation`
      ];
      for (const p of kind) {
        const r = await apiRequest(p, email);
        if (r && (r.status === 200 || r.status === 201)) {
          const ctype = r.res.headers.get('content-type') || '';
          const buf = await r.res.arrayBuffer().catch(() => null);
          if (buf && buf.byteLength > 0 && ctype.includes('pdf')) {
            pdfReady = true;
            if (!profile.pdfAt) {
              const saved = await saveProfilePdf(email, id, p, buf);
              profile.pdfAt = Date.now();
              profile.pdfFile = saved;
            }
          }
        }
      }
    }

    const lastRaw = profile.monitor?.raw || null;
    mon.lastPoll = Date.now();
    profile.monitor = {
      ok: true,
      polling: true,
      lastPoll: mon.lastPoll,
      payReady,
      payAmount,
      pdfReady,
      status: active.status,
      appIds: ids.slice(0, 5),
      raw: body ? trimSnapshot(body) : lastRaw
    };
    persistHistory();
  } catch (e) {
    profile.monitor = { ok: false, error: e.message };
    persistHistory();
  } finally {
    mon.busy = false;
  }
  return profile;
}

async function safeJson(res) {
  try {
    const t = await res.text();
    try { return JSON.parse(t); } catch (_) { return { text: t.slice(0, 500) }; }
  } catch (_) { return null; }
}

function trimSnapshot(v) {
  try {
    const s = JSON.stringify(v);
    return s.length > 1200 ? s.slice(0, 1200) + '…' : s;
  } catch (_) { return String(v).slice(0, 1200); }
}

async function saveProfilePdf(email, appId, pdfPath, buf) {
  try {
    if (!fs.existsSync(PDF_FOLDER)) fs.mkdirSync(PDF_FOLDER, { recursive: true });
    const folder = path.join(PDF_FOLDER, email.replace(/[^a-zA-Z0-9._-]/g, '_'));
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
    const name = `${appId}_${Date.now()}${pdfPath.includes('summary') ? '_summary' : '_receipt'}.pdf`;
    const file = path.join(folder, name);
    fs.writeFileSync(file, Buffer.from(buf));
    return path.relative(PDF_FOLDER, file).split(path.sep).join('/');
  } catch (_) { return null; }
}

// Poll every tracked profile every POLL_MS (only accounts that exist in accounts.json AND
// have monitoring explicitly enabled by the user via the dashboard)
const PROFILE_POLL_MS = 30000;
async function pollProfiles() {
  for (const email of Object.keys(profiles)) {
    const prof = profiles[email];
    if (!prof || prof.monitorEnabled !== true) continue;
    const mon = monitoredProfiles[email];
    if (mon && mon.busy) continue;
    if (mon && mon.lastPoll && Date.now() - mon.lastPoll < PROFILE_POLL_MS) continue;
    if (!accountByEmail(email)) continue;
    try { await monitorProfile(email); } catch (_) {}
  }
}
setInterval(pollProfiles, PROFILE_POLL_MS);

function cairoNow(givenTs) {
  const d = new Date(givenTs || Date.now());
  if (Number.isNaN(d.getTime())) return '';
  const date = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Cairo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).format(d);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Cairo',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(d).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value])
  );
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${date} ${parts.hour}:${parts.minute}:${parts.second}.${ms}`;
}

async function publishPayLink(email, payUrl) {
  const url = String(payUrl || '').trim();
  if (!url) return;
  if (NTFY_DISABLED) {
    // Local-only: popup + dashboard, no outside publish.
    showPopup('💳 ظهر الدفع — افتح اللينك وادفع من أي جهاز', `${email}\n${url}`);
    console.log(`💳 Pay link (local-only) for ${email}: ${url}`);
    return;
  }
  try {
    const body = [
      'PAY-LINK: ظهر زر الدفع',
      '',
      `Account: ${email}`,
      `Pay: ${url}`,
      `Epoch: ${Date.now()}`
    ].join('\n');
    await fetch(`${SERVER}/${encodeURIComponent(TOPIC)}`, {
      method: 'POST',
      headers: {
        'Priority': 'urgent',
        'Title': `💳 ادفع الآن — ${email}`,
        'Click': url,
        'Actions': `view, افتح الدفع, ${url}, clear=true`
      },
      body
    });
  } catch (_) {}
  showPopup('💳 ظهر الدفع — افتح اللينك وادفع من أي جهاز', `${email}\n${url}`);
  console.log(`💳 Pay link sent for ${email}: ${url}`);
}

// Ask the reservation-manager to start a Mastercard checkout for the account's application,
// then build the full gateway URL (the same link the site's Pay button would open).
async function buildPayLink(email) {
  const profile = profileFor(email);
  const token = await getApiToken(email);
  if (!token) return { ok: false, error: 'فشل تسجيل الدخول بالحساب' };
  if (profile && profile.payLink) return { ok: true, url: profile.payLink };

  let endpoint = profile && profile.payEndpoint;
  if (!endpoint) {
    const active = await apiRequest('/api/visa-applications/v1/active', email);
    const body = active && active.status === 200 ? await active.res.json().catch(() => null) : null;
    const ids = extractAppIds(body);
    if (!ids.length) return { ok: false, error: 'مفيش تطبيق نشط للدفع', raw: trimSnapshot(body) };
    profile.appId = ids[0];
    endpoint = `${RM_BASE}/api/visa-applications/v1/${ids[0]}/videocall-pay`;
    profile.payEndpoint = endpoint;
  }

  // The checkout (videocall-pay) endpoint is POST-only on the server (GET -> 500 "not supported").
  const postRes = await fetch(endpoint, {
    method: 'POST',
    headers: { ...apiHeaders(token), 'Content-Type': 'application/json' },
    body: '{}',
    redirect: 'manual'
  });
  let res = postRes;
  if (postRes.status === 405 || (postRes.status === 400 && /method.*(get|post)/i.test(await postRes.text().catch(() => '')))) {
    res = await fetch(endpoint, { headers: apiHeaders(token), redirect: 'manual' });
  }
  if (!res.ok && res.status !== 302 && res.status !== 303 && res.status !== 307) {
    const body = await safeJson(res);
    const errText = (body && body.text) || (body && body.message) || (body && body.error) || JSON.stringify(body);
    return { ok: false, error: `checkout رد ${res.status} — ${String(errText).slice(0, 160)}`, raw: trimSnapshot(body) };
  }

  const loc = res.headers.get('location');
  if (loc && /mastercard\.com|paymentLink|checkout/i.test(loc)) {
    profile.payLink = loc;
    persistHistory();
    return { ok: true, url: loc };
  }

  let text = '';
  try { text = await res.text(); } catch (_) {}
  const fetched = { text };
  const sessionMatch = (text.match(/SESSION[A-Za-z0-9]+/) || text.match(/session["'\\s:=]+([A-Za-z0-9]{10,})/i))?.[0]?.replace(/^[^A-Za-z0-9]+/, '') || null;
  let sessionId = sessionMatch;
  try {
    const j = JSON.parse(text);
    const data = j?.data ?? j?.payment ?? j?.session ?? j;
    sessionId = sessionId || data?.sessionId || data?.session || data?.id || data?.token || j?.sessionId || j?.token || null;
    const maybeUrl = data?.paymentLink || data?.url || data?.checkoutUrl || j?.paymentLink || j?.url;
    if (typeof maybeUrl === 'string' && maybeUrl.startsWith('http')) {
      profile.payLink = maybeUrl;
      persistHistory();
      return { ok: true, url: maybeUrl };
    }
  } catch (_) {}
  if (!sessionId) {
    return { ok: false, error: 'الـ checkout أربطش session', raw: trimSnapshot(fetched) };
  }
  const url = `https://eu.gateway.mastercard.com/checkout/pay/${sessionId}?checkoutVersion=1.0.0`;
  profile.payLink = url;
  persistHistory();
  return { ok: true, url };
}

// ---------- Dashboard HTTP server ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = (req.url || '/').split('?')[0];

    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.existsSync(DASHBOARD_FILE) ? fs.readFileSync(DASHBOARD_FILE) : '<h1>Dashboard file missing</h1>');
      return;
    }

    if (url === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
res.end(JSON.stringify({
        events, listening, serial, profiles,
        bots: liveBots(),
        strategyLogs,
        strategySerial
      }));
      return;
    }

    if (url === '/api/status' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');
      const email = String(parsed.account || '').trim();
      const type = String(parsed.type || '').trim();
      const profile = profileFor(email);
      if (!profile || !['pay', 'pdf'].includes(type)) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'invalid account or type' }));
        return;
      }
      if (type === 'pay') profile.payAt = Date.now();
      if (type === 'pdf') profile.pdfAt = Date.now();
      persistHistory();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, profile }));
      return;
    }

    if (url === '/api/pay' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');
      const email = String(parsed.account || '').trim();
      const result = await buildPayLink(email);
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
      return;
    }

    if (url === '/api/delete-profile' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');
      const email = String(parsed.account || '').trim();
      const existed = Object.prototype.hasOwnProperty.call(profiles, email);
      if (existed) delete profiles[email];
      if (monitoredProfiles[email]) delete monitoredProfiles[email];
      try {
        const folder = path.join(PDF_FOLDER, email.replace(/[^a-zA-Z0-9._-]/g, '_'));
        if (fs.existsSync(folder)) fs.rmSync(folder, { recursive: true, force: true });
      } catch (_) {}
      serial++;
      persistHistory();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, deleted: existed, serial }));
      return;
    }

    if (url === '/api/toggle-monitor' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');
      const email = String(parsed.account || '').trim();
      const profile = profileFor(email);
      if (!profile) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'invalid account' }));
        return;
      }
      profile.monitorEnabled = !profile.monitorEnabled;
      if (profile.monitorEnabled) {
        // kick off an immediate poll when starting
        monitorProfile(email).catch(() => {});
      }
      persistHistory();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, monitorEnabled: profile.monitorEnabled }));
      return;
    }

    if (url === '/api/refresh-profile' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');
      const email = String(parsed.account || '').trim();
      const profile = profileFor(email);
      if (!profile) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'invalid account' }));
        return;
      }
      await monitorProfile(email);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, profile }));
      return;
    }

    if (url === '/api/profile-files') {
      const files = [];
      const scan = (dir) => {
        if (!fs.existsSync(dir)) return;
        for (const name of fs.readdirSync(dir)) {
          const full = path.join(dir, name);
          const stat = fs.statSync(full);
          if (stat.isDirectory()) scan(full);
          else if (name.endsWith('.pdf')) files.push(full);
        }
      };
      scan(PDF_FOLDER);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ files }));
      return;
    }

    if (url.startsWith('/dl/')) {
      const rel = decodeURIComponent(url.slice(4));
      const safe = path.resolve(PDF_FOLDER, rel);
      if (!safe.startsWith(path.resolve(PDF_FOLDER)) || !fs.existsSync(safe)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${path.basename(safe)}"`
      });
      res.end(fs.readFileSync(safe));
      return;
    }

    if (url === '/api/test' && req.method === 'POST') {
      serial++;
      const entry = makeEvent('test-notify@bot.local', 'عميل تجريبي', '01000000000', '—', '—');
      events.unshift(entry);
      serial++;
      profileFor(entry.account);
      persistHistory();
      showPopup('🚨 معاد جديد (تجريبي)', entry.rawText);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url === '/api/clear' && req.method === 'POST') {
      events = [];
      profiles = {};
      monitoredProfiles = {};
      serial++;
      clearedAt = Date.now();
      persistClearState();
      persistHistory();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, cleared: true, serial, clearedAt }));
      return;
    }

    if (url === '/api/clear-strategy' && req.method === 'POST') {
      strategyLogs = [];
      strategySerial++;
      strategyClearedAt = Date.now();
      persistClearState();
      persistStrategyLogs();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, cleared: true, strategySerial, strategyClearedAt }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Server error');
  }
});

server.listen(PORT, () => {
  console.log(`🖥️  Dashboard: http://localhost:${PORT}`);
});

// ---------- ntfy listener ----------
let listening = false;
const REQUEST_TIMEOUT_MS = 90000;

let replayDone = false;
async function listen() {
  while (true) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const since = replayDone ? '' : '?since=30m';
      replayDone = true;

      const response = await fetch(`${SERVER}/${encodeURIComponent(TOPIC)}/json${since}`, {
        headers: { 'Accept': 'application/json' },
        signal: controller.signal
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      clearTimeout(timer);
      listening = true;
      console.log('✅ Connected. Waiting for appointment notifications...');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIdx;
        while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (!line) continue;
          const data = line.startsWith('data:') ? line.slice(5).trim() : line;
          handleEvent(data);
        }
      }
    } catch (e) {
      listening = false;
      if (e.name === 'AbortError') {
        console.log('⏱️  Reconnecting (no data for a while)...');
      } else {
        console.log(`⚠️ Connection lost (${e.message}). Reconnecting in 5s...`);
      }
    }
    await new Promise(r => setTimeout(r, 5000));
  }
}

// ---------- Event parsing ----------
function makeEvent(account, customer, phone, office, visa, rawText = '', epochMs = null, timeText = '', bot = null) {
  const hasEpoch = Number.isFinite(epochMs) && epochMs > 0;
  const ts = hasEpoch ? epochMs : Date.now();
  return {
    time: hasEpoch ? cairoNow(ts) : (timeText || cairoNow()),
    ts,
    account, customer, phone, office, visa, bot,
    rawText
  };
}

function handleEvent(rawData) {
  try {
    const data = JSON.parse(rawData);
    const text = data.message || data.title || '';
    if (!text) return;

    // 📋 استراتيجية التشغيل من المانيجر بعد /api/start — سطر لكل لوج (مش بيتمسح غير يدوي)
    if (text.includes('BOT-STRATEGY')) {
      const bm = text.match(/Bot\s*:\s*([^\n]+)/);
      const botName = bm ? bm[1].trim() : '';
      if (!botName || botName === 'البوت') return;
      const get = (key) => {
        const m = text.match(new RegExp(key + '\\s*:\\s*([^\\n]+)'));
        return m ? m[1].trim() : '';
      };
      const windows = [];
      const winRe = /Window\d+\s*:\s*([^\n|]+)\s*\|\s*([^\n|]+)\s*\|\s*(\d+)/g;
      let wm;
      while ((wm = winRe.exec(text)) !== null) {
        windows.push({
          office: wm[1].trim(),
          visa: wm[2].trim(),
          accounts: parseInt(wm[3], 10) || 0
        });
      }
      const meta = {
        mode: get('Mode') || '-',
        interval: get('Interval') || '-',
        modeDetail: get('ModeDetail') || '',
        checkStart: get('CheckStart') || '-',
        grouping: get('Grouping') || '-',
        at: parseInt(get('Epoch') || '', 10) || Date.now()
      };
      if (strategyClearedAt > 0 && meta.at <= strategyClearedAt) {
        touchBotHeartbeat(botName, meta.at);
        return;
      }
      const s = ensureBot(botName);
      s.strategy = { ...meta, windows };
      appendStrategyWindows(botName, meta, windows);
      touchBotHeartbeat(botName, meta.at);
      return;
    }

    // 💓 نبضة حياة من البوت — بتحدث حالة البوت اللي اسمها من غير ما تظهر كإشعار معاد
    if (text.includes('BOT-HEARTBEAT')) {
      const m = text.match(/Epoch\s*:\s*(\d+)/);
      const epoch = m ? parseInt(m[1], 10) : 0;
      const bm = text.match(/Bot\s*:\s*([^\n]+)/);
      const botName = bm ? bm[1].trim() : '';
      if (!botName || botName === 'البوت') return;
      if (/الحالة\s*:\s*واقف/.test(text) || /BOT-OFFLINE/.test(text)) {
        markBotOffline(botName);
        return;
      }
      const rm = text.match(/Router\s*:\s*([^\n]+)/);
      const dm = text.match(/Device\s*:\s*([^\n]+)/);
      const pm = text.match(/Public\s*:\s*([^\n]+)/);
      let routerIp = rm ? rm[1].trim() : '';
      const deviceIp = dm ? dm[1].trim() : '';
      let publicIp = pm ? pm[1].trim() : '';
      if (routerIp === '-') routerIp = '';
      if (publicIp === '-') publicIp = '';
      if (routerIp && !isPrivateIp(routerIp) && !publicIp) {
        publicIp = routerIp;
        routerIp = '';
      }
      const wasOffline = touchBotHeartbeat(botName, Number.isFinite(epoch) && epoch > 0 ? epoch : Date.now(), {
        routerIp,
        deviceIp: deviceIp && deviceIp !== '-' ? deviceIp : '',
        publicIp
      });
      if (wasOffline && botStateNotified[botKey(botName)] !== 'online') onBotBackOnline(botName);
      return;
    }
    // رسائل الحالة اللي بتتصدر من الرصد نفسه (واقف/رجع) — مش معاد، متتسجلش
    if (text.includes('BOT-STATUS:')) return;
    if (text.includes('PAY-LINK:')) return;

    const entry = parseText(text);
    if (clearedAt > 0 && entry.ts > 0 && entry.ts <= clearedAt) return;
    if (entry.ts && events.some((e) => e.ts === entry.ts && e.account === entry.account && e.bot === entry.bot)) return;
    events.unshift(entry);
    if (events.length > 100) events.length = 100;
    serial++;
    if (entry.account) profileFor(entry.account, entry.ts);
    if (entry.bot) touchBotHeartbeat(entry.bot, entry.ts);
    persistHistory();

    console.log('\n🚨 APPOINTMENT NOTIFICATION RECEIVED!');
    showPopup(data.title || '🎉 APPOINTMENT FOUND!', entry.rawText);
  } catch (e) {
    // ignore malformed frames
  }
}

// Parse the plain-text body the bot sends into structured fields
function parseText(text) {
  const raw = String(text);
  const get = (key) => {
    const m = raw.match(new RegExp(key + '\\s*[:：]\\s*([^\\n]+)'));
    return m ? m[1].trim() : '';
  };
  const epochMs = parseInt(get('Epoch') || '', 10);
  return makeEvent(
    get('Account') || get('الحساب'),
    get('Customer') || get('العميل'),
    get('Phone') || get('الهاتف'),
    get('Office') || get('المكتب'),
    get('Visa') || get('نوع الفيزا'),
    raw,
    epochMs,
    get('Time'),
    get('Bot')
  );
}

// ---------- Windows popup ----------
function showPopup(title, message) {
  const psScript = path.join(__dirname, 'show-notification.ps1');
  const argTitle = JSON.stringify(title);
  const argMsg = JSON.stringify(message);

  if (fs.existsSync(psScript)) {
    spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'RemoteSigned',
      '-File', psScript,
      argTitle, argMsg
    ], { windowsHide: false, stdio: 'ignore' });
  }
}

// ---------- Start ----------
if (!NTFY_DISABLED) {
  listen();
} else {
  console.log('🔕 ntfy listener skipped — local-only mode.');
}
