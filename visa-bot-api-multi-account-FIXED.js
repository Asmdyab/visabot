// visa-bot-api-multi-account-FIXED.js - FIXED VERSION with correct API endpoints
//
// FIXES:
// 1. Uses correct API endpoints to check actual available slots (not just checks)
// 2. Checks months -> days -> slots hierarchy
// 3. Properly handles tripDate parameter
//
import { fetch, Agent, buildConnector, ProxyAgent } from 'undici';
import { Impit } from 'impit';
import https from 'https';
import http from 'http';
import http2 from 'http2';  // 🚀 NEW: HTTP/2 support for faster multiplexing
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { chromium } from 'playwright';
import dns from 'dns';
import net from 'net';
import { promisify } from 'util';
import { spawn, exec } from 'child_process';
import { sendTelegramNotification } from './telegram-notifier.js';  // 📱 Telegram integration
import {
  syncNtpClock,
  ntpNow,
  getNtpStatus,
  parseTimeOfDay,
  formatCairoHms,
  nextCairoWallTimeEpochMs,
  waitUntilNtpEpoch,
  startNtpAutoSync
} from './ntp-clock.js';

// 🚀 AGGRESSIVE DNS CACHING for maximum speed!
const dnsLookup = promisify(dns.lookup);
const dnsCache = new Map();
const DNS_CACHE_TTL = 60 * 60 * 1000; // 60 minutes (very long cache!)

// Pre-cache critical domains on startup
const CRITICAL_DOMAINS = [
  'egyapi.almaviva-visa.it',
  'egyiam.almaviva-visa.it',
  'checkip.amazonaws.com',
  'api.ipify.org'
];

// Async pre-warm DNS cache (connections pre-warming disabled for reliability)
(async () => {
  console.log('🚀 Starting DNS pre-warming...');
  
  for (const domain of CRITICAL_DOMAINS) {
    try {
      const result = await dnsLookup(domain, { family: 4 });
      dnsCache.set(`${domain}:4`, { result, timestamp: Date.now() });
      console.log(`✅ Pre-cached DNS: ${domain} -> ${result.address}`);
    } catch (e) {
      console.log(`⚠️ Failed to pre-cache DNS for ${domain}`);
    }
  }
  
  // Connection pre-warming disabled for reliability
  console.log('✅ DNS pre-warming complete!');
})();

async function cachedDnsLookup(hostname, options) {
  const cacheKey = `${hostname}:${options.family || 4}`;
  const cached = dnsCache.get(cacheKey);
  
  if (cached && (Date.now() - cached.timestamp < DNS_CACHE_TTL)) {
    return cached.result;
  }
  
  const result = await dnsLookup(hostname, options);
  dnsCache.set(cacheKey, { result, timestamp: Date.now() });
  return result;
}

/**
 * Node-style lookup so tls/net connections reuse the pre-warmed cache instead of paying a
 * resolver round-trip per connection. Handles both `all: false` (single address) and
 * `all: true` (address list, used by autoSelectFamily) callback shapes.
 * Any failure falls through to the system resolver so connectivity is never lost.
 */
function cachedLookupAdapter(hostname, options, callback) {
  const family = options?.family === 6 ? 6 : 4;
  const wantAll = options?.all === true;

  const deliver = (result) => {
    const address = result.address;
    const fam = result.family || family;
    callback(null, wantAll ? [{ address, family: fam }] : address, fam);
  };

  const cached = dnsCache.get(`${hostname}:${family}`);
  if (cached && (Date.now() - cached.timestamp < DNS_CACHE_TTL)) {
    process.nextTick(() => deliver(cached.result));
    return;
  }

  dnsLookup(hostname, { family })
    .then((result) => {
      dnsCache.set(`${hostname}:${family}`, { result, timestamp: Date.now() });
      deliver(result);
    })
    .catch(() => {
      // Fall back to the default resolver rather than failing the connection
      dns.lookup(hostname, options, callback);
    });
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
const FAKE_ACCOUNTS_FILE = path.join(__dirname, 'accounts-fake.json');
const BOT_LOGS_FILE = path.join(__dirname, 'bot-api-logs.txt');
const BOT_SESSION_LOGS_DIR = path.join(__dirname, 'bot-session-logs');
const RATE_LIMITED_FILE = path.join(__dirname, 'rate-limited-accounts.json');

// 🚨 Dedicated 401 log — every account that gets a 401 lands here, live in its own window
const BOT_401_LOG_FILE = path.join(__dirname, 'bot-401-log.txt');

function log401(email, msg) {
  try {
    const now = new Date();
    const ts = now.toTimeString().slice(0, 8) + '.' + String(now.getMilliseconds()).padStart(3, '0');
    const line = `[${ts}] [${email || 'unknown'}] ${msg}`;
    fs.appendFileSync(BOT_401_LOG_FILE, line + '\n', 'utf8');
  } catch (_) { }
}

/** Opens a PowerShell window streaming the 401 log live */
function open401LogWindow() {
  try {
    if (!fs.existsSync(BOT_401_LOG_FILE)) {
      fs.writeFileSync(BOT_401_LOG_FILE, `=== 🚨 401 LOG — started ${new Date().toLocaleString('en-GB')} ===\n`, 'utf8');
    }
    const cmd = `$host.UI.RawUI.WindowTitle='🚨 401 LOG — الحسابات اللي بتجيب 401'; Get-Content -LiteralPath '${BOT_401_LOG_FILE}' -Wait -Encoding UTF8`;
    // exec (not spawn+start): cmd's start needs the quoted title in ONE raw command string,
    // otherwise it treats '401LOG' as the program name → "Windows cannot find '401LOG'"
    exec(`start "401LOG" powershell -NoExit -ExecutionPolicy RemoteSigned -Command "${cmd}"`, { detached: true, windowsHide: false }).unref();
    // console (not log()) — this runs during module init before the logger is ready
    console.log('🚨 نافذة لوج الـ 401 اتفتحت (bot-401-log.txt)');
  } catch (e) {
    console.log(`⚠️ مقدرتش أفتح نافذة الـ 401: ${e.message}`);
  }
}
// open401LogWindow(); // disabled - user doesn't want the 401 log window

/** Per-run session log file (full UTF-8 with emojis/symbols). */
let BOT_SESSION_LOG_FILE = null;
let sessionLogFinalized = false;

function safeLogFilePart(value, fallback = 'all') {
  const s = String(value || '')
    .replace(/[^\w\u0600-\u06FF\-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return s || fallback;
}

function initSessionLogFile() {
  try {
    if (!fs.existsSync(BOT_SESSION_LOGS_DIR)) {
      fs.mkdirSync(BOT_SESSION_LOGS_DIR, { recursive: true });
    }
    const now = new Date(ntpNow());
    const stamp =
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}` +
      `_${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}`;
    const office = safeLogFilePart(process.env.BOT_OFFICE, 'all');
    const visa = safeLogFilePart(process.env.BOT_VISA_TYPE, 'all');
    const mode = safeLogFilePart(getActiveCheckModeLabel?.() || 'bot', 'bot');
    BOT_SESSION_LOG_FILE = path.join(BOT_SESSION_LOGS_DIR, `${stamp}_${mode}_${office}_${visa}.txt`);
    // BOM so Notepad shows Arabic + emoji correctly
    fs.writeFileSync(
      BOT_SESSION_LOG_FILE,
      `\uFEFF=== Session started ${now.toISOString()} ===\n` +
      `mode=${mode} | office=${office} | visa=${visa}\n` +
      `${'='.repeat(60)}\n`,
      'utf8'
    );
  } catch (_) {
    BOT_SESSION_LOG_FILE = null;
  }
}

function finalizeSessionLog(reason = 'exit') {
  if (!BOT_SESSION_LOG_FILE || sessionLogFinalized) return;
  sessionLogFinalized = true;
  try {
    fs.appendFileSync(
      BOT_SESSION_LOG_FILE,
      `\n${'='.repeat(60)}\n=== Session ended (${reason}) ${new Date().toISOString()} ===\n`,
      'utf8'
    );
  } catch (_) {}
}

/** Keep console window open forever — closes ONLY when the user presses X */
async function holdConsoleOpen() {
  log('');
  log('='.repeat(60));
  log('✅ التشييك خلص — اللوج هيفضل ظاهر');
  log('🪟 أقفل النافذة إيدوي (X من فوق) لما تخلص مراجعة اللوج');
  log('='.repeat(60));
  await new Promise(() => {
    // Keep the event loop alive indefinitely; no keyboard input closes it.
    setInterval(() => {}, 10 * 60 * 1000);
  });
}

// Exit helper: keeps the console window open on ANY exit path (including errors),
// so the window only closes when the user closes it manually.
async function safeExit(code = 0) {
  try {
    await holdConsoleOpen();
  } catch (_) {}
  process.exit(code);
}

// Async variant for top-level handlers — keeps console alive until user presses X.
async function safeExitSync(code = 0) {
  try {
    await import('fs');  // no-op import guard stays harmless
    await new Promise(() => {
      setInterval(() => {}, 10 * 60 * 1000);
    });
  } catch (_) {}
  process.exit(code);
}

// ----- Configuration -------------------------------------------------------
const CONFIG_FILE = path.join(__dirname, 'visa-bot-api-config.json');

function loadBotConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      // Convert proxyList to ipList if it exists
      if (config.proxyList && Array.isArray(config.proxyList)) {
        config.ipList = config.proxyList;
        delete config.proxyList;
      }
      return config;
    }
  } catch (e) {
    console.log('⚠️ Error loading config, using defaults');
  }
  
  return {
    office: 'Cairo',
    pricing: 'Standard',
    visaType: 'Tourism Visa (C)',
    visaId: 1,
    destination: '',
    tripDate: '01/12/2025',
    useProxy: true,
    useProxyForLogin: false,  // NEW: Use proxy during login phase
    proxyServer: 'brd.superproxy.io:33335:brd-customer-hl_5050eaa8-zone-isp_proxy1-country-eg:gowduqf7wuxf',
    proxyMode: 'single',
    useSpoofedIPHeaders: true,  // Disable fake X-Forwarded-For to reduce soft 401s without proxy
    ipList: [],
    requireIPPrefix: true,
    skipIPVerification: false,  // NEW: Skip IP check for faster startup (session ID ensures uniqueness)
    rateLimitCooldown: 60,
    requestsPerMinute: 5,
    maxAccounts: 1000000,
    requestTimeout: 60000,  // 60 seconds timeout (default was 30)
  };
}

const CONFIG = loadBotConfig();
const ENV = process.env;
const USE_PROXY = ENV.USE_PROXY === "true" || CONFIG.useProxy;
const USE_PROXY_FOR_LOGIN = CONFIG.useProxyForLogin === true; // Default false - login WITHOUT proxy for speed
const PROXY_MODE = CONFIG.proxyMode || 'single'; // 'single' or 'list'
const PROXY_BASE = CONFIG.proxyServer;
// USE_PROXY_SESSION is now read dynamically in buildProxyAgent() to support runtime config changes
let USE_PROXY_SESSION = CONFIG.useProxySession !== false; // Initial value (default true)
const IP_LIST = CONFIG.ipList || []; // List of IPs for 'list' mode
const REQUIRE_IP_PREFIX = CONFIG.requireIPPrefix !== false; // Default true for backward compatibility
const REQUIRED_IP_PREFIX = '77.'; // Italian IPs
const SKIP_IP_VERIFICATION = CONFIG.skipIPVerification === true; // NEW: Skip IP check for speed

// TLS: مفيش قفل شهادة افتراضيًا (rejectUnauthorized: false).
// لو حابب تقفل الشهادات صراحةً: allowInsecureTls: false في الكونفيج.
let TLS_REJECT_UNAUTHORIZED = CONFIG.allowInsecureTls === false;

// Per-account agents to prevent socket hang up with multiple accounts
// Each account gets its own connection pool
const USE_PER_ACCOUNT_AGENT = CONFIG.usePerAccountAgent !== false; // Default true
const DISABLE_KEEP_ALIVE = CONFIG.disableKeepAlive === true;

// Map to store per-account agents
const perAccountAgents = new Map();

// Get or create agent for specific account (isolates connections)
// Uses the SAME TLS connector as acquireWafCookie → consistent TLS fingerprint
function getAgentForAccount(accountEmail) {
  if (!USE_PER_ACCOUNT_AGENT) {
    return optimizedHttpsAgent; // Use shared agent
  }
  
  if (!perAccountAgents.has(accountEmail)) {
    const agent = new https.Agent({
      keepAlive: true,  // Keep enabled for speed!
      keepAliveMsecs: 1000,
      maxSockets: 5,    // Limit sockets per account
      maxFreeSockets: 2,
      maxCachedSessions: 10,
      timeout: 0,
      scheduling: 'fifo',
      rejectUnauthorized: TLS_REJECT_UNAUTHORIZED,
      createConnection: customTlsConnector    // 🔒 Same TLS fingerprint as WAF cookie
    });
    
    // Apply TCP optimizations
    agent.on('socket', (socket) => {
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 1000);
    });
    
    perAccountAgents.set(accountEmail, agent);
  }
  
  return perAccountAgents.get(accountEmail);
}

// Enable detailed HTTP logging
const DEBUG_REQUESTS = ENV.DEBUG_REQUESTS === 'true' || CONFIG.debugRequests === true;
// Show request details (headers, etc.) - default false for privacy
const SHOW_REQUEST_DETAILS = CONFIG.showRequestDetails === true;
// After Sequential Aggressive round settles, hide late HTTP status lines so they don't mix into next-round logs
let suppressLateHttpLogs = false;

function applyTlsLockEnv() {
  if (TLS_REJECT_UNAUTHORIZED) {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  } else {
    const _origEmitWarning = process.emitWarning;
    process.emitWarning = function (warning, ...args) {
      const msg = typeof warning === 'string' ? warning : (warning && warning.message) || '';
      if (String(msg).includes('NODE_TLS_REJECT_UNAUTHORIZED')) return;
      return _origEmitWarning.apply(this, [warning, ...args]);
    };
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }
}
applyTlsLockEnv();

const OFFICE_NAME = ENV.OFFICE_NAME || CONFIG.office || 'Cairo';
const PRICING_NAME = ENV.PRICING_NAME || CONFIG.pricing;
const VISA_NAME = ENV.VISA_NAME || CONFIG.visaType || 'Tourism Visa';
const DESTINATION = ENV.DESTINATION || CONFIG.destination || '';
const TRIP_DATE = ENV.TRIP_DATE || CONFIG.tripDate;

// Office ID mapping
const OFFICE_ID_MAP = {
  'Cairo': 1,
  'Alexandria': 2
};
const OFFICE_ID = OFFICE_ID_MAP[OFFICE_NAME] || 1;

// Visa type → ID (per-account; matches manager UI)
const VISA_TYPE_TO_ID = {
  'Tourism Visa': 1,
  'Business Visa': 5,
  'Sport Visa': 10,
  'Study Visa (C)': 9,
  'Study Visa (D)': 8,
  'Medical Visa': 15,
  'Re-entry Visa (D)': 4,
  'Employment (record number 2025)': 31,
  'Employment (record number 2026)': 32,
  'Family Reunion': 19,
  'Research': 33,
  // legacy aliases
  'Tourism Visa (C)': 1,
  'Business Visa (C)': 5,
  'Sport Visa (C)': 10
};

/** Resolve office + visa targets from account (falls back to global config). */
function resolveAccountTargets(account) {
  const officeName = account?.office || CONFIG.office || 'Cairo';
  const officeId = OFFICE_ID_MAP[officeName] || 1;
  const types = Array.isArray(account?.enabledVisaTypes) ? account.enabledVisaTypes : [];
  const visaType = types[0] || CONFIG.visaType || 'Tourism Visa';
  const visaId = VISA_TYPE_TO_ID[visaType] || CONFIG.visaId || 1;
  return { officeName, officeId, visaType, visaId };
}

function enrichAccountData(accountData) {
  if (!accountData || !accountData.account) return accountData;
  Object.assign(accountData, resolveAccountTargets(accountData.account));
  return accountData;
}

// ── Fake probe mode (isolated SeqAggPlus for timing discovery) ──────────────
let FAKE_PROBE_ACTIVE = false;
let FAKE_PROBE_TARGETS = [];

function buildFakeProbeTargets(modeCfg = {}) {
  const officesRaw = Array.isArray(modeCfg.offices) ? modeCfg.offices : [];
  const visasRaw = Array.isArray(modeCfg.visaTypes) ? modeCfg.visaTypes : [];
  const offices = [...new Set(officesRaw.map(o => String(o || '').trim()).filter(Boolean))].slice(0, 2);
  const visas = [...new Set(visasRaw.map(v => String(v || '').trim()).filter(Boolean))];
  const officeList = offices.length > 0 ? offices : ['Cairo'];
  const visaList = visas.length > 0 ? visas : ['Tourism Visa'];
  const targets = [];
  for (const officeName of officeList) {
    const officeId = OFFICE_ID_MAP[officeName] || 1;
    for (const visaType of visaList) {
      const visaId = VISA_TYPE_TO_ID[visaType] || 1;
      targets.push({ officeName, officeId, visaType, visaId });
    }
  }
  return targets;
}

function fakeProbeTargetKey(email, officeId, visaId) {
  return `${emailKey(email)}|${officeId}|${visaId}`;
}

function syncFakeProbeFoundFromFile() {
  try {
    if (!fs.existsSync(FAKE_ACCOUNTS_FILE)) return;
    const accounts = JSON.parse(fs.readFileSync(FAKE_ACCOUNTS_FILE, 'utf8'));
    for (const acc of accounts) {
      if (!acc?.email) continue;
      const hits = Array.isArray(acc.foundHits) ? acc.foundHits : [];
      for (const hit of hits) {
        const officeId = OFFICE_ID_MAP[hit.office] || OFFICE_ID_MAP[hit.officeName] || 1;
        const visaId = VISA_TYPE_TO_ID[hit.visaType] || 0;
        if (!visaId) continue;
        accountsFoundThisSession.add(fakeProbeTargetKey(acc.email, officeId, visaId));
      }
    }
  } catch (e) {
    log(`⚠️ Error syncing fake probe finds: ${e.message}`);
  }
}

function markFakeProbeFoundInFile(email, appointmentInfo) {
  try {
    if (!fs.existsSync(FAKE_ACCOUNTS_FILE)) return;
    const accounts = JSON.parse(fs.readFileSync(FAKE_ACCOUNTS_FILE, 'utf8'));
    const key = emailKey(email);
    const entry = accounts.find(a => emailKey(a.email) === key);
    if (!entry) return;
    const nowIso = new Date().toISOString();
    entry.foundHits = Array.isArray(entry.foundHits) ? entry.foundHits : [];
    const office = appointmentInfo?.office || '';
    const visaType = appointmentInfo?.visaType || '';
    const exists = entry.foundHits.some(h => h.office === office && h.visaType === visaType);
    if (!exists) {
      entry.foundHits.push({
        office,
        visaType,
        tripDate: appointmentInfo?.tripDate || '',
        destination: appointmentInfo?.destination || '',
        foundAt: nowIso
      });
    }
    fs.writeFileSync(FAKE_ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf8');
  } catch (e) {
    log(`⚠️ Could not mark fake probe find: ${e.message}`);
  }
}

function hasFakeProbeTargetFound(email, officeId, visaId) {
  return accountsFoundThisSession.has(fakeProbeTargetKey(email, officeId, visaId));
}

function hasFakeProbeAccountFullyFound(email) {
  if (!FAKE_PROBE_TARGETS.length) return false;
  return FAKE_PROBE_TARGETS.every(t => hasFakeProbeTargetFound(email, t.officeId, t.visaId));
}

function getAccountCustomerInfo(account) {
  return {
    customerFor: String(account?.customerFor || '').trim(),
    customerPhone: String(account?.customerPhone || '').trim()
  };
}
const RATE_LIMIT_COOLDOWN = CONFIG.rateLimitCooldown || 60;
const CHECK_INTERVAL = Math.floor(60000 / (CONFIG.requestsPerMinute || 30));
const MAX_ACCOUNTS = CONFIG.maxAccounts || 1000000;
// ⚙️ Use timeout from config (no forced limit)
const REQUEST_TIMEOUT = CONFIG.requestTimeout || 30000; // Default 30 seconds if not specified
// ⚙️ Optional timeout for /checks endpoint (defaults to requestTimeout)
const CHECKS_TIMEOUT = CONFIG.checksTimeoutMs || CONFIG.checksTimeout || REQUEST_TIMEOUT;

// Sequential Mode Configuration
// sequentialMode (9 AM), sequentialParallelMode9 (9 AM copy — same wait-for-response), sequentialMode2 (general)
// Priority: 9 AM sequential > 9 AM sequential-parallel copy > General
const SEQUENTIAL_MODE_9AM = CONFIG.sequentialMode || {};
const SEQUENTIAL_PARALLEL_9AM = CONFIG.sequentialParallelMode9 || {};
const SEQUENTIAL_MODE_GENERAL = CONFIG.sequentialMode2 || {};
const ENABLE_SEQUENTIAL_PARALLEL_9AM = SEQUENTIAL_PARALLEL_9AM.enabled === true;
const SEQUENTIAL_MODE = SEQUENTIAL_MODE_9AM.enabled === true
  ? SEQUENTIAL_MODE_9AM
  : (ENABLE_SEQUENTIAL_PARALLEL_9AM
    ? SEQUENTIAL_PARALLEL_9AM
    : (SEQUENTIAL_MODE_GENERAL.enabled === true ? SEQUENTIAL_MODE_GENERAL : {}));
const ENABLE_SEQUENTIAL_MODE = SEQUENTIAL_MODE_9AM.enabled === true
  || ENABLE_SEQUENTIAL_PARALLEL_9AM
  || SEQUENTIAL_MODE_GENERAL.enabled === true;
// Quiet console in sequential mode: show only request send + response status
const SEQUENTIAL_QUIET_LOGS = ENABLE_SEQUENTIAL_MODE;
const SEQUENTIAL_DELAY = Number.isFinite(Number(SEQUENTIAL_MODE.delayMs))
  ? Math.max(0, Number(SEQUENTIAL_MODE.delayMs))
  : 0; // Delay after each response before next request (0 = instant)
let sequentialDelayBannerLogged = false;
const SEQUENTIAL_STOP_AT_TIME = SEQUENTIAL_MODE.enableStopAtTime === true;
const SEQUENTIAL_STOP_AT_TIME_VALUE = SEQUENTIAL_MODE.stopAtTime || '';
const SEQUENTIAL_STOP_AFTER_REQUESTS = SEQUENTIAL_MODE.enableStopAfterRequests === true;
const SEQUENTIAL_STOP_AFTER_COUNT = SEQUENTIAL_MODE.stopAfterRequests || 0;

// Clock-Burst Mode: synchronized burst inside a short window ending exactly on
// every-N-minutes wall-clock marks (default: 10s window before each min%5==0).
// Measured server budget (2026-09-16, live): token bucket ~60/account, refill
// ~0.45/min. Safe-forever spend per 5-min cycle is <= 2/account (2 <= 0.45*5).
// Aggressive 4/account drains the bucket and trips after ~3h, then needs ~2h park.
const CLOCK_BURST_MODE = CONFIG.clockBurst || {};
const ENABLE_CLOCK_BURST = CLOCK_BURST_MODE.enabled === true;
const CLOCK_BURST_EVERY_MIN = Number.isFinite(Number(CLOCK_BURST_MODE.everyMinutes)) && Number(CLOCK_BURST_MODE.everyMinutes) > 0
  ? Math.floor(Number(CLOCK_BURST_MODE.everyMinutes)) : 5;
const CLOCK_BURST_WINDOW_SEC = Number.isFinite(Number(CLOCK_BURST_MODE.windowSec)) && Number(CLOCK_BURST_MODE.windowSec) > 0
  ? Math.min(120, Math.max(2, Number(CLOCK_BURST_MODE.windowSec))) : 10;
const CLOCK_BURST_PER_ACCOUNT = Number.isFinite(Number(CLOCK_BURST_MODE.perAccount)) && Number(CLOCK_BURST_MODE.perAccount) > 0
  ? Math.min(10, Math.max(1, Math.floor(Number(CLOCK_BURST_MODE.perAccount)))) : 2;
// Pre-arm lead: how far BEFORE windowStart sessions are prepared (login/refresh).
// Was hardcoded 10s — too tight: any login taking >10s missed the window.
// Configurable via clockBurst.preArmSec (default 60s), clamped 15..180s.
const CLOCK_BURST_PREARM_SEC = (() => {
  const raw = Number(CLOCK_BURST_MODE.preArmSec);
  if (!Number.isFinite(raw) || raw <= 0) return 60;
  return Math.min(180, Math.max(15, Math.floor(raw)));
})();

// 🔌 Warm the API origin too, not just the SPA origin: /checks lives on
// egyapi.almaviva-visa.it — a DIFFERENT origin (own connection pool) from
// egy.almaviva-visa.it — so a homepage-only warmup leaves the /checks connection cold and the
// first shot of every burst pays a full TCP+TLS+H2 handshake at the worst possible moment.
// Measured with test-api-401-probe.js: cold /checks 330ms vs warm 86-107ms off-peak (the peak
// multiplies that, and the first shot is exactly the one that gets soft-401'd).
const CHECKS_ORIGIN_ROOT = 'https://egyapi.almaviva-visa.it/';
const WARMUP_API_ORIGIN = CONFIG.warmApiOrigin !== false; // default ON
// Master switch for pre-burst warmup (WARMUP + WARMUP_API HEADs). Default ON.
// Set "warmupEnabled": false (or "disableWarmup": true) in config to skip it entirely.
const WARMUP_ENABLED = CONFIG.warmupEnabled !== false && CONFIG.disableWarmup !== true;

// Trickle Mode: continuous round-robin at a fixed safe pace derived from the
// measured refill (0.4/min/account, margin under 0.45). No clock windows.
// Aggregate gap = 150s / N_enabled (e.g. 3 accounts -> 1 req/50s rotating).
const TRICKLE_MODE = CONFIG.trickle || {};
const ENABLE_TRICKLE = TRICKLE_MODE.enabled === true;
const TRICKLE_PER_ACCOUNT_SEC = 150; // 1 req / 150s / account = 0.4/min (fixed safe pace)

// Stop Control Configuration
const STOP_CONTROL = CONFIG.stopControl || {};
// Prefer Sequential Mode stop controls when that mode is on; else use global stopControl
const ENABLE_STOP_AT_TIME = (ENABLE_SEQUENTIAL_MODE && SEQUENTIAL_STOP_AT_TIME)
  || STOP_CONTROL.enableStopAtTime === true;
const STOP_AT_TIME = (ENABLE_SEQUENTIAL_MODE && SEQUENTIAL_STOP_AT_TIME)
  ? SEQUENTIAL_STOP_AT_TIME_VALUE
  : (STOP_CONTROL.stopAtTime || ''); // Format: HH:MM:SS
const ENABLE_STOP_AFTER_REQUESTS = (ENABLE_SEQUENTIAL_MODE && SEQUENTIAL_STOP_AFTER_REQUESTS)
  || STOP_CONTROL.enableStopAfterRequests === true;
const STOP_AFTER_REQUESTS = (ENABLE_SEQUENTIAL_MODE && SEQUENTIAL_STOP_AFTER_REQUESTS)
  ? (SEQUENTIAL_STOP_AFTER_COUNT || 0)
  : (STOP_CONTROL.stopAfterRequests || 0);

/** Short label for console window title (tab) — matches effective check mode priority */
function getActiveCheckModeLabel() {
  if (ENABLE_CLOCK_BURST) return 'تفجير-ساعة';
  if (ENABLE_TRICKLE) return 'تقطير';
  if (SEQUENTIAL_MODE_9AM.enabled === true) return 'تتابعي-9ص';
  if (ENABLE_SEQUENTIAL_PARALLEL_9AM) return 'تتابعي-متوازي-9ص';
  if (SEQUENTIAL_MODE_GENERAL.enabled === true) return 'تتابعي';
  if ((CONFIG.sequentialAggressiveFakeMode || {}).enabled === true) return 'فيك-توقيت';
  if ((CONFIG.sequentialAggressivePlusMode || {}).enabled === true) return 'تتابعي-عدواني+';
  if ((CONFIG.sequentialAggressiveMode || {}).enabled === true) return 'تتابعي-عدواني';
  if (CONFIG.parallelRoundRobinMode?.enabled) return 'RR-متوازي';
  if (CONFIG.enableRoundRobin) return 'RoundRobin';
  if ((CONFIG.aggressiveMode || {}).enabled === true) return 'عدواني';
  return 'متوازي';
}

function officeTitleAr(office) {
  const raw = String(office || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.includes('alex') || raw.includes('اسكندر')) return 'الإسكندرية';
  if (raw.includes('cairo') || raw.includes('قاهر')) return 'القاهرة';
  return '';
}

function setBotWindowTitle(_contextLabel = '') {
  const visa = String(process.env.BOT_VISA_TYPE || VISA_NAME || '').trim();
  const city = officeTitleAr(process.env.BOT_OFFICE || OFFICE_NAME);
  const title = [visa, city].filter(Boolean).join(' - ').slice(0, 90) || 'BotLog';
  try { process.title = title; } catch (_) {}
  try {
    if (process.stdout && process.stdout.isTTY) {
      process.stdout.write(`\x1b]0;${title}\x07`);
    }
  } catch (_) {}
}

// Per-Account Start Time Configuration
const ENABLE_PER_ACCOUNT_START_TIME = CONFIG.enablePerAccountStartTime === true;

// Per-account request counters for stop control
const perAccountRequestCount = new Map(); // email -> count
const perAccountStopFlags = new Map(); // email -> boolean (stopped)
let globalStopAtTimeReached = false; // Global flag for time-based stop

// Accounts locked after a find. Stay skipped across cycles AND new bot windows
// until the user clicks استرجاع (clears foundAt in accounts.json).
const accountsFoundThisSession = new Set();

function emailKey(email) {
  return String(email || '').trim().toLowerCase();
}

function syncAccountsFoundFromFile() {
  try {
    if (!fs.existsSync(ACCOUNTS_FILE)) return;
    const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    const locked = new Set();
    const known = new Set();
    for (const acc of accounts) {
      if (!acc.email) continue;
      const key = emailKey(acc.email);
      known.add(key);
      if (acc.foundAt) locked.add(key);
    }
    for (const key of [...accountsFoundThisSession]) {
      if (known.has(key) && !locked.has(key)) {
        accountsFoundThisSession.delete(key);
      }
    }
    for (const key of locked) accountsFoundThisSession.add(key);
  } catch (e) {
    log(`⚠️ Error syncing found accounts from file: ${e.message}`);
  }
}

function markAccountFoundThisSession(email) {
  if (email) accountsFoundThisSession.add(emailKey(email));
}

function markAccountFoundInFile(email, appointmentInfo) {
  try {
    if (!fs.existsSync(ACCOUNTS_FILE)) return;
    const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    const key = emailKey(email);
    const entry = accounts.find(a => emailKey(a.email) === key);
    if (entry) {
      const nowIso = new Date().toISOString();
      entry.foundAt = nowIso;
      entry.caughtAt = nowIso;
      entry.foundAppointment = appointmentInfo || {};
      fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf8');
      markAccountFoundThisSession(email);
    }
  } catch (e) {
    log(`⚠️ Could not mark account as found: ${e.message}`);
  }
}

function hasAccountFoundThisSession(email) {
  if (!email) return false;
  return accountsFoundThisSession.has(emailKey(email));
}

function logAccountsSkippedBecauseFound(context = '') {
  if (accountsFoundThisSession.size === 0) return;
  const label = context ? ` (${context})` : '';
  log(`⏭️ تخطي ${accountsFoundThisSession.size} حساب لقى معاد${label} — مش هيتشيك تاني إلا بعد استرجاع:`);
  for (const email of accountsFoundThisSession) {
    log(`   • ${email}`);
  }
}

// Check if we should stop sending new requests FOR A SPECIFIC ACCOUNT
function shouldStopSendingRequests(email = null, accountRequestCount = 0) {
  // Check stop at time (global for all accounts)
  if (ENABLE_STOP_AT_TIME && STOP_AT_TIME) {
    const timeParts = STOP_AT_TIME.split(':');
    if (timeParts.length >= 3) {
      const stopHour = parseInt(timeParts[0]) || 0;
      const stopMinute = parseInt(timeParts[1]) || 0;
      const stopSecond = parseInt(timeParts[2]) || 0;
      
      const now = new Date(ntpNow());
      const currentHour = now.getHours();
      const currentMinute = now.getMinutes();
      const currentSecond = now.getSeconds();
      
      // Convert to total seconds for easier comparison
      const stopTimeSeconds = stopHour * 3600 + stopMinute * 60 + stopSecond;
      const currentTimeSeconds = currentHour * 3600 + currentMinute * 60 + currentSecond;
      
      if (currentTimeSeconds >= stopTimeSeconds) {
        if (!globalStopAtTimeReached) {
          if (!SEQUENTIAL_QUIET_LOGS) {
            log(`\n🛑 STOP CONTROL: Reached stop time ${STOP_AT_TIME}`);
            log(`   ⏳ Waiting for pending responses...`);
          }
          globalStopAtTimeReached = true;
        }
        return true;
      }
    }
  }
  
  // Check stop after requests PER ACCOUNT (not global)
  if (ENABLE_STOP_AFTER_REQUESTS && STOP_AFTER_REQUESTS > 0 && email) {
    // Check if this account already reached the limit
    if (perAccountStopFlags.get(email)) {
      return true;
    }
    
    // Use passed accountRequestCount (more accurate) or fall back to stored count
    const count = accountRequestCount > 0 ? accountRequestCount : (perAccountRequestCount.get(email) || 0);
    
    if (count >= STOP_AFTER_REQUESTS) {
      if (!perAccountStopFlags.get(email)) {
        if (!SEQUENTIAL_QUIET_LOGS) {
          log(`\n🛑 STOP CONTROL: [${email}] Reached ${STOP_AFTER_REQUESTS} requests for this account`);
          log(`   ⏳ Account will stop, other accounts continue...`);
        }
        perAccountStopFlags.set(email, true);
      }
      return true;
    }
  }
  
  return false;
}

// Increment request counter for a specific account
function incrementAccountRequestCount(email) {
  const currentCount = perAccountRequestCount.get(email) || 0;
  const newCount = currentCount + 1;
  perAccountRequestCount.set(email, newCount);
  return newCount;
}

// Get request count for a specific account
function getAccountRequestCount(email) {
  return perAccountRequestCount.get(email) || 0;
}

/** Interruptible sleep — wakes early when a live reschedule command arrives. */
const sleep = (ms) => {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (typeof isLiveReschedulePending === 'function' && isLiveReschedulePending()) {
        resolve();
        return;
      }
      const left = ms - (Date.now() - start);
      if (left <= 0) {
        resolve();
        return;
      }
      setTimeout(tick, Math.min(200, left));
    };
    setTimeout(tick, Math.min(200, ms));
  });
};

/**
 * Precise short delay. Windows setTimeout is ~15ms — sub-30ms gaps must busy-spin.
 * Also supports absolute epoch waits for staggered account fires (no cumulative drift).
 */
async function preciseDelay(ms) {
  if (!ms || ms <= 0) return;
  const end = ntpNow() + ms;
  await waitUntilEpochPrecise(end);
}

async function waitUntilEpochPrecise(targetEpochMs) {
  if (!targetEpochMs) return;
  for (;;) {
    if (typeof isLiveReschedulePending === 'function' && isLiveReschedulePending()) return;
    const left = targetEpochMs - ntpNow();
    if (left <= 0) return;
    if (left > 30) {
      await sleep(Math.min(left - 15, 200));
      continue;
    }
    // Final ~30ms: busy-spin for true 1ms-class gaps
    while (ntpNow() < targetEpochMs) {
      if (typeof isLiveReschedulePending === 'function' && isLiveReschedulePending()) return;
    }
    return;
  }
}

/** Absolute slot fire: anchor + slot*interval (no sleep-after-fire drift / Windows ~15ms floor). */
async function waitForStaggerSlot(anchorMs, slot, intervalMs) {
  if (!intervalMs || intervalMs <= 0 || !slot || slot <= 0) return;
  await waitUntilEpochPrecise(anchorMs + slot * intervalMs);
}

/**
 * Log "request sent" without delaying the HTTP call.
 * Call this RIGHT WHEN firing (before await). setImmediate runs while the
 * request is in-flight → line appears ABOVE Status, never under the reply.
 */
function logRequestSentDeferred(message) {
  setImmediate(() => {
    try { log(message); } catch (_) {}
  });
}

/**
 * Schedule fn at an absolute epoch (precise). Prefer this over bare setTimeout for mode intervals.
 * Returns a cancel() that skips the callback if still pending.
 */
function scheduleAtEpochPrecise(targetEpochMs, fn) {
  let cancelled = false;
  const run = async () => {
    if (cancelled) return;
    await waitUntilEpochPrecise(targetEpochMs);
    if (cancelled) return;
    try { fn(); } catch (_) {}
  };
  const left = targetEpochMs - ntpNow();
  if (left <= 30) {
    run();
  } else {
    setTimeout(run, Math.max(0, left - 20));
  }
  return () => { cancelled = true; };
}

// =========================
// LIVE WINDOW RESCHEDULE
// (manager can change check time while log stays open → re-login)
// =========================
const LIVE_WINDOWS_DIR = path.join(__dirname, '.bot-launch', 'live');
const LIVE_COMMANDS_DIR = path.join(__dirname, '.bot-launch', 'commands');
const LIVE_RESCHEDULE_ERR = 'LIVE_RESCHEDULE';

let liveWindowMeta = {
  winId: String(process.env.BOT_WIN_ID || `PID${process.pid}`).trim() || `PID${process.pid}`,
  office: String(process.env.BOT_OFFICE || '').trim(),
  visa: String(process.env.BOT_VISA_TYPE || '').trim(),
  scheduledCheckTime: '',
  enableScheduledCheck: false,
  mode: '',
  accounts: 0,
  pid: process.pid,
  status: 'starting',
  startedAt: Date.now(),
  lastBeat: Date.now(),
  raceQuiet: false,
  latency: null
};
let liveRescheduleRequested = false;
let pendingLiveReschedule = null;
let liveHeartbeatTimer = null;
let livePollTimer = null;

// =========================
// RACE MODE + LATENCY
// =========================
const RACE_MODE_CFG = CONFIG.raceMode || {};
const RACE_MODE_ENABLED = RACE_MODE_CFG.enabled !== false; // default ON
const RACE_MODE_LEAD_MS = Math.max(1000, (parseInt(RACE_MODE_CFG.leadSeconds, 10) || 10) * 1000);
/** Pre-build /checks URL+headers this many ms before strike (no extra HTTP). */
const CHECK_PREARM_LEAD_MS = Math.max(500, parseInt(CONFIG.checkPrearmLeadMs, 10) || 4000);
const PREPARED_CHECK_MAX_AGE_MS = CHECK_PREARM_LEAD_MS + 5000;
let raceQuietActive = false;
/** email → { url, headers, officeId, visaId, serviceLevelId, token, preparedAt } */
const preparedCheckByEmail = new Map();

function isRaceQuiet() {
  return raceQuietActive === true;
}

function enterRaceQuiet(reason = '') {
  if (!RACE_MODE_ENABLED || raceQuietActive) return;
  raceQuietActive = true;
  const tip = reason ? ` — ${reason}` : '';
  const raw = `🏎️ وضع السباق ON${tip} | توقف اللوج الزيادة + الريفريش/Keep-alive`;
  try {
    const time = formatCairoHms(ntpNow(), true);
    console.log(fixArabicForWindowsConsole(`[${time}] ${raw}`));
  } catch (_) {
    try { console.log(raw); } catch (__) {}
  }
  updateLiveWindowMeta({ status: 'race', raceQuiet: true });
}

function exitRaceQuiet() {
  if (!raceQuietActive) return;
  raceQuietActive = false;
  updateLiveWindowMeta({ status: 'running', raceQuiet: false });
}

const latencyStats = {
  count: 0,
  sumMs: 0,
  lastMs: null,
  minMs: null,
  maxMs: null,
  lastSentAt: null,
  lastEmail: ''
};

function recordCheckLatency(durationMs, label = '', accountEmail = '') {
  const ms = Number(durationMs);
  if (!Number.isFinite(ms) || ms < 0) return;
  const lab = String(label || '');
  if (!lab.includes('CHECK_AVAILABILITY')) return;
  latencyStats.count += 1;
  latencyStats.sumMs += ms;
  latencyStats.lastMs = Math.round(ms);
  latencyStats.lastSentAt = formatCairoHms(ntpNow(), true);
  latencyStats.lastEmail = accountEmail || '';
  if (latencyStats.minMs == null || ms < latencyStats.minMs) latencyStats.minMs = Math.round(ms);
  if (latencyStats.maxMs == null || ms > latencyStats.maxMs) latencyStats.maxMs = Math.round(ms);
  const snap = {
    count: latencyStats.count,
    lastMs: latencyStats.lastMs,
    avgMs: Math.round(latencyStats.sumMs / latencyStats.count),
    minMs: latencyStats.minMs,
    maxMs: latencyStats.maxMs,
    lastSentAt: latencyStats.lastSentAt,
    lastEmail: latencyStats.lastEmail
  };
  liveWindowMeta.latency = snap;
  if (latencyStats.count === 1 || latencyStats.count % 2 === 0) {
    try { writeLiveWindowRegistry(); } catch (_) {}
  }
}

function isLiveReschedulePending() {
  return liveRescheduleRequested === true;
}

function isLiveRescheduleError(err) {
  return String(err?.message || err || '').includes(LIVE_RESCHEDULE_ERR);
}

function throwIfLiveReschedule() {
  if (liveRescheduleRequested) {
    try { exitRaceQuiet(); } catch (_) {}
    throw new Error(LIVE_RESCHEDULE_ERR);
  }
}

function consumePendingLiveReschedule() {
  if (!pendingLiveReschedule) return null;
  const cmd = pendingLiveReschedule;
  pendingLiveReschedule = null;
  liveRescheduleRequested = false;
  return cmd;
}

function updateLiveWindowMeta(patch = {}) {
  Object.assign(liveWindowMeta, patch);
  liveWindowMeta.lastBeat = Date.now();
  writeLiveWindowRegistry();
}

function writeLiveWindowRegistry() {
  try {
    fs.mkdirSync(LIVE_WINDOWS_DIR, { recursive: true });
    const file = path.join(LIVE_WINDOWS_DIR, `${liveWindowMeta.winId}.json`);
    const payload = {
      ...liveWindowMeta,
      scheduledCheckTime: CONFIG?.scheduledCheckTime || liveWindowMeta.scheduledCheckTime || '',
      enableScheduledCheck: !!(CONFIG?.enableScheduledCheck ?? liveWindowMeta.enableScheduledCheck),
      mode: (typeof getActiveCheckModeLabel === 'function' ? getActiveCheckModeLabel() : liveWindowMeta.mode) || liveWindowMeta.mode,
      raceQuiet: typeof isRaceQuiet === 'function' ? isRaceQuiet() : !!liveWindowMeta.raceQuiet,
      latency: liveWindowMeta.latency || null,
      lastBeat: Date.now()
    };
    liveWindowMeta = payload;
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  } catch (_) {}
}

function removeLiveWindowRegistry() {
  try {
    const file = path.join(LIVE_WINDOWS_DIR, `${liveWindowMeta.winId}.json`);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch (_) {}
}

function pollLiveRescheduleCommand() {
  try {
    fs.mkdirSync(LIVE_COMMANDS_DIR, { recursive: true });
    const file = path.join(LIVE_COMMANDS_DIR, `${liveWindowMeta.winId}.json`);
    if (!fs.existsSync(file)) return;
    let cmd;
    try {
      cmd = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
      try { fs.unlinkSync(file); } catch (__) {}
      return;
    }
    try { fs.unlinkSync(file); } catch (_) {}

    const action = String(cmd?.action || '').toLowerCase();
    const newTime = String(cmd?.scheduledCheckTime || '').trim();
    if (action !== 'reschedule' || !newTime) return;

    pendingLiveReschedule = {
      scheduledCheckTime: newTime,
      enableScheduledCheck: true,
      at: Date.now()
    };
    liveRescheduleRequested = true;
    updateLiveWindowMeta({
      status: 'reschedule-pending',
      scheduledCheckTime: newTime,
      enableScheduledCheck: true
    });
    log(`\n🔄 أمر إعادة جدولة وصل من المدير → ${newTime}`);
    log(`   ⏳ هيتوقف الانتظار/التشيك الحالي → تسجيل دخول جديد بنفس النافذة\n`);
  } catch (_) {}
}

function startLiveWindowControl({ accountCount = 0 } = {}) {
  liveWindowMeta.accounts = accountCount;
  liveWindowMeta.scheduledCheckTime = CONFIG?.scheduledCheckTime || '';
  liveWindowMeta.enableScheduledCheck = !!CONFIG?.enableScheduledCheck;
  liveWindowMeta.mode = typeof getActiveCheckModeLabel === 'function' ? getActiveCheckModeLabel() : '';
  liveWindowMeta.status = 'running';
  writeLiveWindowRegistry();
  if (liveHeartbeatTimer) clearInterval(liveHeartbeatTimer);
  if (livePollTimer) clearInterval(livePollTimer);
  liveHeartbeatTimer = setInterval(() => writeLiveWindowRegistry(), 2000);
  livePollTimer = setInterval(() => pollLiveRescheduleCommand(), 800);
  log(`📡 Live control: ${liveWindowMeta.winId} | office=${liveWindowMeta.office || 'ALL'} | visa=${liveWindowMeta.visa || '-'}`);
}

function stopLiveWindowControl() {
  if (liveHeartbeatTimer) {
    clearInterval(liveHeartbeatTimer);
    liveHeartbeatTimer = null;
  }
  if (livePollTimer) {
    clearInterval(livePollTimer);
    livePollTimer = null;
  }
  removeLiveWindowRegistry();
}

function clearSessionAuthStateForRelogin() {
  try { tokenExpiryTimes.clear(); } catch (_) {}
  try { accountCookies.clear(); } catch (_) {}
  try { accountRefreshTokens.clear(); } catch (_) {}
  try { accountCurrentTokens.clear(); } catch (_) {}
  try { lastTokenRefreshAt.clear(); } catch (_) {}
  try { accountWafCookies.clear(); } catch (_) {}
  // لازم يتصفروا — وإلا بعد إعادة الجدولة البوت بيعتبر الحسابات وصلت حد الإيقاف ومتبعتش
  try { perAccountRequestCount.clear(); } catch (_) {}
  try { perAccountStopFlags.clear(); } catch (_) {}
  globalStopAtTimeReached = false;
}

async function closeBotBrowser(browser) {
  if (isLiveReschedulePending()) return;
  if (!browser) return;
  try { await browser.close(); } catch (_) {}
}

/** Same as waitUntilNtpEpoch but aborts when manager sends a live reschedule. */
async function waitUntilNtpEpochOrReschedule(targetEpochMs, options = {}) {
  const userStop = options.shouldStop;
  await waitUntilNtpEpoch(targetEpochMs, {
    ...options,
    shouldStop: () => {
      if (isLiveReschedulePending()) return true;
      if (typeof userStop === 'function') return userStop();
      return false;
    }
  });
  throwIfLiveReschedule();
}

/** Run async work over items with a max concurrency (avoids 100+ proxy IP lookups at once). */
async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length || 1));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) break;
      results[i] = await mapper(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// Cap parallel exit-IP lookups — 100+ at once causes proxy / checkip timeouts & 429s
const IP_ASSIGN_CONCURRENCY = Math.max(5, Number(CONFIG.ipAssignConcurrency) || 20);

async function assignIPsBatched(accounts, indexFn = (_account, i) => i) {
  const conc = Math.min(IP_ASSIGN_CONCURRENCY, Math.max(1, accounts.length));
  if (accounts.length > conc) {
    log(`\n⚡ Assigning IPs in batches of ${conc} (${accounts.length} accounts)...`);
  } else {
    log(`\n⚡ Assigning IPs in parallel for speed...`);
  }

  const results = await mapWithConcurrency(accounts, conc, async (account, i) => {
    const index = indexFn(account, i);
    const rateLimitCheck = isRateLimited(account.email);
    if (rateLimitCheck.limited) {
      return { account, index, rateLimited: true };
    }
    try {
      const ipData = await assignUniqueIP(account.email, index);
      return { account, index, ipData, success: true };
    } catch (e) {
      return { account, index, error: e.message, success: false };
    }
  });

  log(`✓ All IPs assigned!\n`);
  return results;
}

/** Seconds before a check cycle to refresh tokens that are about to expire.
 *  Keeps refresh off the strike itself. 0 = old behavior (refresh at check time). */
const PRE_CHECK_REFRESH_DEFAULT_SECONDS = 30;

function getPreCheckRefreshLeadSeconds() {
  const leadRaw = CONFIG.tokenRefresh?.preCheckRefreshSeconds;
  if (leadRaw === undefined || leadRaw === null) return PRE_CHECK_REFRESH_DEFAULT_SECONDS;
  return Math.max(0, parseInt(leadRaw, 10) || 0);
}

/** Aligning the first wave on a clean second boundary costs up to ~1s before the first request.
 *  /checks is only a yes/no poll, so accounts do not compete with each other and that wait buys
 *  nothing — OFF unless config sets syncFire.enabled. */
const SYNC_FIRE_ENABLED = CONFIG.syncFire?.enabled === true;

/** Upper bound on how long a worker may wait to join a synchronized first wave. Keeps a stale
 *  or mis-computed sync target from ever holding a request back. */
const SYNC_FIRE_MAX_WAIT_MS = 2000;

/**
 * Resolve next scheduled check epoch (NTP Cairo). Returns null if scheduling disabled.
 * Does NOT wait — caller prepares work first, then waits right before first request.
 */
function getScheduledCheckTarget(contextLabel = '') {
  if (!CONFIG.enableScheduledCheck || !CONFIG.scheduledCheckTime) {
    return null;
  }

  const scheduledTime = CONFIG.scheduledCheckTime;
  const prefix = contextLabel ? ` (${contextLabel})` : '';
  const cairoWall = parseTimeOfDay(scheduledTime);
  const targetEpoch = nextCairoWallTimeEpochMs(
    cairoWall.hour,
    cairoWall.minute,
    cairoWall.second,
    cairoWall.millisecond
  );
  const waitTimeMs = targetEpoch - ntpNow();

  log(`\n⏰ Scheduled check time${prefix}: ${scheduledTime}`);
  log(`   📡 Clock: Windows | الآن ${formatCairoHms(ntpNow(), true)}`);
  log(`   📍 Parsed: ${cairoWall.hour}:${cairoWall.minute}:${cairoWall.second}.${cairoWall.millisecond}ms`);
  log(`   🎯 الإطلاق المستهدف (Windows Cairo): ${formatCairoHms(targetEpoch, true)}`);
  if (waitTimeMs > 20 * 60 * 60 * 1000) {
    log(`   📅 الوقت عدّى — الانتظار لحد بكرة ${scheduledTime}`);
  }
  log(`   ⏳ Waiting ${Math.floor(waitTimeMs / 60000)}m ${Math.floor((waitTimeMs % 60000) / 1000)}s...`);
  log(`   🎯 التجهيز هيتم قبل الموعد — أول ريكويست عند ${formatCairoHms(targetEpoch, true)} بالظبط`);

  return { targetEpoch, cairoWall, scheduledTime };
}

/** Precise wait until scheduled wall time — call immediately before firing first request.
 *  If a token will be inside the buffer at fire time, refresh it preCheckRefreshSeconds before the strike. */
async function waitForScheduledCheckTime(contextLabel = '', precomputed = null, accountsData = null, browser = null) {
  const target = precomputed || getScheduledCheckTarget(contextLabel);
  if (!target) return false;

  await waitUntilFireWithPreRefresh(
    target.targetEpoch,
    accountsData,
    browser,
    contextLabel || 'scheduled-check',
    { cairoWall: target.cairoWall }
  );
  return true;
}

/**
 * Dress-before-alarm gate for every mode:
 * optional beforeWait prep → NTP wait (token refresh + /checks pre-arm) → return target.
 */
async function runScheduledStrikeGate(label, accountsData, browser, options = {}) {
  if (options.skipIfPerAccount && ENABLE_PER_ACCOUNT_START_TIME) return null;
  if (!CONFIG.enableScheduledCheck || !CONFIG.scheduledCheckTime) return null;
  const target = options.precomputed || getScheduledCheckTarget(label);
  if (!target) return null;
  if (typeof options.beforeWait === 'function') {
    await options.beforeWait(target);
  }
  await waitUntilFireWithPreRefresh(
    target.targetEpoch,
    accountsData,
    browser,
    label || 'scheduled-check',
    { cairoWall: target.cairoWall }
  );
  return target;
}

/** Number of instant retries with the SAME token on empty soft-401 (gateway load-shedding).
 *  The 401 is random (~1 in 10) — 3 retries make a total miss ~0.01%.
 *  Only applies to fresh tokens; 429 (real rate-limit) never retries. */
const _soft401Cfg = CONFIG.tokenRefresh && CONFIG.tokenRefresh.soft401Retries;
const _soft401Parsed = parseInt(_soft401Cfg, 10);
const SOFT_401_RETRIES = Number.isFinite(_soft401Parsed) ? Math.max(0, _soft401Parsed) : 3;

// 💥 BURST-401: rapid same-token retries when the gateway 401s us near drop time.
// Slots are gone within ~0-3s of the mark, so: retry IMMEDIATELY (no artificial delay),
// stop firing new attempts after a short window.
// Policy: OFF by default (single-shot) — the user chose no reactive retry strategy;
// enable it in the manager UI (burst401.enabled) to let a shed slot recover in-window.
const BURST_401_CFG = CONFIG.burst401 || {};
const BURST_401_ENABLED = BURST_401_CFG.enabled === true; // default OFF
const BURST_401_MAX_RETRIES = Math.max(1, parseInt(BURST_401_CFG.maxRetries, 10) || 4);
const BURST_401_DELAY_MS = Math.max(0, parseInt(BURST_401_CFG.retryDelayMs, 10) || 0);
const BURST_401_WINDOW_MS = Math.max(500, parseInt(BURST_401_CFG.maxWindowMs, 10) || 9000);

// 🍪 WAF session cookie (cookiesession1) — keep a live WAF session per account
// (egy.almaviva-visa.it + egyapi sit behind a WAF that re-issues this cookie on every response).
const WAF_COOKIE_CFG = CONFIG.wafCookie || {};
const WAF_COOKIE_ENABLED = WAF_COOKIE_CFG.enabled !== false; // default ON

/** Fast parallel login before a check cycle — new session, keep WAF cookies. */
async function bulkRefreshTokensBeforeCheck(accountsData, browser = null) {
  if (!Array.isArray(accountsData) || accountsData.length === 0) return;
  log(`\n🔐 Pre-check login: تسجيل دخول ${accountsData.length} حساب قبل التشييك...`);
  const t0 = ntpNow();
  let skipped = 0;
  const TOKEN_ENDPOINT = 'https://egyiam.almaviva-visa.it/realms/oauth2-visaSystem-realm-pkce/protocol/openid-connect/token';
  const results = await Promise.all(
    accountsData.map(async (ad) => {
      const email = ad?.account?.email;
      if (!email) return false;
      if (hasRefreshedRecently(email)) {
        skipped++;
        return true;
      }
      try {
        let agent = ad.agent;
        if (!agent) {
          agent = new https.Agent({
            keepAlive: true,
            timeout: 15000,
            rejectUnauthorized: TLS_REJECT_UNAUTHORIZED,
            createConnection: customTlsConnector
          });
        }
        const res = await fetchViaAgent(TOKEN_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': getAccountUserAgent(email),
            'Accept': 'application/json',
            ...getWafCookieHeader(email),
            ...(CONFIG.useSpoofedIPHeaders !== false ? getSpoofedIPHeaders(email) : {})
          },
          body: new URLSearchParams({
            grant_type: 'password',
            client_id: 'aa-visasys-public',
            username: email,
            password: ad.account.password,
            scope: 'openid profile email'
          }).toString(),
          agent
        });
        let tok = null;
        if (res.ok) {
          updateWafCookieFromResponse(email, res);
          const data = await res.json();
          if (data?.access_token) {
            storeAccountToken(email, data.access_token, data.refresh_token);
            setTokenExpiry(email, data.expires_in || null);
            tok = data.access_token;
          }
        }
        if (!tok) {
          tok = await loginViaAPI(ad.account, agent, 1);
        }
        if (tok) {
          ad.token = tok;
          markTokenRefreshed(email);
          if (WAF_COOKIE_ENABLED && !accountWafCookies.has(String(email).toLowerCase())) {
            await acquireWafCookie(email, agent);
          }
          return true;
        }
        return false;
      } catch (_) {
        return false;
      }
    })
  );
  const ok = results.filter(Boolean).length;
  const skipNote = skipped > 0 ? ` (خطّيت ${skipped} اتعمل لهم دخول من قريب)` : '';
  log(`   ✅ Pre-check login: ${ok}/${accountsData.length} ok خلال ${ntpNow() - t0}ms${skipNote}\n`);
}

/** Refresh a single account token quickly (for per-account wave intervals). */
async function refreshOneAccountTokenBeforeWave(accountData) {
  const email = accountData?.account?.email;
  if (!email) return false;
  // 🛡️ Skip if refreshed within the last 2 minutes — avoid double refresh.
  if (hasRefreshedRecently(email)) {
    log(`   ⏭️ [${email}] اتريفريش من قريب — استخدام نفس التوكن`);
    return true;
  }
  try {
    let tok = await directTokenRefresh(email);
    if (!tok) tok = await loginViaAPI(accountData.account, null, 1);
    if (tok) {
      accountData.token = tok;
      markTokenRefreshed(email);
      return true;
    }
  } catch (_) {}
  return false;
}

/** Minutes before scheduled check time to start login / prep (when enabled). */
const LOGIN_BEFORE_CHECK_MINUTES = 2;

function formatTimeOfDayParts({ hour, minute, second = 0, millisecond = 0 }) {
  const base = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
  return `${base}.${String(millisecond).padStart(3, '0')}`;
}

/** Subtract minutes from HH:MM:SS(.mmm), wrapping around midnight. */
function subtractMinutesFromTimeOfDay(timeStr, minutes) {
  const t = parseTimeOfDay(timeStr);
  const dayMs = 24 * 60 * 60 * 1000;
  let totalMs = ((t.hour * 3600 + t.minute * 60 + t.second) * 1000) + t.millisecond;
  totalMs = ((totalMs - minutes * 60 * 1000) % dayMs + dayMs) % dayMs;
  return formatTimeOfDayParts({
    hour: Math.floor(totalMs / 3600000),
    minute: Math.floor((totalMs % 3600000) / 60000),
    second: Math.floor((totalMs % 60000) / 1000),
    millisecond: totalMs % 1000
  });
}

/**
 * Wait until (checkTime − 2 min) before starting login / prep.
 * Only when enableLoginBeforeCheck is on with a scheduled check time.
 * Requests still wait for the actual check time afterward.
 */
async function waitForLoginBeforeCheck() {
  if (
    !CONFIG.enableLoginBeforeCheck ||
    !CONFIG.enableScheduledCheck ||
    !CONFIG.scheduledCheckTime ||
    !String(CONFIG.scheduledCheckTime).trim()
  ) {
    return false;
  }

  const checkTime = String(CONFIG.scheduledCheckTime).trim();
  const loginTime = subtractMinutesFromTimeOfDay(checkTime, LOGIN_BEFORE_CHECK_MINUTES);
  const cairoWall = parseTimeOfDay(loginTime);
  const targetEpoch = nextCairoWallTimeEpochMs(
    cairoWall.hour,
    cairoWall.minute,
    cairoWall.second,
    cairoWall.millisecond
  );
  const waitTimeMs = targetEpoch - ntpNow();

  log(`\n🚀 تسجيل الدخول قبل التشييك بدقيقتين`);
  log(`   📌 وقت التشييك: ${checkTime} → تسجيل الدخول: ${loginTime}`);
  log(`   📡 Clock: Windows | الآن ${formatCairoHms(ntpNow(), true)}`);
  log(`   🎯 الإطلاق المستهدف: ${formatCairoHms(targetEpoch, true)}`);
  log(`   ⏰ بعد اللوجين: انتظار رفع الريكويستات حتى ${checkTime}`);
  if (waitTimeMs > 20 * 60 * 60 * 1000) {
    log(`   📅 الوقت عدّى — الانتظار لحد بكرة ${loginTime}`);
  }

  if (waitTimeMs <= 0) {
    log(`   ✅ وقت تسجيل الدخول حان بالفعل — بدء التجهيز فورًا\n`);
    return true;
  }

  log(`   ⏳ Waiting ${Math.floor(waitTimeMs / 60000)}m ${Math.floor((waitTimeMs % 60000) / 1000)}s قبل بدء تسجيل الدخول...`);

  await waitUntilNtpEpochOrReschedule(targetEpoch, {
    label: 'login-before-check',
    tickEveryMs: 60000,
    spinBeforeMs: 50,
    cairoWall,
    onTick: (remaining) => {
      if (remaining > 2000) {
        log(`   🚀 ${Math.ceil(remaining / 60000)} min remaining حتى بدء تسجيل الدخول...`);
      }
    }
  });

  log(`   ✅ حان وقت تسجيل الدخول (${formatCairoHms(ntpNow(), true)}) — بدء التجهيز...\n`);
  return true;
}

// Wait until a specific per-account scheduled start time (NTP / Africa/Cairo)
async function waitForPerAccountStartTime(account) {
  if (!ENABLE_PER_ACCOUNT_START_TIME) return false;
  
  const scheduledTime = account.scheduledStartTime;
  if (!scheduledTime || !scheduledTime.trim()) return false;

  const { hour, minute, second, millisecond } = parseTimeOfDay(scheduledTime);
  const targetEpoch = nextCairoWallTimeEpochMs(hour, minute, second, millisecond);
  const waitTimeMs = targetEpoch - ntpNow();
  
  log(`\n⏰ [${account.email}] Per-account start time: ${scheduledTime}`);
  log(`   📡 NTP الآن: ${formatCairoHms(ntpNow(), true)}`);
  log(`   📍 [${account.email}] Parsed: ${hour}:${minute}:${second}.${millisecond}ms`);
  log(`   🎯 [${account.email}] الإطلاق: ${formatCairoHms(targetEpoch, true)}`);
  if (waitTimeMs > 20 * 60 * 60 * 1000) {
    log(`   ⚠️ [${account.email}] Time passed today, scheduling for tomorrow`);
  }
  log(`   ⏳ [${account.email}] Waiting ${Math.floor(waitTimeMs / 60000)}m ${Math.floor((waitTimeMs % 60000) / 1000)}s...`);

  await waitUntilNtpEpochOrReschedule(targetEpoch, {
    label: account.email,
    tickEveryMs: 30000,
    onTick: (remaining) => {
      const totalSeconds = Math.ceil(remaining / 1000);
      if (totalSeconds <= 120) {
        log(`   ⏳ [${account.email}] ${totalSeconds}s remaining...`);
      } else {
        log(`   ⏳ [${account.email}] ${Math.floor(totalSeconds / 60)}m remaining...`);
      }
    }
  });

  log(`   ✅ [${account.email}] NTP scheduled time reached at ${formatCairoHms(ntpNow(), true)}!`);
  return true;
}

// 🎭 SPOOFED IP HEADERS (for rate limit bypass)
const EGYPT_ISP_RANGES = [
  { prefix: [41, 32], maxSecond: 47 },
  { prefix: [41, 64], maxSecond: 79 },
  { prefix: [197, 32], maxSecond: 39 },
  { prefix: [102, 40], maxSecond: 47 },
  { prefix: [41, 36], maxSecond: 39 },
];
const ITALY_ISP_RANGES = [
  { prefix: [79, 0], maxSecond: 15 },
  { prefix: [82, 48], maxSecond: 63 },
  { prefix: [87, 0], maxSecond: 15 },
  { prefix: [151, 16], maxSecond: 31 },
  { prefix: [5, 90], maxSecond: 93 },
  { prefix: [37, 159], maxSecond: 163 },
  { prefix: [95, 232], maxSecond: 239 },
  { prefix: [93, 56], maxSecond: 63 },
];

function ipHeaderCountry() {
  const c = String(CONFIG.ipHeaderCountry || 'egypt').toLowerCase();
  return (c === 'italy' || c === 'it') ? 'italy' : 'egypt';
}

function pickIspIP(ranges) {
  const r = ranges[Math.floor(Math.random() * ranges.length)];
  const second = r.prefix[1] + Math.floor(Math.random() * (r.maxSecond - r.prefix[1] + 1));
  return `${r.prefix[0]}.${second}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;
}

function generateRandomIP() {
  return pickIspIP(ipHeaderCountry() === 'italy' ? ITALY_ISP_RANGES : EGYPT_ISP_RANGES);
}

// 🎭 Store spoofed IPs per account (each account gets unique IP)
const accountSpoofedIPs = new Map();

// Get or generate spoofed IP for an account
function getSpoofedIPForAccount(accountEmail) {
  if (!accountSpoofedIPs.has(accountEmail)) {
    const newIP = generateRandomIP();
    accountSpoofedIPs.set(accountEmail, newIP);
    // Spoofed IP generation stays silent (still applied to request headers)
  }
  return accountSpoofedIPs.get(accountEmail);
}

// 🍪 WAF session cookie per account (cookiesession1 set by the WAF in front of egy/egyapi)
const accountWafCookies = new Map();

function extractCookiesession1(setCookieRaw) {
  if (!setCookieRaw) return null;
  const parts = Array.isArray(setCookieRaw) ? setCookieRaw : String(setCookieRaw).split(/,(?=[^;]+=)/);
  for (const part of parts) {
    const m = String(part).match(/cookiesession1=([A-Za-z0-9]+)/i);
    if (m) return m[1];
  }
  return null;
}

function updateWafCookieFromResponse(accountEmail, response) {
  if (!WAF_COOKIE_ENABLED || !accountEmail || !response || !response.headers) return;
  try {
    let raw = null;
    if (typeof response.headers.getSetCookie === 'function') {
      raw = response.headers.getSetCookie();
    } else {
      raw = response.headers.get('set-cookie');
    }
    const value = extractCookiesession1(raw);
    if (value) accountWafCookies.set(String(accountEmail).toLowerCase(), value);
  } catch (_) {}
}

function getWafCookieHeader(accountEmail) {
  if (!WAF_COOKIE_ENABLED || !accountEmail) return {};
  const value = accountWafCookies.get(String(accountEmail).toLowerCase());
  return value ? { 'Cookie': `cookiesession1=${value}` } : {};
}

async function acquireWafCookie(accountEmail, agent = null) {
  if (!WAF_COOKIE_ENABLED || !accountEmail) return null;
  const key = String(accountEmail).toLowerCase();
  // 🍪 Each account acquires its cookie over its OWN fresh HTTP/1.1 connection:
  // the WAF issues cookiesession1 once per TCP/TLS connection (first response only).
  // Sharing the h2 pool made most requests ride already-sessioned connections → no cookie.
  let dedicated = null;
  try {
    // ALWAYS direct (never through Burp): Burp reuses its upstream connections, so the
    // WAF sees one connection and skips Set-Cookie for most requests. A direct dedicated
    // HTTP/1.1 connection guarantees a fresh cookiesession1 per account (proved 12/12).
    dedicated = new Agent({
      connect: customTlsConnector,
      allowH2: false,
      connections: 1,
      pipelining: 1,
      keepAliveTimeout: 1,
      headersTimeout: 15000,
      bodyTimeout: 15000
    });
    for (let tries = 1; tries <= 3 && !accountWafCookies.has(key); tries++) {
      if (tries > 1) await sleep(400);
      const response = await httpFetch('https://egy.almaviva-visa.it/', {
        method: 'GET',
        headers: {
          'User-Agent': getAccountUserAgent(accountEmail),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive'
        },
        dispatcher: dedicated,
        chromeFresh: true,
        timeout: 15000
      }, 'WAF_COOKIE', accountEmail);
      updateWafCookieFromResponse(accountEmail, response);
    }
    const value = accountWafCookies.get(key) || null;
    if (value) {
      log(`   🍪 [${accountEmail}] WAF session acquired (cookiesession1=...${value.slice(-6)})`);
    } else {
      log(`   ⚠️ [${accountEmail}] No cookiesession1 after 2 tries (dedicated connection)`);
    }
    return value;
  } catch (e) {
    log(`   ⚠️ [${accountEmail}] WAF cookie acquisition failed: ${e.message}`);
    return null;
  } finally {
    try { if (dedicated) dedicated.close(); } catch (_) {}
  }
}

// Acquire WAF cookies for many accounts with limited concurrency
async function acquireWafCookiesBulk(accountsData, concurrency = 10) {
  if (!WAF_COOKIE_ENABLED || !Array.isArray(accountsData) || accountsData.length === 0) return;
  const missing = accountsData.filter(ad => ad?.account?.email && !accountWafCookies.has(String(ad.account.email).toLowerCase()));
  if (missing.length === 0) {
    log(`🍪 WAF sessions: ${accountsData.length}/${accountsData.length} already active`);
    return;
  }
  log(`\n🍪 Acquiring WAF session cookies for ${missing.length} account(s)...`);
  await mapWithConcurrency(missing, Math.min(concurrency, missing.length), async (ad) => {
    await acquireWafCookie(ad.account.email, ad.agent || null);
  });
  const total = accountsData.filter(ad => accountWafCookies.has(String(ad.account.email).toLowerCase())).length;
  log(`🍪 WAF sessions ready: ${total}/${accountsData.length}\n`);
}

// 🎭 Fixed per-account browser identity (real browsers keep ONE UA for the whole session)
const accountUserAgents = new Map(); // email -> { userAgent, isFirefox, chromeMajor }

function getAccountUserAgent(accountEmail) {
  const key = String(accountEmail || '').toLowerCase();
  if (!accountUserAgents.has(key)) {
    // 90% Chrome / 10% Firefox — more realistic mix
    const useFirefox = CONFIG.tlsStealth?.enabled ? false : Math.random() < 0.1;
    if (useFirefox) {
      const ff = FIREFOX_AGENTS[Math.floor(Math.random() * FIREFOX_AGENTS.length)];
      accountUserAgents.set(key, { userAgent: ff, isFirefox: true, chromeMajor: null });
    } else {
      const version = CHROME_VERSIONS[Math.floor(Math.random() * CHROME_VERSIONS.length)];
      const platforms = ['windows', 'mac', 'linux'];
      const platform = platforms[Math.floor(Math.random() * platforms.length)];
      accountUserAgents.set(key, {
        userAgent: USER_AGENT_TEMPLATES[platform](version),
        isFirefox: false,
        chromeMajor: String(version.version).split('.')[0]
      });
    }
  }
  return accountUserAgents.get(key).userAgent;
}

function getAccountIdentity(accountEmail) {
  getAccountUserAgent(accountEmail); // ensure generated
  return accountUserAgents.get(String(accountEmail || '').toLowerCase());
}

// 🎯 Modern Chrome Sec-Ch-Ua format, tied to the account's own UA version
function generateSecChUaForAccount(accountEmail) {
  const identity = getAccountIdentity(accountEmail);
  const major = (identity && identity.chromeMajor) || "146";
  return `"Not-A.Brand";v="24", "Chromium";v="${major}"`;
}

// Generate default spoofed IP for non-account requests
const DEFAULT_SPOOFED_IP = generateRandomIP();
log(`🎭 Default spoofed IP for general requests: ${DEFAULT_SPOOFED_IP}`);
log(`   ⚠️ Note: Professional APIs ignore these headers and check actual IP`);

// Get spoofed IP headers to add to requests
// Pass accountEmail to get unique IP per account
// Using only X-Forwarded-For - the most commonly trusted header
// 🎭 Generate random Egyptian ISP IP (WE, Vodafone, Orange, Etisalat)
function generateRandomEgyptianIP() {
  return pickIspIP(EGYPT_ISP_RANGES);
}

function generateRandomIspIP() {
  return generateRandomIP();
}

// 🎭 Get spoofed IP headers to add to requests
// Modes: 'same' = all headers same IP, 'different' = different IP per header, 'egyptian' = Egyptian ISP IP
function getSpoofedIPHeaders(accountEmail = null) {
  const mode = CONFIG.ipHeaderMode || 'same';
  const baseIP = accountEmail ? getSpoofedIPForAccount(accountEmail) : DEFAULT_SPOOFED_IP;

  if (mode === 'egyptian') {
    const ispIP = generateRandomIspIP();
    return {
      'X-Forwarded-For': ispIP,
      'X-Real-IP': ispIP,
      'Client-IP': ispIP,
      'True-Client-IP': ispIP,
      'CF-Connecting-IP': ispIP,
      'Forwarded': `for=${ispIP};proto=https`
    };
  }

  if (mode === 'different') {
    const genRandIP = () => {
      const parts = baseIP.split('.');
      if (parts.length === 4) {
        parts[1] = String(Math.floor(Math.random() * 255));
        parts[2] = String(Math.floor(Math.random() * 255));
        return parts.join('.');
      }
      return baseIP;
    };
    return {
      'X-Forwarded-For': baseIP,
      'X-Real-IP': genRandIP(),
      'Client-IP': genRandIP(),
      'True-Client-IP': genRandIP(),
      'CF-Connecting-IP': genRandIP(),
      'Forwarded': `for=${genRandIP()};proto=https`
    };
  }

  // Default: same IP for all headers
  return {
    'X-Forwarded-For': baseIP,
    'X-Real-IP': baseIP,
    'Client-IP': baseIP,
    'True-Client-IP': baseIP,
    'CF-Connecting-IP': baseIP,
    'Forwarded': `for=${baseIP};proto=https`
  };
}
function generateRealisticHeaders(token, accountEmail = null, includeSecHeaders = true) {
  let userAgent, isFirefox, secChUa;

  if (accountEmail) {
    const identity = getAccountIdentity(accountEmail);
    userAgent = identity.userAgent;
    isFirefox = identity.isFirefox;
    secChUa = generateSecChUaForAccount(accountEmail);
  } else {
    userAgent = getRandomUserAgent();
    isFirefox = userAgent.includes('Firefox');
    secChUa = generateSecChUa();
  }

  // Detect platform from User-Agent
  const isWindows = userAgent.includes('Windows');
  const isMac = userAgent.includes('Macintosh');

  const headers = {
    'Host': 'egyapi.almaviva-visa.it',
    'Accept': 'application/json, text/plain, */*',
    'User-Agent': userAgent,
    // Real site sends the plain language id (e.g. "en") via its Accept-Language interceptor
    'Accept-Language': 'en',
    'Origin': 'https://egy.almaviva-visa.it',
    'Sec-Fetch-Site': 'same-site',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    'Referer': 'https://egy.almaviva-visa.it/',
    'Accept-Encoding': 'gzip, deflate, br',
    'Priority': 'u=1, i',
    'Connection': 'keep-alive',
    'Authorization': `Bearer ${token}`,
    // 🍪 WAF session cookie (kept fresh from every response) — empty when not yet acquired
    ...getWafCookieHeader(accountEmail),
    ...(CONFIG.useSpoofedIPHeaders !== false ? getSpoofedIPHeaders(accountEmail) : {})
  };
  
  // Add realistic Chrome-specific headers if not Firefox
  if (includeSecHeaders && !isFirefox) {
    headers['Sec-Ch-Ua'] = secChUa;
    headers['Sec-Ch-Ua-Platform'] = isMac ? '"macOS"' : (isWindows ? '"Windows"' : '"Linux"');
    headers['Sec-Ch-Ua-Mobile'] = '?0';
  }
  
  // 🔀 Randomize header order
  return randomizeHeaderOrder(headers);
}


// 🎯 TLS STEALTH CONFIGURATION - Chrome-like fingerprint
const TLS_STEALTH_ENABLED = CONFIG.tlsStealth?.enabled === true;

// Chrome-like cipher order (matches real Chrome 120+)
const CHROME_LIKE_CIPHERS = [
  'TLS_AES_128_GCM_SHA256',
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256',
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-CHACHA20-POLY1305',
  'ECDHE-RSA-CHACHA20-POLY1305'
].join(':');

// Create custom TLS connector with Chrome-like settings
const customTlsConnector = buildConnector({
  ciphers: CHROME_LIKE_CIPHERS,
  minVersion: 'TLSv1.2',
  maxVersion: 'TLSv1.3',
  maxCachedSessions: 100,
  timeout: 30000,
  keepAlive: true,
  keepAliveInitialDelay: 1000,
  lookup: cachedLookupAdapter
});

// Custom undici Agent with TLS stealth
const stealthUndiciAgent = new Agent({
  connect: customTlsConnector,
  allowH2: true,
  pipelining: 1,
  connections: 20,
  keepAliveTimeout: 60000,
  headersTimeout: 30000,
  bodyTimeout: 30000
});

if (TLS_STEALTH_ENABLED) {
  log('🎯 Chrome TLS impersonation ENABLED — handshake looks like Chrome, not Node');
}

// undici fetch ignores Node `agent` (HttpsProxyAgent). It only honors `dispatcher`.
// When TLS stealth was on we always forced stealthUndiciAgent → every account saw the real/local IP.
const undiciProxyDispatcherCache = new Map();

function tagProxyAgent(agent, proxyUrl) {
  if (agent && proxyUrl) {
    agent._visaProxyUrl = proxyUrl;
  }
  return agent;
}

function getUndiciProxyDispatcher(proxyUrl) {
  let dispatcher = undiciProxyDispatcherCache.get(proxyUrl);
  if (!dispatcher) {
    // Keep Chrome-like TLS on the *target* connection (after CONNECT through proxy).
    // Without this, proxied requests fell back to Node/undici defaults.
    const requestTls = {
      rejectUnauthorized: TLS_REJECT_UNAUTHORIZED,
      ...(TLS_STEALTH_ENABLED
        ? {
            ciphers: CHROME_LIKE_CIPHERS,
            minVersion: 'TLSv1.2',
            maxVersion: 'TLSv1.3'
          }
        : {})
    };
    dispatcher = new ProxyAgent({
      uri: proxyUrl,
      requestTls,
      proxyTls: { rejectUnauthorized: TLS_REJECT_UNAUTHORIZED }
    });
    undiciProxyDispatcherCache.set(proxyUrl, dispatcher);
  }
  return dispatcher;
}

// 📸 Capture proxy (Burp): route ALL direct (non-proxy) traffic through it for inspection.
// Set "captureProxy": "127.0.0.1:8080" in config — works independently of useProxy.
const CAPTURE_PROXY_CFG = String(CONFIG.captureProxy || '').trim();
let CAPTURE_PROXY_URL = CAPTURE_PROXY_CFG ? `http://${CAPTURE_PROXY_CFG.replace(/^https?:\/\//, '')}` : null;

// 🔎 Probe once at startup: if the capture proxy (Burp) isn't running, disable capture
// automatically so the bot works normally — instead of every request failing.
function probeCaptureProxy() {
  return new Promise((resolve) => {
    if (!CAPTURE_PROXY_URL) return resolve(false);
    try {
      const u = new URL(CAPTURE_PROXY_URL);
      const s = net.connect({ host: u.hostname, port: Number(u.port) || 8080 });
      const done = (ok) => { try { s.destroy(); } catch (_) { } resolve(ok); };
      s.setTimeout(2000);
      s.once('connect', () => done(true));
      s.once('timeout', () => done(false));
      s.once('error', () => done(false));
    } catch (_) { resolve(false); }
  });
}
if (CAPTURE_PROXY_URL) {
  const captureUp = await probeCaptureProxy();
  if (!captureUp) {
    console.log('⚠️ captureProxy (Burp) مش شغال — البوت هيشتغل مباشر من غير تسجيل');
    CAPTURE_PROXY_URL = null;
  } else {
    // Burp presents its own MITM cert — must relax verification for capture to work
    TLS_REJECT_UNAUTHORIZED = false;
    applyTlsLockEnv();
    console.log('📸 captureProxy شغال — كل الريكويستات هتعدي على Burp (TLS verification relaxed)');
  }
}
if (TLS_REJECT_UNAUTHORIZED) {
  console.log('🔒 TLS lock ON — server certificates verified (MITM protection)');
} else if (CONFIG.allowInsecureTls === true) {
  console.log('⚠️ TLS lock OFF — allowInsecureTls=true (certificates not verified)');
} else if (CAPTURE_PROXY_URL) {
  // already logged above
} else {
  console.log('⚠️ TLS lock OFF — certificates not verified');
}
let _captureProxyDispatcher = null;
function getCaptureProxyDispatcher() {
  if (!_captureProxyDispatcher) {
    _captureProxyDispatcher = new ProxyAgent({
      uri: CAPTURE_PROXY_URL,
      requestTls: {
        rejectUnauthorized: TLS_REJECT_UNAUTHORIZED,
        ...(TLS_STEALTH_ENABLED
          ? { ciphers: CHROME_LIKE_CIPHERS, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.3' }
          : {})
      },
      proxyTls: { rejectUnauthorized: TLS_REJECT_UNAUTHORIZED }
    });
  }
  return _captureProxyDispatcher;
}

function resolveUndiciDispatcher(options = {}) {
  if (options.dispatcher) return options.dispatcher;
  const proxyUrl = options.agent?._visaProxyUrl;
  if (proxyUrl) return getUndiciProxyDispatcher(proxyUrl);
  // 📸 Capture proxy: even without a real proxy, send everything through Burp
  if (CAPTURE_PROXY_URL) return getCaptureProxyDispatcher();
  if (TLS_STEALTH_ENABLED) return stealthUndiciAgent;
  return undefined;
}

/** undici-compatible fetch that routes through proxy when agent was built via buildProxyAgent* */
function fetchViaAgent(url, options = {}) {
  return impersonatedFetch(url, options);
}

function headersForChromeImpit(headers) {
  if (!headers || typeof headers !== 'object') return headers;
  const out = { ...headers };
  delete out.Connection;
  delete out.connection;
  delete out['Keep-Alive'];
  delete out['keep-alive'];
  return out;
}

const chromeImpitPool = new Map();
let chromeImpitBroken = false;

function createChromeImpit(proxyUrl = '', timeoutMs = 30000) {
  return new Impit({
    browser: 'chrome',
    ignoreTlsErrors: !TLS_REJECT_UNAUTHORIZED,
    timeout: timeoutMs,
    followRedirects: true,
    ...(proxyUrl ? { proxyUrl } : {})
  });
}

function getSharedChromeImpit(proxyUrl = '') {
  const key = proxyUrl || 'direct';
  if (!chromeImpitPool.has(key)) {
    chromeImpitPool.set(key, createChromeImpit(proxyUrl));
  }
  return chromeImpitPool.get(key);
}

async function undiciFetch(url, options = {}) {
  const { agent, dispatcher, chromeFresh, timeout, ...rest } = options;
  const resolved = resolveUndiciDispatcher({ agent, dispatcher });
  return fetch(url, {
    ...rest,
    ...(resolved ? { dispatcher: resolved } : {})
  });
}

async function impersonatedFetch(url, options = {}) {
  if (!TLS_STEALTH_ENABLED || chromeImpitBroken) {
    return undiciFetch(url, options);
  }
  const { agent, dispatcher, chromeFresh, timeout, ...rest } = options;
  const proxyUrl = agent?._visaProxyUrl
    || (!chromeFresh && CAPTURE_PROXY_URL)
    || '';
  try {
    const client = chromeFresh
      ? createChromeImpit(proxyUrl, timeout || 15000)
      : getSharedChromeImpit(proxyUrl);
    return await client.fetch(url, {
      method: rest.method || 'GET',
      headers: headersForChromeImpit(rest.headers),
      body: rest.body,
      redirect: rest.redirect || 'follow',
      signal: rest.signal,
      ...(timeout ? { timeout } : {})
    });
  } catch (err) {
    if (err?.name === 'AbortError' || rest.signal?.aborted) throw err;
    const msg = String(err?.message || err);
    if (/cannot find|not a function|native|impit|dll|failed to load/i.test(msg)) {
      chromeImpitBroken = true;
      log(`   ⚠️ Chrome TLS unavailable, using Node: ${msg}`);
      return undiciFetch(url, options);
    }
    throw err;
  }
}

// 🚀 HTTPS AGENT - Configurable keepAlive for multi-account support
// Uses the SAME TLS connector as acquireWafCookie → consistent TLS fingerprint
const optimizedHttpsAgent = new https.Agent({
  keepAlive: !DISABLE_KEEP_ALIVE,              // Disable for multiple accounts
  keepAliveMsecs: 1000,
  maxSockets: DISABLE_KEEP_ALIVE ? 1 : 50,     // 1 socket per request if disabled
  maxFreeSockets: DISABLE_KEEP_ALIVE ? 0 : 10,
  maxCachedSessions: 100,
  timeout: 0,
  scheduling: 'fifo',
  rejectUnauthorized: TLS_REJECT_UNAUTHORIZED,
  createConnection: customTlsConnector          // 🔒 Same TLS fingerprint as WAF cookie
});

if (DISABLE_KEEP_ALIVE) {
  log('🔧 KeepAlive DISABLED - Each request gets fresh connection');
} else if (USE_PER_ACCOUNT_AGENT) {
  log('🔧 Per-Account Agents ENABLED - Each account has isolated connections (fast + stable)');
}

// Apply ULTRA-AGGRESSIVE TCP optimizations + Track connection reuse
let connectionReuseCount = 0;
optimizedHttpsAgent.on('socket', (socket) => {
  // 🚀 CRITICAL: TCP_NODELAY - Disable Nagle's algorithm (send immediately!)
  socket.setNoDelay(true);
  
  // TCP Keep-Alive - respect config setting
  if (!DISABLE_KEEP_ALIVE) {
    socket.setKeepAlive(true, 200);  // Send keep-alive every 200ms
  }
  
  // 🚀 Set socket buffer sizes for optimal performance
  try {
    socket.setRecvBufferSize ? socket.setRecvBufferSize(262144) : null;  // 256KB recv (bigger!)
    socket.setSendBufferSize ? socket.setSendBufferSize(262144) : null;  // 256KB send (bigger!)
  } catch (e) {}
  
  // 🚀 Disable socket timeout (we handle timeout at request level)
  socket.setTimeout(0);
  
  // 🚀 CRITICAL: Set TCP priority (QoS) - MAXIMUM priority for our packets!
  try {
    // DSCP EF (Expedited Forwarding) = 0xb8 (DSCP 46) - Highest priority class
    // This tells routers to prioritize our packets over regular traffic
    if (socket.setTOS) {
      socket.setTOS(0xb8);  // DSCP 46 (EF - highest priority)
      // Also try setting IP_TOS for older systems
      socket.setOption && socket.setOption(1, 1, 0xb8);  // SOL_IP, IP_TOS
    }
  } catch (e) {
    // Ignore errors - not all systems support QoS
  }
  
  // Track if this is a reused connection
  if (socket._httpMessage && socket._httpMessage.reusedSocket) {
    connectionReuseCount++;
    if (DEBUG_REQUESTS && connectionReuseCount % 10 === 0) {
      log(`   🚀 Connection reused ${connectionReuseCount} times (faster!)`);  
    }
  }
});

// 🎭 ADVANCED BROWSER FINGERPRINTING - Realistic Randomization
// Multiple Chrome versions for realistic behavior
const CHROME_VERSIONS = [
  { version: '146.0.0.0', webkit: '537.36' }
];

// Platform-specific User-Agents with realistic variations
const USER_AGENT_TEMPLATES = {
  windows: (version) => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/${version.webkit} (KHTML, like Gecko) Chrome/${version.version} Safari/${version.webkit}`,
  mac: (version) => `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/${version.webkit} (KHTML, like Gecko) Chrome/${version.version} Safari/${version.webkit}`,
  linux: (version) => `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/${version.webkit} (KHTML, like Gecko) Chrome/${version.version} Safari/${version.webkit}`
};

// Firefox alternatives (for more realistic browser mix)
const FIREFOX_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:123.0) Gecko/20100101 Firefox/123.0',
  'Mozilla/5.0 (X11; Linux x86_64; rv:122.0) Gecko/20100101 Firefox/122.0'
];

// 🎲 Get random User-Agent with realistic variation
function getRandomUserAgent() {
  // 90% Chrome, 10% Firefox for realistic mix
  const useBrowser = Math.random() < 0.9 ? 'chrome' : 'firefox';
  
  if (useBrowser === 'firefox') {
    return FIREFOX_AGENTS[Math.floor(Math.random() * FIREFOX_AGENTS.length)];
  }
  
  // Chrome: random platform + random version
  const platforms = ['windows', 'mac', 'linux'];
  const platform = platforms[Math.floor(Math.random() * platforms.length)];
  const version = CHROME_VERSIONS[Math.floor(Math.random() * CHROME_VERSIONS.length)];
  
  return USER_AGENT_TEMPLATES[platform](version);
}

// 🎯 Generate realistic Sec-Ch-Ua header values
function generateSecChUa() {
  // Real Chrome returns varying orders and versions
  const chromeVersion = 146;
  const brandOrder = Math.random() < 0.5;
  
  if (brandOrder) {
    return `"Google Chrome";v="${chromeVersion}", "Chromium";v="${chromeVersion}", ";Not A Brand";v="99"`;
  }
  return `";Not A Brand";v="99", "Chromium";v="${chromeVersion}", "Google Chrome";v="${chromeVersion}"`;
}

// 🌍 Generate realistic Accept-Language header
function generateAcceptLanguage() {
  const languages = [
    'en-US,en;q=0.9',
    'en-US,en;q=0.9,fr;q=0.8',
    'en-US,en;q=0.9,es;q=0.8',
    'en-US,en;q=0.9,de;q=0.8,fr;q=0.7',
    'en;q=0.9,en-US;q=0.8',
  ];
  return languages[Math.floor(Math.random() * languages.length)];
}

// 🎲 Random human-like delay (ms)
// OFF unless config sets humanDelay.enabled. Slots disappear within ~1s of the drop, so a
// random pause of up to 3s here loses that race and cancels out the ms-precise NTP strike.
const HUMAN_DELAY_CFG = CONFIG.humanDelay || {};
const HUMAN_DELAY_ENABLED = HUMAN_DELAY_CFG.enabled === true;
const HUMAN_DELAY_MAX_MS = Math.max(0, parseInt(HUMAN_DELAY_CFG.maxMs, 10) || 3000);

// Requests whose timing decides whether an appointment is caught — never delayed, even when
// humanDelay is enabled.
const LATENCY_CRITICAL_LABELS = [
  'ping',
  'IP',
  'CHECK_AVAILABILITY',
  'VERIFY_FREE_SLOTS',
  'GET_MONTHS',
  'GET_DAYS',
  'GET_SLOTS'
];

function isLatencyCriticalLabel(label) {
  return LATENCY_CRITICAL_LABELS.some((critical) => label.includes(critical));
}

async function addHumanDelay() {
  if (!HUMAN_DELAY_ENABLED) return;
  const shortMax = Math.min(500, HUMAN_DELAY_MAX_MS);
  const longSpan = Math.max(0, HUMAN_DELAY_MAX_MS - shortMax);
  const baseDelay = Math.random() < 0.7
    ? Math.random() * shortMax           // 70% of time: short pause
    : shortMax + Math.random() * longSpan; // 30% of time: longer pause
  await sleep(baseDelay);
}

// 🔒 Fixed Chrome-like header order for /checks (do NOT randomize — WAF flags shuffled order)
const CHECKS_HEADER_ORDER = [
  'Host', 'Connection', 'Authorization', 'User-Agent', 'Accept', 'Accept-Language',
  'Origin', 'Sec-Fetch-Site', 'Sec-Fetch-Mode', 'Sec-Fetch-Dest', 'Referer',
  'Accept-Encoding', 'Sec-Ch-Ua', 'Sec-Ch-Ua-Platform', 'Sec-Ch-Ua-Mobile',
  'Priority', 'Cookie', 'X-Forwarded-For', 'X-Real-IP', 'Client-IP',
  'True-Client-IP', 'CF-Connecting-IP', 'Forwarded'
];
function orderHeadersForChecks(headers) {
  const ordered = {};
  for (const k of CHECKS_HEADER_ORDER) {
    if (k in headers) ordered[k] = headers[k];
  }
  for (const [k, v] of Object.entries(headers)) {
    if (!(k in ordered)) ordered[k] = v;
  }
  return ordered;
}

// 🔀 Randomize header order to mimic real browsers
function randomizeHeaderOrder(headers) {
  const entries = Object.entries(headers);
  // Fisher-Yates shuffle
  for (let i = entries.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [entries[i], entries[j]] = [entries[j], entries[i]];
  }
  return Object.fromEntries(entries);
}

// Windows CMD/legacy console draws Arabic LTR without bidi, so logical Arabic looks reversed.
// Reverse Arabic letter runs for console only; keep the file log in correct Unicode.
function fixArabicForWindowsConsole(text) {
  if (process.platform !== 'win32' || typeof text !== 'string') return text;
  return text.replace(
    /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]+/g,
    (run) => [...run].reverse().join('')
  );
}

function log(msg) {
  // أثناء وضع السباق: اسكت اللوج الزيادة (فضل مسار الضربة)
  if (typeof isRaceQuiet === 'function' && isRaceQuiet()) {
    const s = String(msg || '');
    const allow = s.includes('🏎️')
      || s.includes('وضع السباق')
      || s.includes('إعادة جدولة')
      || s.includes('LIVE_RESCHEDULE')
      || s.includes('FATAL')
      || s.includes('⬅️ [CHECK_AVAILABILITY');
    if (!allow) return;
  }
  // Log timestamps follow Cairo wall clock
  const time = formatCairoHms(ntpNow(), true);
  const logLine = `[${time}] ${msg}`;
  console.log(fixArabicForWindowsConsole(logLine));
  try {
    fs.appendFileSync(BOT_LOGS_FILE, logLine + '\n', 'utf8');
  } catch (e) { }
  // Per-session archive (same text + symbols, logical Arabic for Notepad)
  if (BOT_SESSION_LOG_FILE) {
    try {
      fs.appendFileSync(BOT_SESSION_LOG_FILE, logLine + '\n', 'utf8');
    } catch (e) { }
  }
}

// HTTP fetch wrapper with detailed logging
async function httpFetch(url, options = {}, label = '', accountEmail = '') {
  const method = (options.method || 'GET').toUpperCase();
  const startTime = Date.now();
  
  // Use timeout from options or config (no forced limit)
  const timeoutMs = options.timeout || REQUEST_TIMEOUT;
  
  // Create AbortController for timeout
  const controller = new AbortController();
  let timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  // FORCE TIMEOUT MECHANISM: Store trigger function that can be called externally
  if (options.forceTimeoutCallback && typeof options.forceTimeoutCallback === 'function') {
    // Register the force timeout trigger
    const triggerForceTimeout = () => {
      // Clear existing timeout
      clearTimeout(timeoutId);
      // Set immediate timeout (1ms) to abort ASAP
      timeoutId = setTimeout(() => {
        controller.abort();
      }, 1);
    };
    
    // Pass the trigger function to the callback
    options.forceTimeoutCallback(triggerForceTimeout);
  }
  
  // CRITICAL: If external signal exists, listen to it and abort our controller too
  const externalSignal = options.signal;
  let externalAbortHandler = null;
  
  if (externalSignal) {
    // If external signal is already aborted, abort immediately
    if (externalSignal.aborted) {
      controller.abort();
    }
    
    // Listen for external abort and propagate it
    externalAbortHandler = () => {
      // INSTANT ABORT: Don't wait for anything
      controller.abort();
      
      // AGGRESSIVE TCP RST: Destroy sockets IMMEDIATELY
      if (options.agent) {
        // FAST PATH: Destroy all sockets without iteration overhead
        // Each socket destruction is wrapped in try-catch to handle proxy agent sockets
        const destroyAllSockets = (socketMap) => {
          if (!socketMap) return;
          try {
            const allSockets = Object.values(socketMap).flat();
            for (const socket of allSockets) {
              if (socket && !socket.destroyed) {
                try {
                  // Try destroy() first - more compatible with proxy agents
                  socket.destroy();
                } catch (socketErr) {
                  // Ignore individual socket errors - the abort signal will handle cancellation
                }
              }
            }
          } catch (e) {
            // Ignore errors during socket enumeration
          }
        };
        
        // Destroy active sockets FIRST (highest priority)
        destroyAllSockets(options.agent.sockets);
        
        // Destroy free sockets
        destroyAllSockets(options.agent.freeSockets);
        
        // For HttpsProxyAgent, destroy internal agent sockets
        if (options.agent.agent) {
          destroyAllSockets(options.agent.agent.sockets);
          destroyAllSockets(options.agent.agent.freeSockets);
          try {
            if (typeof options.agent.agent.destroy === 'function') {
              options.agent.agent.destroy();
            }
          } catch (e) { /* ignore */ }
        }
        
        // Destroy the agent itself
        try {
          if (typeof options.agent.destroy === 'function') {
            options.agent.destroy();
          }
        } catch (e) { /* ignore */ }
      }
    };
    externalSignal.addEventListener('abort', externalAbortHandler);
  }
  
  try {
    if (DEBUG_REQUESTS) {
      log(`   ➡️ [${label}] ${method} ${url}`);
    }
    
    // Strip Node-only / helper props. undici uses `dispatcher`, not `agent`.
    const { timeout, forceTimeoutCallback, agent, dispatcher, chromeFresh, ...fetchOptions } = options;
    
    // 🎲 Add human-like delay before making request (avoid mechanical timing)
    // Latency-critical calls are exempt — they race the appointment drop.
    if (label && !isLatencyCriticalLabel(label)) {
      await addHumanDelay();
    }
    
    // Prefer proxy dispatcher when agent carries _visaProxyUrl; else TLS stealth direct agent
    const requestSentAt = ntpNow();
    const response = await impersonatedFetch(url, {
      ...fetchOptions,
      agent,
      dispatcher,
      chromeFresh,
      timeout: timeoutMs,
      signal: controller.signal
    });
    
    const duration = Date.now() - startTime;
    
    const who = accountEmail ? ` | ${accountEmail}` : '';
    try { recordCheckLatency(duration, label, accountEmail); } catch (_) {}
    if (!suppressLateHttpLogs) {
      const statusColored = response.status === 200
        ? `\x1b[32m${response.status}\x1b[0m`
        : response.status === 400
          ? `\x1b[33m${response.status}\x1b[0m`
          : response.status === 401
            ? `\x1b[31m${response.status}\x1b[0m`
            : response.status === 500
              ? `\x1b[34m${response.status}\x1b[0m`
              : String(response.status);
      const sentTime = formatCairoHms(requestSentAt, true);
      log(`   ⬅️ [${label}] Status: ${statusColored} ${response.statusText} (${duration}ms) | sent ${sentTime}${who}`);
    }
    
    return response;
  } catch (error) {
    const duration = Date.now() - startTime;
    const who = accountEmail ? ` | ${accountEmail}` : '';
    try { recordCheckLatency(duration, label, accountEmail); } catch (_) {}
    
    if (!suppressLateHttpLogs) {
      if (error.name === 'AbortError') {
        // Check if it was external abort or timeout
        if (externalSignal && externalSignal.aborted) {
          log(`   ✅ [${label}] ABORTED by external signal after ${duration}ms (appointment found)${who}`);
        } else {
          log(`   🔴 [${label}] TIMEOUT after ${duration}ms (>${timeoutMs}ms)${who}`);
        }
      } else {
        log(`   🔴 [${label}] ERROR after ${duration}ms: ${error.message}${who}`);
      }
    }
    
    // No retry - just throw the error immediately
    throw error;
  } finally {
    clearTimeout(timeoutId);
    
    // Clean up external signal listener
    if (externalSignal && externalAbortHandler) {
      externalSignal.removeEventListener('abort', externalAbortHandler);
    }
  }
}

// Track used IPs to prevent duplicates
const usedIPs = new Set();

// Track rate limited accounts and IPs with timestamp
const rateLimitedAccounts = new Map();

// Load rate limited accounts from file
function loadRateLimitedAccounts() {
  try {
    if (fs.existsSync(RATE_LIMITED_FILE)) {
      const data = JSON.parse(fs.readFileSync(RATE_LIMITED_FILE, 'utf8'));
      const now = Date.now();
      
      for (const [email, info] of Object.entries(data)) {
        const timeSinceBan = now - info.timestamp;
        const cooldownMs = RATE_LIMIT_COOLDOWN * 60000;
        
        if (timeSinceBan < cooldownMs) {
          rateLimitedAccounts.set(email, info);
          // Only add to usedIPs if IP is not empty (empty when SKIP_IP_VERIFICATION was enabled)
          if (info.ip && info.ip !== '') {
            usedIPs.add(info.ip);
          }
        }
      }
      
      if (rateLimitedAccounts.size > 0) {
        log(`📋 Loaded ${rateLimitedAccounts.size} rate-limited account(s) from previous session`);
      }
    }
  } catch (e) {
    log(`⚠️ Error loading rate limited accounts: ${e.message}`);
  }
}

// Save rate limited accounts to file
function saveRateLimitedAccounts() {
  try {
    const data = Object.fromEntries(rateLimitedAccounts);
    fs.writeFileSync(RATE_LIMITED_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    log(`⚠️ Error saving rate limited accounts: ${e.message}`);
  }
}

// Add account to rate limited list
// retryAfterMs: server hint (from Retry-After header). If present and longer
// than default cooldown, honor it; otherwise use RATE_LIMIT_COOLDOWN.
function addToRateLimited(email, ip, accountIndex, retryAfterMs = null) {
  // When SKIP_IP_VERIFICATION is enabled, don't register the IP
  // This prevents blocking other accounts that use the same proxy/session
  const effectiveIP = SKIP_IP_VERIFICATION ? '' : ip;

  const now = Date.now();
  const cooldownMs = RATE_LIMIT_COOLDOWN * 60000;
  const hintMs = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 0;
  // Honor server hint, but never shorten the configured safety cooldown.
  const effectiveCooldownMs = Math.max(cooldownMs, hintMs);

  const info = {
    ip: effectiveIP,
    timestamp: now,
    accountIndex,
    dateTime: new Date().toLocaleString('ar-EG'),
    retryAfterMs: hintMs || null,
    cooldownMs: effectiveCooldownMs
  };
  
  rateLimitedAccounts.set(email, info);
  saveRateLimitedAccounts();

  if (SKIP_IP_VERIFICATION) {
    log(`⏸️ [${email}] Added to rate limited list (IP not registered - skip IP verification enabled)`);
  } else {
    log(`⏸️ [${email}] Added to rate limited list with IP: ${ip}`);
  }
  if (hintMs > 0) {
    log(`   Server Retry-After hint: ${Math.ceil(hintMs / 1000)}s (honored, cooldown ${Math.ceil(effectiveCooldownMs / 60000)} min)`);
  } else {
    log(`   Will be available again after ${RATE_LIMIT_COOLDOWN} minutes`);
  }
}

// Check if account or IP is rate limited
function isRateLimited(email, ip = null) {
  const now = Date.now();
  const defaultCooldownMs = RATE_LIMIT_COOLDOWN * 60000;

  if (rateLimitedAccounts.has(email)) {
    const info = rateLimitedAccounts.get(email);
    const cooldownMs = Number.isFinite(info.cooldownMs) && info.cooldownMs > 0
      ? info.cooldownMs
      : defaultCooldownMs;
    const timeSinceBan = now - info.timestamp;

    if (timeSinceBan < cooldownMs) {
      return { limited: true, reason: 'account', remainingMs: cooldownMs - timeSinceBan };
    } else {
      rateLimitedAccounts.delete(email);
      // Only delete from usedIPs if IP is not empty
      if (info.ip && info.ip !== '') {
        usedIPs.delete(info.ip);
      }
      saveRateLimitedAccounts();
      log(`✅ [${email}] Rate limit cooldown expired, account is now available`);
      return { limited: false };
    }
  }
  
  // Skip IP-based rate limiting when proxy is disabled (all accounts share same IP)
  if (ip && USE_PROXY) {
    for (const [limitedEmail, info] of rateLimitedAccounts.entries()) {
      // Skip if stored IP is empty (happens when SKIP_IP_VERIFICATION is enabled)
      if (!info.ip || info.ip === '') continue;

      if (info.ip === ip) {
        const entryCooldownMs = Number.isFinite(info.cooldownMs) && info.cooldownMs > 0
          ? info.cooldownMs
          : defaultCooldownMs;
        const timeSinceBan = now - info.timestamp;
        if (timeSinceBan < entryCooldownMs) {
          return { limited: true, reason: 'ip', email: limitedEmail, remainingMs: entryCooldownMs - timeSinceBan };
        }
      }
    }
  }

  return { limited: false };
}

// --- Per-account client-side pacing (stay under server account quota) ---
// Server keys the account limiter on the JWT identity (sub/email), NOT on
// X-Forwarded-For spoof headers. The only compliant way to avoid 429 is to
// keep per-account RPS low: min interval + jitter, no parallel fan-out per
// account, and honor Retry-After.
const accountLastFireAt = new Map(); // email(lower) -> epoch ms of last /checks fire
const accountFireHistory = new Map(); // email(lower) -> [epoch ms] sliding window
let globalLastFireAt = 0; // epoch ms of last /checks fire across ALL accounts
// visaId:officeId -> epoch ms until which to skip (office-hours 400 circuit breaker)
const closedVisaUntil = new Map();
function getAccountMinIntervalMs() {
  // Base 2500ms keeps 1 account <= ~24 req/min worst-case; sequential mode
  // with 50ms inter-account gap stays far below this per-account.
  const cfg = Number(CONFIG?.accountMinIntervalMs);
  if (Number.isFinite(cfg) && cfg >= 0) return cfg;
  return 2500;
}
function getAccountJitterMs() {
  const cfg = Number(CONFIG?.accountJitterMs);
  if (Number.isFinite(cfg) && cfg >= 0) return cfg;
  return 400;
}

// --- Smart auto-distribution (intelligent mode) ---
// Goal: with N active accounts, fire as fast as possible WITHOUT tripping the
// per-account (sub-based) 429. Each account must wait >= effectivePerAccountMs
// between its own fires. A full round over N accounts takes N*interAccountMs,
// so setting interAccountMs = effectivePerAccountMs / N makes every account
// fire exactly on quota — max aggregate speed, zero 429, no manual tuning.
// Floor by globalFireGapMs so the aggregate burst never trips the IP layer.
function getSmartPacingConfig() {
  return CONFIG?.smartPacing && typeof CONFIG.smartPacing === 'object' ? CONFIG.smartPacing : {};
}
function isSmartPacingEnabled(modeCfg = null) {
  if (modeCfg && typeof modeCfg.smartPacingEnabled === 'boolean') return modeCfg.smartPacingEnabled;
  const g = getSmartPacingConfig();
  if (typeof g.enabled === 'boolean') return g.enabled;
  return true; // default ON: auto-distribute beats hand-tuned delays
}
function getSmartSafetyMargin() {
  const raw = Number(getSmartPacingConfig()?.safetyMargin);
  if (Number.isFinite(raw)) return Math.min(2, Math.max(1, raw));
  return 1.1;
}
function computeSmartSchedule(activeCount) {
  const n = Math.max(1, Math.floor(Number(activeCount) || 1));
  const minInterval = getAccountMinIntervalMs();
  const jitter = getAccountJitterMs();
  const winMax = Number.isFinite(Number(CONFIG?.accountWindowMax)) ? Number(CONFIG.accountWindowMax) : 30;
  const winMs = Number.isFinite(Number(CONFIG?.accountWindowMs)) ? Number(CONFIG.accountWindowMs) : 90000;
  const globalGap = Number.isFinite(Number(CONFIG?.globalFireGapMs)) ? Number(CONFIG.globalFireGapMs) : 300;
  const safety = getSmartSafetyMargin();
  // Long-window average spacing (e.g. 30/90s -> 3000ms) can be stricter than minInterval.
  const windowAvgMs = winMax > 0 && winMs > 0 ? winMs / winMax : 0;
  // Plan on average jitter (actual pace adds 0..jitter randomly); safety covers the spread.
  const effectivePerAccountMs = Math.max(minInterval + jitter / 2, windowAvgMs) * safety;
  let interAccountMs = effectivePerAccountMs / n;
  let flooredByGlobalGap = false;
  if (globalGap > 0 && interAccountMs < globalGap) {
    interAccountMs = globalGap;
    flooredByGlobalGap = true;
  }
  const cycleTimeMs = interAccountMs * n;
  // Round already spans >= effectivePerAccountMs, so next cycle starts immediately.
  const cycleDelayMs = Math.max(0, effectivePerAccountMs - cycleTimeMs);
  const perAccountPerMin = 60000 / Math.max(1, cycleTimeMs);
  const aggregatePerMin = perAccountPerMin * n;
  return {
    n, minInterval, jitter, winMax, winMs, globalGap, safety,
    effectivePerAccountMs: Math.round(effectivePerAccountMs),
    interAccountMs: Math.round(interAccountMs * 10) / 10,
    cycleDelayMs: Math.round(cycleDelayMs * 10) / 10,
    cycleTimeMs: Math.round(cycleTimeMs),
    perAccountPerMin: Math.round(perAccountPerMin * 10) / 10,
    aggregatePerMin: Math.round(aggregatePerMin * 10) / 10,
    flooredByGlobalGap
  };
}
function logSmartSchedule(sched, label = 'SMART') {
  log(`🧠 [${label}] Auto-distribution for ${sched.n} account(s):`);
  log(`   • Per-account spacing: every ~${sched.cycleTimeMs}ms (quota needs >= ${sched.effectivePerAccountMs}ms) → ~${sched.perAccountPerMin}/min each`);
  log(`   • Inter-account gap: ${sched.interAccountMs}ms | Cycle delay: ${sched.cycleDelayMs}ms`);
  log(`   • Aggregate: ~${sched.aggregatePerMin} req/min — max speed without 429`);
  if (sched.flooredByGlobalGap) {
    log(`   ⚠️ Global gap (${sched.globalGap}ms) is the bottleneck: ${sched.n}×${sched.globalGap}ms = ${sched.n * sched.globalGap}ms per-account. Lower globalFireGapMs to go faster.`);
  }
}
async function paceAccountFire(accountEmail) {
  if (!accountEmail) return;
  const key = String(accountEmail).toLowerCase();
  const minInterval = getAccountMinIntervalMs();
  // Sliding window guard: max N fires per W ms per account.
  // Observed live (Study D, 2026-09-15): 500ms x36 -> 429 at #36, 110ms x56 -> 429
  // at #56, 1000ms x40 -> clean, 2500ms x20 -> clean. So cap at 30 / 90s.
  const winMax = Number.isFinite(Number(CONFIG?.accountWindowMax)) ? Number(CONFIG.accountWindowMax) : 30;
  const winMs = Number.isFinite(Number(CONFIG?.accountWindowMs)) ? Number(CONFIG.accountWindowMs) : 90000;
  let arr = accountFireHistory.get(key);
  if (!arr) { arr = []; accountFireHistory.set(key, arr); }
  const now0 = Date.now();
  while (arr.length && now0 - arr[0] > winMs) arr.shift();
  if (arr.length >= winMax) {
    const waitWin = (arr[0] + winMs) - now0 + Math.floor(Math.random() * 500);
    if (waitWin > 8000) {
      // Intelligent skip: don't hold the cycle 60s+ for one hot account.
      // Skip this fire; account will be eligible again once window slides.
      // Return 'skip' so caller exits without HTTP (saves quota).
      log(`   ⏭️ [${accountEmail}] Sliding-window full (${arr.length}/${winMax}) -> skipping this fire`);
      return false;
    }
    if (waitWin > 0) {
      log(`   ⏳ [${accountEmail}] Sliding-window guard: ${arr.length}/${winMax} in ${Math.round(winMs/1000)}s -> waiting ${Math.ceil(waitWin/1000)}s`);
      await sleep(waitWin);
      const now1 = Date.now();
      while (arr.length && now1 - arr[0] > winMs) arr.shift();
    }
  }
  if (minInterval <= 0) {
    accountLastFireAt.set(key, Date.now());
    arr.push(Date.now());
    return;
  }
  // Global inter-fire gap: prevents aggregate IP burst when many accounts fire
  // at the same scheduled millisecond (thundering herd trips the IP layer).
  const globalGap = Number.isFinite(Number(CONFIG?.globalFireGapMs)) ? Number(CONFIG.globalFireGapMs) : 300;
  const lastGlobal = globalLastFireAt;
  const last = accountLastFireAt.get(key) || 0;
  const jitter = Math.floor(Math.random() * (getAccountJitterMs() + 1));
  const now = Date.now();
  const waitMs = Math.max(
    (last + minInterval + jitter) - now,
    globalGap > 0 ? (lastGlobal + globalGap) - now : 0
  );
  if (waitMs > 0) await sleep(waitMs);
  const firedAt = Date.now();
  accountLastFireAt.set(key, firedAt);
  globalLastFireAt = firedAt;
  arr.push(firedAt);
  return true;
}
// Record a fire without waiting (for pre-scheduled modes whose slot timing is
// fixed: clock-burst / trickle). Keeps the sliding-window history accurate so
// the guard still sees these fires.
function recordAccountFire(accountEmail) {
  if (!accountEmail) return false;
  const key = String(accountEmail).toLowerCase();
  const now = Date.now();
  let arr = accountFireHistory.get(key);
  if (!arr) { arr = []; accountFireHistory.set(key, arr); }
  while (arr.length && now - arr[0] > (Number(CONFIG?.accountWindowMs) || 90000)) arr.shift();
  accountLastFireAt.set(key, now);
  globalLastFireAt = now;
  arr.push(now);
  return true;
}
// Parse Retry-After (seconds or HTTP-date) into ms. Returns null if absent.
function parseRetryAfterMs(response) {
  try {
    const raw = response?.headers?.get?.('retry-after');
    if (!raw) return null;
    const s = String(raw).trim();
    if (/^\d+$/.test(s)) return parseInt(s, 10) * 1000;
    const t = Date.parse(s);
    if (Number.isFinite(t)) return Math.max(0, t - Date.now());
  } catch (_) {}
  return null;
}

// Load accounts
function loadAccounts(includeDisabled = false) {
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
      // In Round-Robin mode, return ALL accounts
      if (includeDisabled) {
        return accounts;
      }
      // In normal mode, only return enabled accounts
      return accounts.filter(acc => acc.enabled !== false);
    }
  } catch (e) {
    log('⚠️ Error loading accounts file');
  }
  return [];
}

// Generate unique session ID for each request (not just account)
// This ensures each request gets a fresh connection, avoiding socket hang up issues
function generateSessionId(accountIndex, requestCounter = null) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let sessionId = `acc${accountIndex}_`;
  
  // Add timestamp + request counter for uniqueness per request
  if (requestCounter !== null) {
    sessionId += `req${requestCounter}_`;
  }
  
  // Add random string + timestamp for maximum uniqueness
  sessionId += Date.now().toString(36) + '_';
  
  for (let i = 0; i < 8; i++) {
    sessionId += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  
  return sessionId;
}

// Build proxy agent from proxy string
function buildProxyAgentFromString(proxyString) {
  if (!proxyString) return null;
  
  // Check if it's a SOCKS5 proxy
  if (proxyString.startsWith('socks5://')) {
    // Remove socks5:// prefix
    const proxyData = proxyString.replace('socks5://', '');
    const parts = proxyData.split(':');
    
    // Format: IP:PORT:USERNAME:PASSWORD
    const ip = parts[0];
    const port = parts[1];
    const username = parts[2];
    const password = parts.slice(3).join(':'); // Handle passwords with colons
    
    // Build SOCKS5 URL
    const proxyUrl = `socks5://${username}:${password}@${ip}:${port}`;
    
    const agentOptions = {
      rejectUnauthorized: TLS_REJECT_UNAUTHORIZED,
      keepAlive: !DISABLE_KEEP_ALIVE,
      keepAliveMsecs: 1000,
      maxSockets: DISABLE_KEEP_ALIVE ? 1 : 50,
      maxFreeSockets: DISABLE_KEEP_ALIVE ? 0 : 10,
      timeout: 30000,
      scheduling: 'fifo'
    };
    
    return new SocksProxyAgent(proxyUrl, agentOptions);
  }
  
  // HTTP/HTTPS proxy - Format: HOST:PORT:USERNAME:PASSWORD
  // Username may contain colons (e.g., customer-xxx-sessid-yyy)
  // Password is the LAST part only
  const parts = proxyString.split(':');
  
  if (parts.length < 4) {
    log(`   ❌ Invalid proxy format: ${proxyString}`);
    log(`   ℹ️ Expected format: HOST:PORT:USERNAME:PASSWORD`);
    return null;
  }
  
  const host = parts[0];
  const port = parts[1];
  // Username is everything from index 2 to second-to-last
  // Password is the LAST element only
  const username = parts.slice(2, -1).join(':');
  const password = parts[parts.length - 1];
  
  // Log for debugging
  if (DEBUG_REQUESTS) {
    log(`   🔌 Proxy parsed: host=${host}, port=${port}`);
    log(`   🔌 Username: ${username}`);
    log(`   🔌 Password: ${password.substring(0, 4)}...`);
  }
  
  const proxyUrl = `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
  
  const agentOptions = {
    rejectUnauthorized: TLS_REJECT_UNAUTHORIZED,
    keepAlive: !DISABLE_KEEP_ALIVE,
    keepAliveMsecs: 1000,
    maxSockets: DISABLE_KEEP_ALIVE ? 1 : 50,
    maxFreeSockets: DISABLE_KEEP_ALIVE ? 0 : 10,
    timeout: 30000,
    scheduling: 'fifo'
  };
  
  return tagProxyAgent(new HttpsProxyAgent(proxyUrl, agentOptions), proxyUrl);
}

// Build proxy agent with unique session
function buildProxyAgent(sessionId) {
  if (!USE_PROXY) return null;
  
  const parts = PROXY_BASE.split(':');
  
  if (parts.length < 4) {
    log(`   ❌ Invalid PROXY_BASE format: ${PROXY_BASE}`);
    return null;
  }
  
  const host = parts[0];
  const port = parts[1];
  let username = parts.slice(2, -1).join(':');
  const password = parts[parts.length - 1];
  
  if (USE_PROXY_SESSION && sessionId) {
    // Remove any existing sticky sessid from the base string so each account gets its own
    username = username.replace(/-sessid-[^-\s]+/gi, '');
    username = `${username}-sessid-${sessionId}`;
  }
  
  const proxyUrl = `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
  
  // keepAlive can cause socket hang up with multiple concurrent accounts
  const agentOptions = {
    rejectUnauthorized: TLS_REJECT_UNAUTHORIZED,
    keepAlive: !DISABLE_KEEP_ALIVE,  // Disable if running multiple accounts
    keepAliveMsecs: 1000,
    maxSockets: DISABLE_KEEP_ALIVE ? 1 : 50,  // 1 socket per request if disabled
    maxFreeSockets: DISABLE_KEEP_ALIVE ? 0 : 10,
    timeout: 30000,
    scheduling: 'fifo'  // FIFO is more stable for multiple accounts
  };
  
  return tagProxyAgent(new HttpsProxyAgent(proxyUrl, agentOptions), proxyUrl);
}

// Build proxy agent with specific IP (for 'list' mode)
function buildProxyAgentWithIP(targetIP) {
  if (!USE_PROXY) return null;
  
  const parts = PROXY_BASE.split(':');
  
  if (parts.length < 4) {
    log(`   ❌ Invalid PROXY_BASE format: ${PROXY_BASE}`);
    return null;
  }
  
  const host = parts[0];
  const port = parts[1];
  // Username is everything from index 2 to second-to-last
  let username = parts.slice(2, -1).join(':');
  const password = parts[parts.length - 1];
  
  // Add IP parameter to username for ISP proxy
  username = `${username}-ip-${targetIP}`;
  
  const proxyUrl = `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
  
  const agentOptions = {
    rejectUnauthorized: TLS_REJECT_UNAUTHORIZED,
    keepAlive: !DISABLE_KEEP_ALIVE,
    keepAliveMsecs: 1000,
    maxSockets: DISABLE_KEEP_ALIVE ? 1 : 50,
    maxFreeSockets: DISABLE_KEEP_ALIVE ? 0 : 10,
    timeout: 30000,
    scheduling: 'fifo'
  };
  
  return tagProxyAgent(new HttpsProxyAgent(proxyUrl, agentOptions), proxyUrl);
}

// Get IP address via proxy
async function getCurrentIPViaProxy(agent, maxRetries = 3) {
  // For ISP proxies, use these services in order
  const services = [
    'https://checkip.amazonaws.com',
    'https://api.ipify.org',
    'https://ipapi.co/ip/'
  ];
  
  for (let retry = 0; retry < maxRetries; retry++) {
    for (const service of services) {
      try {
        // httpFetch already has timeout built-in (30 seconds)
        const response = await httpFetch(service, {
          method: 'GET',
          headers: {
            'User-Agent': getRandomUserAgent()
          },
          agent: agent,
          timeout: 30000
        }, 'GET_IP');
        
        if (!response.ok) {
          log(`   ⚠️ ${service} returned status ${response.status}`);
          continue;
        }
        
        const text = await response.text();
        
        // Try to parse as JSON first
        try {
          const json = JSON.parse(text);
          const ip = json.ip || json.query || null;
          if (ip) {
            log(`   ✅ Got IP ${ip} from ${service}`);
            return ip;
          }
        } catch (e) {
          // If not JSON, extract IP from text
          const ipMatch = text.trim().match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
          if (ipMatch) {
            log(`   ✅ Got IP ${ipMatch[0]} from ${service}`);
            return ipMatch[0];
          }
        }
      } catch (e) {
        // Log ALL errors for debugging
        log(`   🔴 Error fetching IP from ${service}: ${e.message}`);
        continue;
      }
    }
    
    if (retry < maxRetries - 1) {
      log(`   🔄 Retry ${retry + 1}/${maxRetries} after 2 seconds...`);
      await sleep(2000);
    }
  }
  
  log(`   ❌ Failed to get IP after ${maxRetries} retries across all services`);
  return null;
}

// Assign unique IP to account
async function assignUniqueIP(accountEmail, accountIndex) {
  log(`🔄 Assigning unique IP to ${accountEmail}...`);
  log(`   🔌 Proxy: ${PROXY_BASE.split(':')[0]}:${PROXY_BASE.split(':')[1]}`);
  log(`   🌐 Mode: ${PROXY_MODE}`);
  
  // If using 'list' mode, assign IP from the list
  if (PROXY_MODE === 'list' && IP_LIST.length > 0) {
    if (accountIndex >= IP_LIST.length) {
      throw new Error(`Not enough IPs in list. Account index ${accountIndex} but only ${IP_LIST.length} IPs available.`);
    }
    
    const proxyString = IP_LIST[accountIndex];
    log(`   📋 Using proxy from list: ${proxyString}`);
    
    // Use buildProxyAgentFromString for direct proxy (SOCKS5 or HTTP)
    const agent = buildProxyAgentFromString(proxyString);
    
    if (!agent) {
      throw new Error(`Failed to build proxy agent from: ${proxyString}`);
    }
    
    // 🚀 FAST MODE: still resolve exit IP once (for logs) — no uniqueness retry loop
    if (SKIP_IP_VERIFICATION) {
      const fakeFallback = `proxy-${accountIndex}`;
      log(`   ⚡ FAST MODE: one-shot IP lookup (no uniqueness retries)`);
      const actualIP = await getCurrentIPViaProxy(agent);
      const ip = actualIP || fakeFallback;
      if (actualIP) {
        log(`   ✅ [${accountEmail}] IP: ${actualIP}`);
      } else {
        log(`   ⚠️ [${accountEmail}] Could not resolve IP — using ${fakeFallback}`);
        log(`   ℹ️ Proxy session is still valid; only the IP label failed (checkip overloaded)`);
      }
      return { sessionId: `proxy-${accountIndex}`, agent, ip };
    }
    
    // Verify the IP by fetching it via proxy
    log(`   🔍 Verifying proxy connection and getting actual IP...`);
    const actualIP = await getCurrentIPViaProxy(agent);
    
    if (!actualIP) {
      throw new Error(`Could not verify proxy connection`);
    }
    
    // Check if IP is rate limited
    const rateLimitCheck = isRateLimited(null, actualIP);
    if (rateLimitCheck.limited) {
      const remainingMinutes = Math.ceil(rateLimitCheck.remainingMs / 60000);
      throw new Error(`IP ${actualIP} is rate limited (used by ${rateLimitCheck.email}), ${remainingMinutes} min remaining`);
    }
    
    usedIPs.add(actualIP);
    log(`   ✅ Assigned IP ${actualIP} to ${accountEmail}`);
    return { sessionId: `ip-${actualIP}`, agent, ip: actualIP };
  }
  
  // Otherwise use session rotation (original behavior)
  log(`   🌐 Zone: ${PROXY_BASE.includes('isp_proxy') ? 'ISP' : 'Residential'}`);
  
  // 🚀 FAST MODE: unique session + one-shot exit IP for logging (no uniqueness retries)
  if (SKIP_IP_VERIFICATION) {
    const sessionId = generateSessionId(accountIndex);
    const agent = buildProxyAgent(sessionId);
    
    log(`   ⚡ FAST MODE: one-shot IP lookup (no uniqueness retries)`);
    if (USE_PROXY_SESSION) {
      log(`   🔑 Session: ${sessionId}`);
    } else {
      log(`   🔄 Rotating Proxy Mode: No sticky session ID`);
    }

    const actualIP = await getCurrentIPViaProxy(agent);
    const ip = actualIP
      || (USE_PROXY_SESSION ? `session-${sessionId}` : `rotating-proxy`);

    if (actualIP) {
      log(`   ✅ [${accountEmail}] IP: ${actualIP}`);
    } else {
      log(`   ⚠️ [${accountEmail}] Could not resolve IP — using ${ip}`);
      log(`   ℹ️ Proxy session is still valid; only the IP label failed (checkip overloaded)`);
    }
    return { sessionId: USE_PROXY_SESSION ? sessionId : null, agent, ip };
  }
  
  let sessionId;
  let agent;
  let ip;
  let attempts = 0;
  const maxAttempts = 20;
  
  while (attempts < maxAttempts) {
    attempts++;
    sessionId = generateSessionId(accountIndex + attempts);
    agent = buildProxyAgent(sessionId);
    
    log(`   🔍 Attempt ${attempts}/${maxAttempts}: Checking IP for session ${sessionId}...`);
    ip = await getCurrentIPViaProxy(agent);
    
    if (!ip) {
      log(`   ⚠️ Could not get IP, retrying...`);
      await sleep(3000);
      continue;
    }
    
    // Check IP prefix only if required
    if (REQUIRE_IP_PREFIX && !ip.startsWith(REQUIRED_IP_PREFIX)) {
      log(`   ❌ IP ${ip} not valid (need ${REQUIRED_IP_PREFIX}*), skipping...`);
      await sleep(500);
      continue;
    }
    
    const rateLimitCheck = isRateLimited(null, ip);
    if (rateLimitCheck.limited) {
      const remainingMinutes = Math.ceil(rateLimitCheck.remainingMs / 60000);
      log(`   ⏸️ IP ${ip} is rate limited (used by ${rateLimitCheck.email}), ${remainingMinutes} min remaining...`);
      await sleep(500);
      continue;
    }
    
    if (!usedIPs.has(ip)) {
      usedIPs.add(ip);
      log(`   ✅ Assigned valid IP ${ip} to ${accountEmail}`);
      return { sessionId, agent, ip };
    }
    
    log(`   ⚠️ IP ${ip} already used, trying new session...`);
    await sleep(2000);
  }
  
  throw new Error(`Could not assign unique IP after ${maxAttempts} attempts`);
}

// Track token expiry times, cookies, refresh tokens, and current tokens
const tokenExpiryTimes = new Map();
const accountCookies = new Map(); // Store cookies for silent refresh
const accountRefreshTokens = new Map(); // Store refresh_token per account for direct refresh
const accountCurrentTokens = new Map(); // Store current access_token for keep-alive
const lastTokenRefreshAt = new Map(); // Track last token refresh time per account (avoid double-refresh collisions)

// Helper to update stored token for an account
function storeAccountToken(email, accessToken, refreshToken = null) {
  if (accessToken) accountCurrentTokens.set(email, accessToken);
  if (refreshToken) accountRefreshTokens.set(email, refreshToken);
  markTokenRefreshed(email);
}

// Mark when an account's token was last refreshed / issued
function markTokenRefreshed(email) {
  if (email) lastTokenRefreshAt.set(email, Date.now());
}

// True if this account got a fresh token within the last `minMs` (default 2 min).
// Used to avoid two refresh calls landing close together (kills the IAM session).
function hasRefreshedRecently(email, minMs = 120000) {
  if (!email) return false;
  const last = lastTokenRefreshAt.get(email);
  if (!last) return false;
  return (Date.now() - last) < minMs;
}

// Token refresh config - loaded from config file
const TOKEN_REFRESH_CONFIG = CONFIG.tokenRefresh || {};
const TOKEN_REFRESH_MINUTES = TOKEN_REFRESH_CONFIG.refreshIntervalMinutes || 8;
const TOKEN_REFRESH_INTERVAL_MS = TOKEN_REFRESH_MINUTES * 60 * 1000;
const ENABLE_AUTO_REFRESH = TOKEN_REFRESH_CONFIG.enableAutoRefresh !== false;
const ENABLE_REACTIVE_REFRESH = TOKEN_REFRESH_CONFIG.enableReactiveRefresh !== false;
const ENABLE_KEEP_ALIVE = TOKEN_REFRESH_CONFIG.enableKeepAlive !== false;
const KEEP_ALIVE_INTERVAL_MINUTES = TOKEN_REFRESH_CONFIG.keepAliveIntervalMinutes || 5;
const TOKEN_REFRESH_BUFFER_SECONDS = TOKEN_REFRESH_CONFIG.refreshBufferSeconds || 120;

log(`🔄 Token Refresh Config:`);
log(`   Refresh Interval: ${TOKEN_REFRESH_MINUTES} minutes`);
log(`   Auto Refresh: ${ENABLE_AUTO_REFRESH ? 'ENABLED' : 'DISABLED'}`);
log(`   Reactive Refresh (on 401): ${ENABLE_REACTIVE_REFRESH ? 'ENABLED' : 'DISABLED'}`);
log(`   Keep-Alive: ${ENABLE_KEEP_ALIVE ? `ENABLED (every ${KEEP_ALIVE_INTERVAL_MINUTES} min)` : 'DISABLED'}`);
log(`   Refresh Buffer: ${TOKEN_REFRESH_BUFFER_SECONDS}s before expiry`);
log(`🏎️ Race Mode: ${RACE_MODE_ENABLED ? `ENABLED (آخر ${Math.round(RACE_MODE_LEAD_MS / 1000)}ث قبل الضربة)` : 'DISABLED'}`);
log(`⚡ Check pre-arm: قبل الضربة بـ ${Math.round(CHECK_PREARM_LEAD_MS / 1000)}ث (URL+headers جاهزين — بدون ريكويست زيادة)`);
log(`💥 Soft-401 burst retry: ${BURST_401_ENABLED ? `ENABLED (up to ${BURST_401_MAX_RETRIES} retries / ${BURST_401_WINDOW_MS}ms window, SAME token, no refresh)` : 'DISABLED (single-shot)'} | API-origin warmup: ${WARMUP_API_ORIGIN ? 'ON' : 'OFF'}`);

// Store refresh_token for an account
function storeRefreshToken(email, refreshToken) {
  if (refreshToken) {
    accountRefreshTokens.set(email, refreshToken);
    markTokenRefreshed(email);
  }
}

// Check if token needs refresh (with buffer before actual expiry)
function needsTokenRefresh(email) {
  if (!ENABLE_AUTO_REFRESH) return false;
  
  const expiryTime = tokenExpiryTimes.get(email);
  if (!expiryTime) return false;
  
  const timeUntilExpiry = expiryTime - Date.now();
  const needsRefresh = timeUntilExpiry <= TOKEN_REFRESH_BUFFER_SECONDS * 1000;
  
  if (needsRefresh) {
    if (timeUntilExpiry <= 0) {
      const minutesOverdue = Math.abs(Math.floor(timeUntilExpiry / 60000));
      log(`   ⏰ Token needs refresh (overdue by ${minutesOverdue} minutes)`);
    } else {
      const secondsLeft = Math.floor(timeUntilExpiry / 1000);
      log(`   ⏰ Token needs refresh (${secondsLeft}s remaining, buffer ${TOKEN_REFRESH_BUFFER_SECONDS}s)`);
    }
  }
  
  return needsRefresh;
}

/** At check fire: if pre-check lead is on, don't delay the request unless the token is already dead. */
function needsTokenRefreshAtCheckTime(email) {
  if (getPreCheckRefreshLeadSeconds() > 0) {
    if (!ENABLE_AUTO_REFRESH) return false;
    const expiryTime = tokenExpiryTimes.get(email);
    if (!expiryTime) return false;
    const timeUntilExpiry = expiryTime - Date.now();
    if (timeUntilExpiry > 0) return false;
    const minutesOverdue = Math.abs(Math.floor(timeUntilExpiry / 60000));
    log(`   ⏰ Token needs refresh (overdue by ${minutesOverdue} minutes)`);
    return true;
  }
  return needsTokenRefresh(email);
}

function accountTokenDueForPreCheckRefresh(email, leadSeconds) {
  if (!ENABLE_AUTO_REFRESH) return false;
  const expiryTime = tokenExpiryTimes.get(email);
  if (!expiryTime) return false;
  const timeUntilExpiry = expiryTime - Date.now();
  const thresholdMs = (TOKEN_REFRESH_BUFFER_SECONDS + Math.max(0, leadSeconds || 0)) * 1000;
  return timeUntilExpiry <= thresholdMs;
}

async function refreshAccountsIfDue(accountsData, browser, leadSeconds = 0) {
  if (!Array.isArray(accountsData) || accountsData.length === 0) return;
  const due = accountsData.filter((ad) => {
    const email = ad?.account?.email;
    if (!email) return false;
    if (hasAccountFoundThisSession(email)) return false;
    if (hasRefreshedRecently(email)) return false;
    return accountTokenDueForPreCheckRefresh(email, leadSeconds);
  });
  if (due.length === 0) return;
  await bulkRefreshTokensBeforeCheck(due, browser);
}

function anyAccountDueBeforeFire(accountsData, targetEpoch) {
  if (!Array.isArray(accountsData) || !ENABLE_AUTO_REFRESH) return false;
  const bufferMs = TOKEN_REFRESH_BUFFER_SECONDS * 1000;
  return accountsData.some((ad) => {
    const email = ad?.account?.email;
    if (!email || hasAccountFoundThisSession(email)) return false;
    const expiryTime = tokenExpiryTimes.get(email);
    if (!expiryTime) return false;
    return (expiryTime - targetEpoch) <= bufferMs;
  });
}

async function waitUntilFireWithPreRefresh(targetEpoch, accountsData, browser, label, extra = {}) {
  const leadSeconds = getPreCheckRefreshLeadSeconds();
  const leadMs = leadSeconds * 1000;
  const fireTick = extra.onTick || ((remaining) => {
    if (remaining > 2000) {
      const sec = Math.ceil(remaining / 1000);
      if (sec <= 120) log(`   ⏳ متبقي ${sec}ث للضربة...`);
    }
  });
  const raceAwareTick = (remaining) => {
    if (RACE_MODE_ENABLED && remaining <= RACE_MODE_LEAD_MS) {
      enterRaceQuiet(`متبقي ${Math.max(1, Math.ceil(remaining / 1000))}ث`);
    }
    if (isRaceQuiet()) return;
    try { fireTick(remaining); } catch (_) {}
  };

  if (leadMs > 0 && anyAccountDueBeforeFire(accountsData, targetEpoch) && ntpNow() < targetEpoch) {
    const refreshAt = targetEpoch - leadMs;
    if (ntpNow() < refreshAt) {
      log(`   🔐 تسجيل دخول (لو التوكن قرب يخلص) قبل الضربة بـ ${leadSeconds}ث (${formatCairoHms(refreshAt, true)})`);
      await waitUntilNtpEpochOrReschedule(refreshAt, {
        label: `${label}-prep`,
        tickEveryMs: 60000,
        spinBeforeMs: 0,
        onTick: (remaining) => {
          if (isRaceQuiet()) return;
          const sec = Math.ceil(remaining / 1000);
          if (sec <= 120) log(`   ⏳ متبقي ${sec}ث لتحديث التوكنات...`);
        }
      });
    }
    throwIfLiveReschedule();
    // متدخلش ريفريش جوه آخر ثواني السباق
    if (!(RACE_MODE_ENABLED && (targetEpoch - ntpNow()) <= RACE_MODE_LEAD_MS)) {
      try {
        await refreshAccountsIfDue(accountsData, browser, leadSeconds);
      } catch (e) {
        if (isLiveRescheduleError(e)) throw e;
        log(`   ⚠️ Pre-check refresh failed: ${e.message} — بنكمل بالتوكنات الحالية`);
      }
    }
  }

  // Pre-arm /checks payloads before the strike (headers+URL only — no HTTP)
  if (ntpNow() < targetEpoch && Array.isArray(accountsData) && accountsData.length > 0) {
    const prepareAt = targetEpoch - CHECK_PREARM_LEAD_MS;
    if (ntpNow() < prepareAt) {
      if (RACE_MODE_ENABLED && (prepareAt - ntpNow()) <= RACE_MODE_LEAD_MS) {
        enterRaceQuiet(`متبقي ${Math.max(1, Math.ceil((targetEpoch - ntpNow()) / 1000))}ث`);
      }
      await waitUntilNtpEpochOrReschedule(prepareAt, {
        label: `${label}-prearm`,
        tickEveryMs: 60000,
        spinBeforeMs: 0,
        onTick: raceAwareTick
      });
      throwIfLiveReschedule();
    }
    prepareCheckRequestsForAccounts(accountsData, 1);
  }

  if (ntpNow() < targetEpoch) {
    if (RACE_MODE_ENABLED && (targetEpoch - ntpNow()) <= RACE_MODE_LEAD_MS) {
      enterRaceQuiet(`متبقي ${Math.max(1, Math.ceil((targetEpoch - ntpNow()) / 1000))}ث`);
    }
    await waitUntilNtpEpochOrReschedule(targetEpoch, {
      label,
      tickEveryMs: 60000,
      spinBeforeMs: 50,
      cairoWall: extra.cairoWall,
      onTick: raceAwareTick
    });
  }
  throwIfLiveReschedule();
  exitRaceQuiet();
}

/** Seconds left until local token expiry (null if unknown). */
function getTokenSecondsRemaining(email) {
  if (!email) return null;
  const expiryTime = tokenExpiryTimes.get(email);
  if (!expiryTime) return null;
  return Math.floor((expiryTime - Date.now()) / 1000);
}

/** Token still has plenty of life — a 401 is likely load-shed / WAF, not real expiry. */
function isTokenStillFresh(email, minSeconds = 180) {
  const rem = getTokenSecondsRemaining(email);
  return rem !== null && rem > minSeconds;
}

/** 🔴 Pre-arm safety margin: never fire a burst whose token could die inside the window.
 *  The IAM issues SHORT refreshed tokens sometimes — measured 2026-09-17: the refresh_token
 *  grant returned expires_in=601s while a full ROPC login returns 900s. */
const PREARM_MIN_TOKEN_SECONDS = Math.max(30, parseInt(TOKEN_REFRESH_CONFIG.preArmMinTokenSeconds, 10) || 180);

/** True only if this mode session can actually be used for the coming burst.
 *  ⚠️ NEVER judge by `acquiredAt` age alone: the age rule (13 min) ignores the REAL expiry, so a
 *  session whose refreshed token got a shorter lifetime looks "fresh" while the token is dead.
 *  That is exactly what happened at the 09:55:00 burst (2026-09-17): the 09:43:55 pre-arm
 *  refreshed with expires_in=601s, so at the 09:53:55 pre-arm the session was 600s old → "fresh"
 *  → no refresh → every account fired an already-expired token → 401 ×8 and a full re-login
 *  inside the drop window. Age is only a cap; real expiry decides. */
function modeSessionFreshForBurst(session) {
  if (!session || !session.token) return false;
  const email = session.account && session.account.email;
  if (ntpNow() - (session.acquiredAt || 0) >= 13 * 60 * 1000) return false;
  const rem = getTokenSecondsRemaining(email);
  if (rem === null) return true;         // expiry unknown (browser path) → keep the age rule
  return rem > PREARM_MIN_TOKEN_SECONDS; // real expiry decides
}

/** Near :00/:05/:10… drop windows (responses often land 0–8s after the mark). */
function isNearAppointmentDropWindow(windowAfterMs = 8000, windowBeforeMs = 1500) {
  const now = typeof ntpNow === 'function' ? ntpNow() : Date.now();
  const d = new Date(now);
  const minute = d.getMinutes();
  const msIntoMinute = d.getSeconds() * 1000 + d.getMilliseconds();
  if (minute % 5 === 0 && msIntoMinute <= windowAfterMs) return true;
  if (minute % 5 === 4 && msIntoMinute >= 60000 - windowBeforeMs) return true;
  return false;
}

// Set token expiry time using real expires_in from server if available
function setTokenExpiry(email, expiresInSeconds = null) {
  const lifetimeMs = expiresInSeconds
    ? expiresInSeconds * 1000
    : TOKEN_REFRESH_INTERVAL_MS;
  const expiryTime = Date.now() + lifetimeMs;
  tokenExpiryTimes.set(email, expiryTime);
  const expiryDate = new Date(expiryTime);
  const label = expiresInSeconds ? `server expiry (${expiresInSeconds}s)` : `${TOKEN_REFRESH_MINUTES} min interval`;
  log(`   ⏰ Token will be refreshed at ${expiryDate.toLocaleTimeString()} (${label})`);
}

// Helper: Generate random string for PKCE
function generateRandomString(length) {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += charset.charAt(Math.floor(Math.random() * charset.length));
  }
  return result;
}

// Helper: Generate code challenge for PKCE
async function generateCodeChallenge(verifier) {
  const crypto = await import('crypto');
  const hash = crypto.createHash('sha256').update(verifier).digest('base64');
  return hash.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// Helper: Extract cookies from Playwright context
async function extractCookies(context) {
  try {
    const cookies = await context.cookies();
    const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    return cookieString;
  } catch (e) {
    log(`   ⚠️ Could not extract cookies: ${e.message}`);
    return null;
  }
}

// Manual Silent Refresh using saved cookies
async function manualSilentRefresh(account) {
  try {
    log(`\n🔄 Attempting silent refresh for ${account.email}...`);
    
    const cookies = accountCookies.get(account.email);
    if (!cookies) {
      log(`   ❌ No saved cookies for ${account.email}`);
      return null;
    }
    
    // Generate PKCE parameters
    const state = generateRandomString(43);
    const codeVerifier = generateRandomString(43);
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    
    // Step 1: Request authorization code
    const authUrl = `https://egyiam.almaviva-visa.it/realms/oauth2-visaSystem-realm-pkce/protocol/openid-connect/auth?` +
      `response_type=code` +
      `&client_id=aa-visasys-public` +
      `&state=${state}` +
      `&redirect_uri=https://egy.almaviva-visa.it/silent-refresh.html` +
      `&scope=openid%20profile%20email` +
      `&code_challenge=${codeChallenge}` +
      `&code_challenge_method=S256` +
      `&nonce=${state}` +
      `&prompt=none`;
    
    log(`   📡 Requesting authorization code...`);
    const authResponse = await impersonatedFetch(authUrl, {
      method: 'GET',
      headers: {
        'Cookie': cookies,
        'User-Agent': getRandomUserAgent(),
        'Referer': 'https://egy.almaviva-visa.it/'
      },
      redirect: 'manual'
    });
    
    if (authResponse.status !== 302) {
      log(`   ❌ Expected 302 redirect, got ${authResponse.status}`);
      return null;
    }
    
    const location = authResponse.headers.get('location');
    if (!location) {
      log(`   ❌ No redirect location in response`);
      return null;
    }
    
    const codeMatch = location.match(/code=([^&]+)/);
    if (!codeMatch) {
      log(`   ❌ No authorization code in redirect`);
      return null;
    }
    
    const code = codeMatch[1];
    log(`   ✅ Got authorization code`);
    
    // Step 2: Exchange code for access token
    log(`   🔐 Exchanging code for access token...`);
    const tokenResponse = await impersonatedFetch(
      'https://egyiam.almaviva-visa.it/realms/oauth2-visaSystem-realm-pkce/protocol/openid-connect/token',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': getRandomUserAgent()
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: code,
          redirect_uri: 'https://egy.almaviva-visa.it/silent-refresh.html',
          client_id: 'aa-visasys-public',
          code_verifier: codeVerifier
        }).toString()
      }
    );
    
    if (!tokenResponse.ok) {
      log(`   ❌ Token exchange failed: ${tokenResponse.status}`);
      return null;
    }
    
    const tokenData = await tokenResponse.json();
    
    if (tokenData.access_token) {
      log(`   ✅ Silent refresh successful! Got new token`);
      log(`   🔑 Token: ${tokenData.access_token.substring(0, 20)}...`);
      return tokenData.access_token;
    }
    
    log(`   ❌ No access_token in response`);
    return null;
    
  } catch (error) {
    log(`   ❌ Silent refresh error: ${error.message}`);
    return null;
  }
}

// Direct refresh_token grant - fastest method (single POST to Keycloak)
async function directTokenRefresh(email) {
  const refreshToken = accountRefreshTokens.get(email);
  if (!refreshToken) {
    log(`   ❌ No refresh token saved for ${email}`);
    return null;
  }
  
  try {
    log(`   📡 Direct refresh_token grant...`);
    const response = await impersonatedFetch(
      'https://egyiam.almaviva-visa.it/realms/oauth2-visaSystem-realm-pkce/protocol/openid-connect/token',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': getRandomUserAgent(),
          'Accept': 'application/json'
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: 'aa-visasys-public',
          refresh_token: refreshToken
        }).toString()
      }
    );
    
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      log(`   ❌ Direct refresh failed: ${response.status} ${errText}`);
      accountRefreshTokens.delete(email); // Stale refresh token, remove it
      return null;
    }
    
    const tokenData = await response.json();
    
    if (tokenData.access_token) {
      log(`   ✅ Direct refresh successful!`);
      log(`   🔑 Token: ${tokenData.access_token.substring(0, 20)}...`);
      
      // Update stored refresh token if server issued a new one
      if (tokenData.refresh_token) {
        accountRefreshTokens.set(email, tokenData.refresh_token);
        log(`   💾 Updated refresh token`);
      }

      // Keep the current-token map in sync, otherwise keep-alive keeps pinging the old token
      accountCurrentTokens.set(email, tokenData.access_token);

      // Use real expires_in from server
      setTokenExpiry(email, tokenData.expires_in || null);
      markTokenRefreshed(email);
      
      return tokenData.access_token;
    }
    
    log(`   ❌ No access_token in direct refresh response`);
    return null;
    
  } catch (error) {
    log(`   ❌ Direct refresh error: ${error.message}`);
    return null;
  }
}

// Keep-alive: ping Keycloak userinfo to prevent server-side session expiry
// Silent background keep-alive — no logs, never blocks the check loop
async function keepAlivePing(email) {
  const token = accountCurrentTokens.get(email);
  if (!token) return;
  
  try {
    await impersonatedFetch(
      'https://egyiam.almaviva-visa.it/realms/oauth2-visaSystem-realm-pkce/protocol/openid-connect/userinfo',
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent': getRandomUserAgent(),
          'Accept': 'application/json'
        }
      }
    );
  } catch (error) {
    // Silently ignore — must not spam logs or affect checking
  }
}

// NEW: Pure API login without browser (faster!) with retry
async function loginViaAPI(account, agent = null, maxRetries = 3) {
  log(`🔐 API Login: ${account.email}`);
  log(`   ⚡ Direct API login (no browser needed)`);
  
  // Create simple agent for API requests (if not provided)
  if (!agent) {
    // Check if we should use proxy for login
    if (USE_PROXY && USE_PROXY_FOR_LOGIN) {
      log(`   🔌 Using proxy for login`);
      // Generate a session for login
      const loginSessionId = generateSessionId(0, Date.now());
      agent = buildProxyAgent(loginSessionId);
    } else {
      log(`   📍 Login WITHOUT proxy (faster)`);
      agent = new https.Agent({
        keepAlive: true,
        timeout: 15000,
        rejectUnauthorized: TLS_REJECT_UNAUTHORIZED,
        createConnection: customTlsConnector    // 🔒 Same TLS fingerprint as WAF cookie
      });
    }
  }
  
  const TOKEN_ENDPOINT = 'https://egyiam.almaviva-visa.it/realms/oauth2-visaSystem-realm-pkce/protocol/openid-connect/token';
  
  // ---- STEP 0: Try direct token grant (grant_type=password) - may bypass OTP entirely ----
  try {
    const ropcResponse = await fetchViaAgent(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': getAccountUserAgent(account.email),
        'Accept': 'application/json',
        ...getWafCookieHeader(account.email),
        ...(CONFIG.useSpoofedIPHeaders !== false ? getSpoofedIPHeaders(account.email) : {})
      },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'aa-visasys-public',
        username: account.email,
        password: account.password,
        scope: 'openid profile email'
      }).toString(),
      agent: agent
    });
    
    if (ropcResponse.ok) {
      updateWafCookieFromResponse(account.email, ropcResponse);
      const tokenData = await ropcResponse.json();
      if (tokenData.access_token) {
        log(`   ✅✅✅ Token obtained directly! (OTP bypassed)`);
        log(`   🔑 Token: ${tokenData.access_token.substring(0, 20)}...`);
        storeAccountToken(account.email, tokenData.access_token, tokenData.refresh_token);
        if (tokenData.refresh_token) log(`   💾 Saved refresh_token for future use`);
        setTokenExpiry(account.email, tokenData.expires_in || null);

        return tokenData.access_token;
      }
    }
    log(`   ⚠️ Direct token grant failed (${ropcResponse.status}), trying login form flow...`);
    if (ropcResponse.status === 400) {
      const errText = await ropcResponse.text();
      log(`   ⚠️ ROPC error: ${errText}`);
    }
  } catch (ropcError) {
    log(`   ⚠️ Direct token grant error: ${ropcError.message}, trying login form flow...`);
  }
  
  // Try up to maxRetries times
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (attempt > 1) {
      log(`   🔄 Retry attempt ${attempt}/${maxRetries}...`);
      await sleep(1000); // Small delay between retries
    }
    
    try {
    // Generate PKCE parameters FIRST (before requesting auth page)
    const state = generateRandomString(43);
    const codeVerifier = generateRandomString(43);
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    const nonce = generateRandomString(43);
    
    log(`   🔑 Generated PKCE parameters`);
    
    // Step 1: Get the login page with our PKCE challenge
    log(`   📄 Requesting auth page...`);
    const loginPageUrl = 'https://egyiam.almaviva-visa.it/realms/oauth2-visaSystem-realm-pkce/protocol/openid-connect/auth?' +
      'client_id=aa-visasys-public&' +
      'redirect_uri=https://egy.almaviva-visa.it/&' +
      'response_type=code&' +
      `state=${state}&` +
      `nonce=${nonce}&` +
      `code_challenge=${codeChallenge}&` +
      'code_challenge_method=S256&' +
      'scope=openid%20profile%20email';
    
    // Add timeout to prevent hanging
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 second timeout
    
    const loginPageResponse = await fetchViaAgent(loginPageUrl, {
      method: 'GET',
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br'
      },
      agent: agent || optimizedHttpsAgent,
      redirect: 'manual',
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    log(`   📊 Response status: ${loginPageResponse.status}`);
    
    // Extract cookies from response (undici uses getSetCookie())
    const setCookieHeaders = loginPageResponse.headers.getSetCookie() || [];
    const cookies = setCookieHeaders.map(cookie => cookie.split(';')[0]).join('; ');
    
    if (!cookies) {
      log(`   ❌ No session cookies received`);
      continue; // Try again
    }
    
    // Get the HTML to extract form action URL
    const html = await loginPageResponse.text();
    
    // Extract the form action URL (contains session_code and execution)
    const actionMatch = html.match(/action="([^"]+)"/);
    if (!actionMatch) {
      log(`   ❌ Could not find login form action URL`);
      continue; // Try again
    }
    
    let actionUrl = actionMatch[1].replace(/&amp;/g, '&');
    
    // Check if actionUrl is already a full URL or just a path
    const fullActionUrl = actionUrl.startsWith('http') 
      ? actionUrl 
      : `https://egyiam.almaviva-visa.it${actionUrl}`;
    
    if (DEBUG_REQUESTS) {
      log(`   🔗 Action URL: ${fullActionUrl}`);
    }
    
    log(`   ✅ Got session cookies and form URL`);
    
    // Step 2: Submit login credentials
    log(`   🔑 Submitting credentials...`);
    const loginResponse = await fetchViaAgent(fullActionUrl, {
      method: 'POST',
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookies,
        'Origin': 'https://egyiam.almaviva-visa.it',
        'Referer': loginPageUrl
      },
      body: new URLSearchParams({
        username: account.email,
        password: account.password,
        credentialId: ''
      }).toString(),
      agent: agent,
      redirect: 'manual'
    });
    
    // Check if login was successful (should get 302 redirect)
    if (loginResponse.status !== 302) {
      log(`   ❌ Login failed: expected 302, got ${loginResponse.status}`);
      continue; // Try again
    }
    
    // Get redirect location (contains authorization code)
    const location = loginResponse.headers.get('location');
    if (!location || !location.includes('code=')) {
      log(`   ❌ No authorization code in redirect`);
      continue; // Try again
    }
    
    // Extract authorization code
    const codeMatch = location.match(/code=([^&]+)/);
    if (!codeMatch) {
      log(`   ❌ Could not parse authorization code`);
      continue; // Try again
    }
    
    const authCode = codeMatch[1];
    log(`   ✅ Got authorization code`);
    
    // Update cookies from login response (undici uses getSetCookie())
    const loginCookies = loginResponse.headers.getSetCookie() || [];
    const allCookies = [...setCookieHeaders, ...loginCookies]
      .map(cookie => cookie.split(';')[0])
      .join('; ');
    
    // Step 3: Exchange code for token using our code_verifier
    log(`   🔐 Exchanging code for token...`);
    const tokenResponse = await fetchViaAgent(
      'https://egyiam.almaviva-visa.it/realms/oauth2-visaSystem-realm-pkce/protocol/openid-connect/token',
      {
        method: 'POST',
        headers: {
          'User-Agent': getRandomUserAgent(),
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
          ...(CONFIG.useSpoofedIPHeaders !== false ? getSpoofedIPHeaders(account.email) : {})
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: authCode,
          redirect_uri: 'https://egy.almaviva-visa.it/',
          client_id: 'aa-visasys-public',
          code_verifier: codeVerifier
        }).toString(),
        agent: agent
      }
    );
    
    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      log(`   ❌ Token exchange failed: ${tokenResponse.status}`);
      log(`   ⚠️ Error: ${errorText}`);
      continue; // Try again
    }
    
    const tokenData = await tokenResponse.json();
    
    if (tokenData.access_token) {
      log(`   ✅✅✅ API login successful!`);
      log(`   🔑 Token: ${tokenData.access_token.substring(0, 20)}...`);
      
      // Save cookies for future refresh
      accountCookies.set(account.email, allCookies);
      storeAccountToken(account.email, tokenData.access_token, tokenData.refresh_token);
      if (tokenData.refresh_token) log(`   💾 Saved refresh_token for future use`);
      setTokenExpiry(account.email, tokenData.expires_in || null);
      
      return tokenData.access_token;
    }
    
      log(`   ❌ No access_token in response`);
      continue; // Try again
      
    } catch (error) {
      if (error.name === 'AbortError') {
        log(`   ❌ API login timeout (15s exceeded)`);
      } else {
        log(`   ❌ API login error: ${error.message}`);
        if (DEBUG_REQUESTS) {
          log(`   🐛 Error stack: ${error.stack}`);
        }
      }
      
      // If this was the last attempt, give up
      if (attempt >= maxRetries) {
        log(`   🚫 All ${maxRetries} API login attempts failed`);
        return null;
      }
      
      // Otherwise continue to next attempt
      continue;
    }
  }
  
  // If we reach here, all retries failed
  log(`   🚫 All ${maxRetries} API login attempts failed`);
  return null;
}

/**
 * Login many accounts with ROPC fired in ONE tight loop (as close to the same moment as possible).
 * Prep sync work first, then start every fetch without awaiting between them.
 * preparedOrAccounts: either account objects, or { account, index, agent, sessionId, ip } entries.
 */
// 🧪 Token validation at LOGIN time (per spec): send a cheap real request with the
// token (userinfo — exactly what the real site calls after login). If the server
// rejects it → refresh → retest, until accepted. Checking never runs on a bad token.
const USERINFO_ENDPOINT = 'https://egyiam.almaviva-visa.it/realms/oauth2-visaSystem-realm-pkce/protocol/openid-connect/userinfo';

async function validateTokenAtLogin(account, token, agent = null, maxAttempts = 3) {
  let currentToken = token;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetchViaAgent(USERINFO_ENDPOINT, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${currentToken}`,
          'Accept': 'application/json',
          'User-Agent': getAccountUserAgent(account.email),
          'Accept-Language': 'en'
        },
        agent: agent || getAgentForAccount(account.email),
        timeout: 15000
      }, 'TOKEN_VALIDATE');
      // 🍪 Free WAF cookie from the validation response too (egyiam issues them per connection)
      updateWafCookieFromResponse(account.email, res);
      if (res.ok) {
        if (attempt > 1) log(`   ✅ [${account.email}] Token accepted by server (attempt ${attempt}/${maxAttempts})`);
        return currentToken;
      }
      log(`   🧪 [${account.email}] Token rejected (HTTP ${res.status}) — refresh & retest (${attempt}/${maxAttempts})`);
    } catch (e) {
      log(`   🧪 [${account.email}] Token test error: ${e.message} — retest (${attempt}/${maxAttempts})`);
    }
    // Token bad or test failed → refresh and try again
    let newToken = null;
    try { newToken = await directTokenRefresh(account.email); } catch (_) {}
    if (!newToken) {
      try { newToken = await loginViaAPI(account, agent, 1); } catch (_) {}
    }
    if (newToken) currentToken = newToken;
  }
  return null;
}

async function loginAccountsSimultaneously(preparedOrAccounts, { browser = null, alreadyPrepared = false } = {}) {
  const TOKEN_ENDPOINT = 'https://egyiam.almaviva-visa.it/realms/oauth2-visaSystem-realm-pkce/protocol/openid-connect/token';

  let entries = [];
  if (alreadyPrepared) {
    entries = preparedOrAccounts.filter((entry) => {
      if (!entry) return false;
      const email = entry.account?.email;
      if (entry.account?.foundAt || hasAccountFoundThisSession(email)) {
        log(`   ${email} - Locked (found) — استرجاع أولاً`);
        return false;
      }
      return true;
    });
  } else {
    const accounts = preparedOrAccounts;
    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];
      if (account.foundAt || hasAccountFoundThisSession(account.email)) {
        log(`   [${i + 1}/${accounts.length}] ${account.email} - Locked (found) — استرجاع أولاً`);
        continue;
      }
      const rateLimitCheck = isRateLimited(account.email);
      if (rateLimitCheck.limited) {
        const remainingMin = Math.ceil(rateLimitCheck.remainingMs / 60000);
        log(`   [${i + 1}/${accounts.length}] ${account.email} - Rate limited (${remainingMin}m)`);
        continue;
      }
      entries.push({ account, index: i, agent: null, sessionId: null, ip: null });
    }
  }

  if (entries.length === 0) return [];

  // Sync prep only — no network yet
  const armed = [];
  for (const entry of entries) {
    const { account, index } = entry;
    let agent = entry.agent;
    if (!agent) {
      agent = new https.Agent({
        keepAlive: true,
        timeout: 15000,
        rejectUnauthorized: TLS_REJECT_UNAUTHORIZED,
        createConnection: customTlsConnector    // 🔒 Same TLS fingerprint as WAF cookie
      });
    }
    armed.push({
      account,
      index,
      agent,
      sessionId: entry.sessionId ?? null,
      ip: entry.ip ?? null,
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'aa-visasys-public',
        username: account.email,
        password: account.password,
        scope: 'openid profile email'
      }).toString()
    });
  }

  log(`⚡ Firing ${armed.length} logins at the same moment (ROPC)...`);
  const fireStartedMs = ntpNow();

  // Tight loop: start ALL fetches before awaiting any of them
  const inflight = [];
  for (const item of armed) {
    inflight.push(
      fetchViaAgent(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': getRandomUserAgent(),
          'Accept': 'application/json',
          ...(CONFIG.useSpoofedIPHeaders !== false ? getSpoofedIPHeaders(item.account.email) : {})
        },
        body: item.body,
        agent: item.agent
      })
        .then(async (res) => {
          if (!res.ok) {
            return { item, token: null, status: res.status };
          }
          // 🍪 The login response itself carries a fresh WAF cookiesession1 — grab it for free
          updateWafCookieFromResponse(item.account.email, res);
          const data = await res.json();
          if (!data?.access_token) {
            return { item, token: null, status: res.status };
          }
          storeAccountToken(item.account.email, data.access_token, data.refresh_token);
          setTokenExpiry(item.account.email, data.expires_in || null);
          return { item, token: data.access_token, status: 200 };
        })
        .catch((err) => ({ item, token: null, status: 0, error: err.message }))
    );
  }

  log(`   🚀 Armed ${inflight.length} login requests in ${ntpNow() - fireStartedMs}ms`);

  const settled = await Promise.all(inflight);
  const accountsData = [];
  let okCount = 0;
  let failCount = 0;

  for (const result of settled) {
    const { item, token } = result;
    let finalToken = token;

    if (!finalToken) {
      log(`   ⚠️ [${item.account.email}] simultaneous ROPC failed — fallback login...`);
      try {
        finalToken = await loginViaAPI(item.account, item.agent, 3);
      } catch (e) {
        log(`   ⚠️ [${item.account.email}] fallback login error: ${e.message}`);
        finalToken = null;
      }
      if (!finalToken && browser) {
        log(`   ⚠️ API login failed, trying browser for ${item.account.email}...`);
        const browserProxy = (item.sessionId || item.ip)
          ? getBrowserProxyConfig(item.sessionId, item.ip)
          : null;
        try {
          finalToken = await loginAndGetToken(item.account, browser, browserProxy);
        } catch (e) {
          log(`   ⚠️ [${item.account.email}] browser login error: ${e.message}`);
          finalToken = null;
        }
      }
    }

    if (finalToken) {
      // 🧪 Validate the token NOW (login time) — refresh+retest until the server accepts it
      finalToken = await validateTokenAtLogin(item.account, finalToken, item.agent, 3);
      if (!finalToken) {
        failCount += 1;
        log(`   ✗ [${item.account.email}] Token rejected after refresh attempts — account dropped`);
        continue;
      }
      const accountData = {
        account: item.account,
        token: finalToken,
        accountIndex: item.index,
        sessionId: item.sessionId,
        agent: item.agent,
        ip: item.ip
      };
      enrichAccountData(accountData);
      item.account._currentAccountData = accountData;
      accountsData.push(accountData);
      okCount += 1;
      log(`   ✓ [${item.account.email}] Success | IP: ${item.ip || 'n/a'}`);
    } else {
      failCount += 1;
      log(`   ✗ [${item.account.email}] Failed | IP: ${item.ip || 'n/a'}`);
    }
  }

  log(`⚡ Simultaneous login done: ${okCount} ok, ${failCount} failed (${ntpNow() - fireStartedMs}ms total)`);
  return accountsData;
}

// Build Playwright proxy config from assigned session/IP
function getBrowserProxyConfig(sessionId = null, targetIP = null) {
  const parts = PROXY_BASE.split(':');
  
  if (parts.length < 4) {
    log(`   ❌ Invalid PROXY_BASE format: ${PROXY_BASE}`);
    return null;
  }
  
  const server = `http://${parts[0]}:${parts[1]}`;
  let username = parts.slice(2, -1).join(':');
  const password = parts[parts.length - 1];

  if (PROXY_MODE === 'list' && targetIP) {
    username = `${username}-ip-${targetIP}`;
  } else if (USE_PROXY_SESSION && sessionId) {
    username = `${username}-sessid-${sessionId}`;
  }
  return { server, username, password };
}

// Login and get token with optional proxy support
async function loginAndGetToken(account, browser, browserProxy = null) {
  if (!browser) {
    log(`   ⏭️ No browser available — skipping browser login for ${account.email} (API login only)`);
    return null;
  }
  log(`🔐 Logging in: ${account.email}`);
  
  let context = null;
  
  try {
    const contextOptions = {
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
      viewport: null,
      locale: "en-US",
      timezoneId: "Africa/Cairo",
      ignoreHTTPSErrors: true,
      permissions: ['geolocation'],
      geolocation: { latitude: 30.0444, longitude: 31.2357 }
    };
    
    // Add proxy to browser context if provided or enabled for login
    if (browserProxy) {
      log(`   🔌 Using assigned proxy for browser login`);
      contextOptions.proxy = browserProxy;
    } else if (USE_PROXY && USE_PROXY_FOR_LOGIN) {
      log(`   🔌 Using proxy for browser login`);
      const loginSessionId = generateSessionId(0, Date.now());
      const p = getBrowserProxyConfig(loginSessionId, null);
      contextOptions.proxy = p;
    } else {
      log(`   📍 Login WITHOUT proxy (faster)`);
    }
    
    context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    
    await page.addInitScript(() => {
      const originalRTCPeerConnection = window.RTCPeerConnection;
      window.RTCPeerConnection = function(...args) {
        const pc = new originalRTCPeerConnection(...args);
        const originalCreateOffer = pc.createOffer;
        pc.createOffer = function() {
          return originalCreateOffer.apply(this, arguments).then(offer => {
            offer.sdp = offer.sdp.replace(/((\d+\.){3}\d+)/g, '0.0.0.0');
            return offer;
          });
        };
        return pc;
      };
      
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined
      });
      
      window.chrome = {
        runtime: {}
      };
    });
    
    let capturedToken = null;
    
    page.on('request', request => {
      const authHeader = request.headers()['authorization'];
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const newToken = authHeader.replace('Bearer ', '');
        
        // Update token if it's different from current one
        if (capturedToken !== newToken) {
          capturedToken = newToken;
          log(`   ✅ Captured token from request header`);
          
          // Update account's token if context already exists (refresh scenario)
          if (account._browserContext && account._currentAccountData) {
            account._currentAccountData.token = newToken;
            setTokenExpiry(account.email);
            log(`   🔄 Auto-updated token in accountData`);
          }
        }
      }
    });
    
    page.on('response', async response => {
      try {
        const url = response.url();
        if (url.includes('/token') || url.includes('/auth') || url.includes('/login') || url.includes('/oauth')) {
          const contentType = response.headers()['content-type'] || '';
          if (contentType.includes('application/json')) {
            const json = await response.json().catch(() => null);
            if (json && json.access_token) {
              const newToken = json.access_token;
              
              // Update token if it's different
              if (capturedToken !== newToken) {
                capturedToken = newToken;
                log(`   ✅ Captured token from response body`);
                
                // Extract refresh_token if present
                if (json.refresh_token) {
                  storeRefreshToken(account.email, json.refresh_token);
                  log(`   💾 Captured refresh_token`);
                }
                storeAccountToken(account.email, newToken, json.refresh_token || null);
                
                // Update account's token if context already exists (refresh scenario)
                if (account._browserContext && account._currentAccountData) {
                  account._currentAccountData.token = newToken;
                  setTokenExpiry(account.email, json.expires_in || null);
                  log(`   🔄 Auto-updated token in accountData`);
                }
              }
            }
          }
        }
      } catch (e) { }
    });
    
    await page.goto('https://egy.almaviva-visa.it/', { timeout: 60000 });
    await page.waitForTimeout(2000);
    
    await page.getByRole("button").filter({ hasText: "person_outline" }).click();
    await page.waitForTimeout(1000);
    
    await page.getByRole("textbox", { name: "Email" }).fill(account.email);
    await page.waitForTimeout(300);
    await page.getByRole("textbox", { name: "Password" }).fill(account.password);
    await page.waitForTimeout(300);
    
    await page.getByRole("button", { name: /Sign ?In|Login/i }).click();
    await page.waitForTimeout(1000);
    
    try {
      await page.waitForURL(/\/home|\/$/,{ timeout: 15000 });
      log(`   ✅ Login page loaded`);
    } catch (e) {
      log(`   ⚠️ Navigation timeout (might still be ok)`);
    }
    
    log(`   ⏳ Waiting for token...`);
    const waitStart = Date.now();
    const maxWait = 15000;
    
    while (!capturedToken && (Date.now() - waitStart) < maxWait) {
      await page.waitForTimeout(1000);
      
      if (!capturedToken) {
        const tokenFromStorage = await page.evaluate(() => {
          const accessToken = sessionStorage.getItem('access_token');
          if (accessToken && accessToken.startsWith('eyJ')) {
            return accessToken;
          }
          for (let i = 0; i < sessionStorage.length; i++) {
            const key = sessionStorage.key(i);
            const value = sessionStorage.getItem(key);
            if (value && value.startsWith('eyJ') && value.length > 100) {
              return value;
            }
          }
          return null;
        }).catch(() => null);
        
        if (tokenFromStorage) {
          capturedToken = tokenFromStorage;
          log(`   ✅ Found token in storage`);
          break;
        }
      }
    }
    
    if (capturedToken) {
      log(`   ✅ Got token successfully (${capturedToken.substring(0, 20)}...)`);
      
      // Try to get refresh_token from sessionStorage for future use
      try {
        const refreshTokenFromStorage = await page.evaluate(() => sessionStorage.getItem('refresh_token')).catch(() => null);
        if (refreshTokenFromStorage) {
          storeRefreshToken(account.email, refreshTokenFromStorage);
          log(`   💾 Captured refresh_token from storage`);
        }
      } catch (e) {}
      
      storeAccountToken(account.email, capturedToken);
      setTokenExpiry(account.email);
      
      // Extract and save cookies for silent refresh
      log(`   💾 Saving cookies for silent refresh...`);
      const cookies = await extractCookies(context);
      if (cookies) {
        accountCookies.set(account.email, cookies);
        log(`   ✅ Cookies saved`);
      }
      
      // IMPORTANT: Close browser context immediately
      log(`   🗑️ Closing browser context...`);
      await context.close();
      log(`   ✅ Browser closed`);
      
      return capturedToken;
    } else {
      log(`   ❌ Could not extract token`);
      if (context) await context.close();
      return null;
    }
  } catch (error) {
    log(`   ❌ Login failed: ${error.message}`);
    if (context) {
      try {
        await context.close();
      } catch (e) {}
    }
    return null;
  }
}

// Refresh token for an account (tries fastest method first)
async function refreshTokenIfNeeded(accountData, browser) {
  const email = accountData.account.email;
  log(`\n🔄 Refreshing token for ${email}...`);
  
  // Step 1: Direct refresh_token grant (fastest - single POST)
  log(`   🔄 Method 1: Direct refresh_token grant...`);
  let newToken = await directTokenRefresh(email);
  
  if (newToken) {
    accountData.token = newToken;
    log(`   ✅ Direct refresh successful!`);
    return newToken;
  }
  
  // Step 2: Silent refresh using saved cookies (PKCE flow)
  log(`   ⚠️ Direct refresh failed, trying silent PKCE refresh...`);
  log(`   🔄 Method 2: Silent PKCE refresh...`);
  newToken = await manualSilentRefresh(accountData.account);
  
  if (newToken) {
    accountData.token = newToken;
    log(`   ✅ Silent PKCE refresh successful!`);
    return newToken;
  }
  
  // Step 3: Try API login (ROPC password grant)
  log(`   ⚠️ Silent refresh failed`);
  log(`   🔄 Method 3: API ROPC login (3 attempts)...`);
  newToken = await loginViaAPI(accountData.account, null, 3);
  
  // Step 4: Fallback to browser login
  if (!newToken) {
    log(`   ⚠️ API login failed after 3 attempts`);
    log(`   🔄 Method 4: Full browser login...`);
    newToken = await loginAndGetToken(accountData.account, browser);
  }
  
  if (newToken) {
    accountData.token = newToken;
    log(`   ✅ Re-login successful, token refreshed`);
    return newToken;
  } else {
    log(`   ❌ Failed to refresh token (all methods failed)`);
    return null;
  }
}

// Get visa types
async function getVisaTypes(officeId, token, agent) {
  const url = `https://egyapi.almaviva-visa.it/configuration-manager/api/visas/v1/list/web?office=${officeId}`;
  
  try {
    const response = await httpFetch(url, {
      method: 'GET',
      headers: generateRealisticHeaders(token),
      agent: agent || optimizedHttpsAgent,
      timeout: REQUEST_TIMEOUT
    }, 'GET_VISA_TYPES');
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const visas = await response.json();
    
    const visaMap = {};
    for (const visa of visas) {
      visaMap[visa.title] = visa.id;
    }
    
    return visaMap;
  } catch (error) {
    const isConnectionError = error.message.includes('ECONNRESET') || 
                              error.message.includes('ETIMEDOUT') ||
                              error.message.includes('ECONNREFUSED') ||
                              error.message.includes('socket hang up') ||
                              error.message.includes('HTTP 401') ||
                              error.message.includes('HTTP 502') ||
                              error.message.includes('HTTP 503');
    
    log(`   ❌ Failed to get visa types: ${error.message}`);
    
    if (isConnectionError) {
      return { error: 'NEED_IP_ROTATION', message: error.message };
    }
    
    return null;
  }
}

// ============================================================================
// FIXED: Check available slots properly
// ============================================================================

// Get available months
async function getAvailableMonths(officeId, visaId, serviceLevelId, token, agent, destination, tripDate, abortSignal = null) {
  let url = `https://egyapi.almaviva-visa.it/reservation-manager/api/planning/v1/months?officeId=${officeId}&visaId=${visaId}&serviceLevelId=${serviceLevelId}`;
  
  if (tripDate) {
    url += `&tripDate=${encodeURIComponent(tripDate)}`;
  }
  
  if (destination) {
    url += `&destination=${encodeURIComponent(destination)}`;
  }
  
  try {
    const response = await httpFetch(url, {
      method: 'GET',
      headers: generateRealisticHeaders(token),
      agent: agent || optimizedHttpsAgent,
      timeout: REQUEST_TIMEOUT,
      signal: abortSignal
    }, 'GET_MONTHS');
    
    if (response.status === 429) {
      return { rateLimited: true, retryAfterMs: parseRetryAfterMs(response) };
    }
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const responseText = await response.text();
    log(`   📝 Raw months response (length: ${responseText.length}): ${responseText}`);
    
    let months;
    try {
      months = JSON.parse(responseText);
      log(`   ✅ Parsed months type: ${typeof months}`);
      log(`   ✅ Parsed months value: ${JSON.stringify(months)}`);
      log(`   ✅ Is array? ${Array.isArray(months)}`);
    } catch (e) {
      log(`   ❌ Failed to parse months response: ${e.message}`);
      return { error: 'Parse error', months: [] };
    }
    
    return { months: months || [] };
  } catch (error) {
    const isConnectionError = error.message.includes('ECONNRESET') || 
                              error.message.includes('ETIMEDOUT') ||
                              error.message.includes('ECONNREFUSED') ||
                              error.message.includes('socket hang up');
    
    if (isConnectionError) {
      return { needIPRotation: true, error: error.message };
    }
    
    return { error: error.message };
  }
}

// Get available days in a month
async function getAvailableDays(officeId, visaId, serviceLevelId, token, agent, destination, tripDate, month, abortSignal = null) {
  let url = `https://egyapi.almaviva-visa.it/reservation-manager/api/planning/v1/days?officeId=${officeId}&visaId=${visaId}&serviceLevelId=${serviceLevelId}&month=${month}`;
  
  if (tripDate) {
    url += `&tripDate=${encodeURIComponent(tripDate)}`;
  }
  
  if (destination) {
    url += `&destination=${encodeURIComponent(destination)}`;
  }
  
  try {
    const response = await httpFetch(url, {
      method: 'GET',
      headers: generateRealisticHeaders(token),
      agent: agent || optimizedHttpsAgent,
      timeout: REQUEST_TIMEOUT,
      signal: abortSignal
    }, 'GET_DAYS');
    
    if (response.status === 429) {
      return { rateLimited: true, retryAfterMs: parseRetryAfterMs(response) };
    }
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const days = await response.json();
    return { days: days || [] };
  } catch (error) {
    const isConnectionError = error.message.includes('ECONNRESET') || 
                              error.message.includes('ETIMEDOUT') ||
                              error.message.includes('ECONNREFUSED') ||
                              error.message.includes('socket hang up');
    
    if (isConnectionError) {
      return { needIPRotation: true, error: error.message };
    }
    
    return { error: error.message };
  }
}

// Get available slots in a day
async function getAvailableSlots(officeId, visaId, serviceLevelId, token, agent, destination, tripDate, date, abortSignal = null) {
  let url = `https://egyapi.almaviva-visa.it/reservation-manager/api/planning/v1/slots?officeId=${officeId}&visaId=${visaId}&serviceLevelId=${serviceLevelId}&date=${date}`;
  
  if (tripDate) {
    url += `&tripDate=${encodeURIComponent(tripDate)}`;
  }
  
  if (destination) {
    url += `&destination=${encodeURIComponent(destination)}`;
  }
  
  try {
    const response = await httpFetch(url, {
      method: 'GET',
      headers: generateRealisticHeaders(token),
      agent: agent || optimizedHttpsAgent,
      timeout: REQUEST_TIMEOUT,
      signal: abortSignal
    }, 'GET_SLOTS');
    
    if (response.status === 429) {
      return { rateLimited: true, retryAfterMs: parseRetryAfterMs(response) };
    }
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const slots = await response.json();
    return { slots: slots || [] };
  } catch (error) {
    const isConnectionError = error.message.includes('ECONNRESET') || 
                              error.message.includes('ETIMEDOUT') ||
                              error.message.includes('ECONNREFUSED') ||
                              error.message.includes('socket hang up');
    
    if (isConnectionError) {
      return { needIPRotation: true, error: error.message };
    }
    
    return { error: error.message };
  }
}

// CRITICAL VERIFICATION: Get FREE slots from the actual booking API
// This is the FINAL check that confirms slots are actually bookable
async function verifyFreeSlots(officeId, date, token, agent, quantity = 1, accountEmail = null) {
  // This is the API the website uses when you click on a date to book
  const url = `https://egyapi.almaviva-visa.it/reservation-manager/api/slots/v1/free?officeId=${officeId}&quantity=${quantity}&date=${date}&type=WEB`;
  
  try {
    const response = await httpFetch(url, {
      method: 'GET',
      headers: generateRealisticHeaders(token, accountEmail),
      agent: agent || (accountEmail ? getAgentForAccount(accountEmail) : optimizedHttpsAgent),
      timeout: REQUEST_TIMEOUT
    }, 'VERIFY_FREE_SLOTS', accountEmail);
    
    // 🍪 Keep the WAF session cookie fresh
    updateWafCookieFromResponse(accountEmail, response);
    
    if (response.status === 401) {
      return { error: 'TOKEN_EXPIRED', tokenExpired: true };
    }
    
    if (response.status === 429) {
      return { rateLimited: true, retryAfterMs: parseRetryAfterMs(response) };
    }
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const freeSlots = await response.json();
    
    // freeSlots is an array of available time slots
    if (Array.isArray(freeSlots) && freeSlots.length > 0) {
      return { 
        success: true, 
        slots: freeSlots,
        count: freeSlots.length 
      };
    }
    
    return { success: false, slots: [], count: 0 };
    
  } catch (error) {
    log(`   ⚠️ Error verifying free slots: ${error.message}`);
    return { error: error.message, success: false };
  }
}

// FAST VERIFICATION: Get available date and verify it has free slots
// This runs IMMEDIATELY after finding appointment (before full details)
async function quickVerifyAppointment(officeId, visaId, serviceLevelId, token, agent, destination, tripDate) {
  try {
    // Step 1: Get the first available month
    const monthsResult = await getAvailableMonths(officeId, visaId, serviceLevelId, token, agent, destination, tripDate);
    
    // FALLBACK: If months API fails, return basic info
    if (!monthsResult.months || monthsResult.months.length === 0) {
      log(`   ⚠️ Months API failed - cannot fetch full details`);
      log(`   ℹ️ Appointment IS available (confirmed by /checks API)`);
      log(`   👉 Please login and book manually - appointment is waiting!`);
      
      return { 
        verified: false, 
        error: 'Months API failed',
        message: 'Appointment confirmed available - book manually',
        requiresManualBooking: true
      };
    }
    
    const month = monthsResult.months[0];
    
    // Step 2: Get the first available day
    const daysResult = await getAvailableDays(officeId, visaId, serviceLevelId, token, agent, destination, tripDate, month);
    
    if (!daysResult.days || daysResult.days.length === 0) {
      return { verified: false, error: 'No days available' };
    }
    
    const day = daysResult.days[0];
    
    // Step 3: CRITICAL - Verify FREE slots
    const verification = await verifyFreeSlots(officeId, day, token, agent, 1);
    
    return {
      verified: verification.success,
      date: day,
      month: month,
      freeSlots: verification.slots || [],
      freeSlotsCount: verification.count || 0
    };
    
  } catch (error) {
    return { verified: false, error: error.message };
  }
}

function buildChecksUrl(officeId, visaId, serviceLevelId) {
  return `https://egyapi.almaviva-visa.it/reservation-manager/api/planning/v1/checks?officeId=${officeId}&visaId=${visaId}&serviceLevelId=${serviceLevelId}`;
}

/** Build /checks headers once (used at pre-arm and as fallback at fire). */
function buildCheckHeaders(token, accountEmail = null) {
  let userAgent, isFirefox, secChUa;
  if (accountEmail) {
    const identity = getAccountIdentity(accountEmail);
    userAgent = identity.userAgent;
    isFirefox = identity.isFirefox;
    secChUa = generateSecChUaForAccount(accountEmail);
  } else {
    userAgent = getRandomUserAgent();
    isFirefox = userAgent.includes('Firefox');
    secChUa = generateSecChUa();
  }
  const isWindows = userAgent.includes('Windows');
  const isMac = userAgent.includes('Macintosh');

  const baseHeaders = {
    'Host': 'egyapi.almaviva-visa.it',
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json, text/plain, */*',
    'User-Agent': userAgent,
    'Accept-Language': 'en',
    'Origin': 'https://egy.almaviva-visa.it',
    'Sec-Fetch-Site': 'same-site',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    'Referer': 'https://egy.almaviva-visa.it/',
    'Accept-Encoding': 'gzip, deflate, br',
    'Priority': 'u=1, i',
    'Connection': 'keep-alive',
    ...getWafCookieHeader(accountEmail),
    ...(CONFIG.useSpoofedIPHeaders !== false ? getSpoofedIPHeaders(accountEmail) : {})
  };

  if (!isFirefox) {
    baseHeaders['Sec-Ch-Ua'] = secChUa;
    baseHeaders['Sec-Ch-Ua-Platform'] = isMac ? '"macOS"' : (isWindows ? '"Windows"' : '"Linux"');
    baseHeaders['Sec-Ch-Ua-Mobile'] = '?0';
  }

  return orderHeadersForChecks(baseHeaders);
}

function prepareCheckRequestForAccount(accountData, serviceLevelId = 1) {
  if (!accountData?.account?.email || !accountData.token) return false;
  enrichAccountData(accountData);
  const email = accountData.account.email;
  const officeId = accountData.officeId || OFFICE_ID;
  const visaId = accountData.visaId;
  if (!visaId) return false;
  preparedCheckByEmail.set(emailKey(email), {
    url: buildChecksUrl(officeId, visaId, serviceLevelId),
    headers: buildCheckHeaders(accountData.token, email),
    officeId,
    visaId,
    serviceLevelId,
    token: accountData.token,
    preparedAt: ntpNow()
  });
  return true;
}

function prepareCheckRequestsForAccounts(accountsData, serviceLevelId = 1) {
  let n = 0;
  for (const ad of accountsData || []) {
    try {
      if (prepareCheckRequestForAccount(ad, serviceLevelId)) n++;
    } catch (_) {}
  }
  if (n > 0 && !isRaceQuiet()) {
    log(`   ⚡ Pre-armed ${n} /checks request(s) قبل الضربة بـ ~${Math.round(CHECK_PREARM_LEAD_MS / 1000)}ث`);
  }
  return n;
}

function getPreparedCheckRequest(accountEmail, officeId, visaId, serviceLevelId, token) {
  if (!accountEmail) return null;
  const key = emailKey(accountEmail);
  const prep = preparedCheckByEmail.get(key);
  if (!prep) return null;
  if (ntpNow() - prep.preparedAt > PREPARED_CHECK_MAX_AGE_MS) {
    preparedCheckByEmail.delete(key);
    return null;
  }
  if (prep.officeId !== officeId || prep.visaId !== visaId || prep.serviceLevelId !== serviceLevelId) {
    return null;
  }
  if (token && prep.token !== token) {
    preparedCheckByEmail.delete(key);
    return null;
  }
  return prep;
}

// SIMPLE CHECK: Use /checks endpoint (like the website does)
async function checkAvailability(officeId, visaId, serviceLevelId, token, agent, destination, tripDate, abortSignal = null, forceTimeoutCallback = null, accountEmail = null, skipPace = false) {
  // CRITICAL: Check if already aborted BEFORE making request
  if (abortSignal && abortSignal.aborted) {
    return { found: false, cancelled: true, reason: 'aborted-before-request' };
  }
  
  // 🍪 Get cookies for this account (if available)
  const accountCookie = accountEmail && accountCookies.get(accountEmail);
  if (DEBUG_REQUESTS && accountCookie) {
    log(`   🍪 Using session cookies for ${accountEmail}`);
  }
  
  // Single-shot: URL may come from pre-arm, but headers are ALWAYS rebuilt fresh at fire
  // with the latest WAF cookie. Never reuse prepared.headers (stale cookiesession1).
  const prepared = getPreparedCheckRequest(accountEmail, officeId, visaId, serviceLevelId, token);
  const checkUrl = prepared?.url || buildChecksUrl(officeId, visaId, serviceLevelId);
  if (accountEmail) preparedCheckByEmail.delete(emailKey(accountEmail));

  // Office-hours circuit breaker (parking DISABLED by user choice — kept as a
  // safety net only; nothing sets the map anymore, so this never skips).
  const closedKey = `${officeId}:${visaId}`;
  const closedUntil = closedVisaUntil.get(closedKey) || 0;
  if (Date.now() < closedUntil) {
    return { found: false, outsideOfficeHours: true, skippedClosed: true, error: 'OFFICE_CLOSED_CIRCUIT' };
  }

  const startTime = Date.now();
  try {
    if (chromeImpitBroken) {
      log(`   ⚠️ [${accountEmail || 'unknown'}] Chrome TLS unavailable — sending via Node stack (higher WAF risk)`);
    }
    // Per-account pacing: never fire faster than minInterval+jitter for same email.
    // This is the primary defense against the account (sub-based) 429.
    // Returns false when window is full -> skip HTTP entirely (intelligent).
    // skipPace=true (clock-burst/trickle): slot timing is fixed by the mode, so
    // don't delay — just record the fire to keep window history accurate.
    const canFire = skipPace
      ? (recordAccountFire(accountEmail), true)
      : await paceAccountFire(accountEmail);
    if (canFire === false) {
      return { found: false, skippedPacing: true, latencyMs: Date.now() - startTime };
    }
    const headers = buildCheckHeaders(token, accountEmail);
    
    const response = await httpFetch(checkUrl, {
      method: 'GET',
      headers: headers,
      agent: agent || (accountEmail ? getAgentForAccount(accountEmail) : optimizedHttpsAgent),
      signal: abortSignal,
      timeout: CHECKS_TIMEOUT,
      forceTimeoutCallback: forceTimeoutCallback
    }, 'CHECK_AVAILABILITY', accountEmail);
    
    const duration = Date.now() - startTime;
    
    // 🍪 Keep the WAF session cookie fresh (the WAF re-issues it on every response)
    updateWafCookieFromResponse(accountEmail, response);
    
    if (response.status === 401) {
      const rem = getTokenSecondsRemaining(accountEmail);
      // Record authentication diagnostics without assuming which server layer rejected us.
      // The malformed-token probe returned WWW-Authenticate: invalid_token, but captured
      // intermittent 401s had no challenge header. These are different observations:
      // an empty body or a missing challenge does not prove WAF blocking or load shedding.
      let bodySnippet = '';
      try { bodySnippet = ((await response.text()) || '').replace(/\s+/g, ' ').trim().slice(0, 200); } catch (_) {}
      let wwwAuth = '';
      try { wwwAuth = String(response.headers.get('www-authenticate') || '').slice(0, 160); } catch (_) {}
      let serverHdr = '';
      try { serverHdr = String(response.headers.get('server') || '').slice(0, 40); } catch (_) {}
      const bodyNote = `${bodySnippet ? ` | body: ${bodySnippet}` : ' | body: <empty>'}`
        + `${wwwAuth ? ` | www-authenticate: ${wwwAuth}` : ''}`
        + `${serverHdr ? ` | server: ${serverHdr}` : ''}`;
      // SOFT 401: token still fresh → the platform transiently refused a token it had just
      // accepted (measured 2026-09-17 09:35: same token 401 at :02.595 and 200 at :12.159,
      // with NO login/refresh in between — the pre-arm that cycle said "All 4 sessions
      // fresh"). So: same token, NO refresh — but DO retry. The drop window is the only
      // chance at a slot, and the old single-shot path silently burned one probe per burst.
      if (accountEmail && isTokenStillFresh(accountEmail, 120)) {
        const burstRetries = BURST_401_ENABLED ? BURST_401_MAX_RETRIES : Math.max(0, SOFT_401_RETRIES);
        log401(accountEmail, `401 on /checks (token fresh ~${rem}s) → ${burstRetries > 0 ? `burst retries (max ${burstRetries})` : 'single-shot, no retry'}${bodyNote}`);
        if (!SEQUENTIAL_QUIET_LOGS) {
          log(`   ⚡ Soft 401 (token still ~${rem}s) — same token, no refresh${burstRetries > 0 ? `, up to ${burstRetries} burst retries` : ''}${wwwAuth ? ` | ${wwwAuth.slice(0, 90)}` : ''}`);
        }
        if (burstRetries > 0) {
          // Slots open/close within ~0-3s of the mark → retry IMMEDIATELY (no refresh, no
          // pacing delay). The window cap stops a congested edge from dragging the rest of
          // the burst schedule past the drop.
          const burstStart = ntpNow();
          let retryResponse = null;
          let retryDuration = duration;
          for (let attempt = 1; attempt <= burstRetries; attempt++) {
            if ((ntpNow() - burstStart) > BURST_401_WINDOW_MS) {
              if (!SEQUENTIAL_QUIET_LOGS) {
                log(`   ⏹️ Burst window (${BURST_401_WINDOW_MS}ms) over — stop firing (used ${attempt - 1}/${burstRetries})`);
              }
              break;
            }
            if (BURST_401_DELAY_MS > 0) await sleep(BURST_401_DELAY_MS);
            try {
              // Headers rebuilt per retry → carries the cookiesession1 the 401 response re-issued.
              retryResponse = await httpFetch(checkUrl, {
                method: 'GET',
                headers: buildCheckHeaders(token, accountEmail),
                agent: agent || (accountEmail ? getAgentForAccount(accountEmail) : optimizedHttpsAgent),
                signal: abortSignal,
                timeout: CHECKS_TIMEOUT,
                forceTimeoutCallback: forceTimeoutCallback
              }, `CHECK_AVAILABILITY_BURST${attempt}`, accountEmail);
            } catch (retryErr) {
              retryDuration = Date.now() - startTime;
              if (abortSignal && abortSignal.aborted) return { found: false, cancelled: true };
              if (retryErr && (retryErr.name === 'AbortError' || String(retryErr.message || '').includes('aborted'))) {
                return { found: false, cancelled: true };
              }
              continue; // network hiccup inside the window → next attempt
            }
            retryDuration = Date.now() - startTime;
            updateWafCookieFromResponse(accountEmail, retryResponse);
            if (retryResponse.status === 429) {
              return { found: false, rateLimited: true, retryAfterMs: parseRetryAfterMs(retryResponse), latencyMs: retryDuration };
            }
            if (retryResponse.status === 400) {
              let bodyText = '';
              try { bodyText = await retryResponse.text(); } catch (_) {}
              let apiMessage = '';
              try { apiMessage = JSON.parse(bodyText)?.message || ''; } catch (_) {}
              const outsideHours = /office hours/i.test(apiMessage);
              return {
                found: false,
                ...(outsideHours ? { outsideOfficeHours: true } : {}),
                error: apiMessage || 'HTTP 400',
                latencyMs: retryDuration
              };
            }
            if (retryResponse.status === 401) continue;         // still refused → next attempt
            if (!retryResponse.ok) {
              return { found: false, error: `HTTP ${retryResponse.status}`, latencyMs: retryDuration };
            }
            break;                                             // 2xx → evaluate below
          }

          if (!retryResponse || retryResponse.status === 401) {
            log401(accountEmail, `SOFT 401 persisted after burst retries (max ${burstRetries})`);
            if (!SEQUENTIAL_QUIET_LOGS) {
              log(`   ⚠️ Soft 401 persists after burst retries — skip refresh${isNearAppointmentDropWindow() ? ' (drop window)' : ''}`);
            }
            // Refused for the whole window → don't fire the next burst with a token the server
            // just rejected: flag it so the next pre-arm refresh/logins a fresh session.
            return { found: false, soft401: true, tokenExpired: false, error: 'SOFT_401', retriesExhausted: true, latencyMs: retryDuration };
          }

          try {
            const availableRetry = await retryResponse.json();
            if (availableRetry === true) {
              if (!SEQUENTIAL_QUIET_LOGS) {
                log(`   ✅ Appointments available! (recovered after soft-401 retry)`);
              }
              return { found: true, latencyMs: retryDuration };
            }
          } catch (_) { /* non-JSON 2xx → treat as not available */ }
          return { found: false, latencyMs: retryDuration };
        }
        return { found: false, soft401: true, tokenExpired: false, error: 'SOFT_401', latencyMs: duration };
      }

      log401(accountEmail, `REAL 401 → token expired (rem was ~${rem}s)${bodyNote}`);
      log(`   ⚠️ Token expired (401) in checkAvailability`);
      return { found: false, tokenExpired: true, error: 'TOKEN_EXPIRED', latencyMs: duration };
    }
    
    if (response.status === 429) {
      const retryAfterMs = parseRetryAfterMs(response);
      if (retryAfterMs) {
        log(`   ⏸️ [${accountEmail || 'unknown'}] 429 with Retry-After: ${Math.ceil(retryAfterMs / 1000)}s`);
      }
      return { found: false, rateLimited: true, retryAfterMs, latencyMs: duration };
    }

    if (response.status === 400) {
      let bodyText = '';
      try { bodyText = await response.text(); } catch (_) {}
      let apiMessage = '';
      try { apiMessage = JSON.parse(bodyText)?.message || ''; } catch (_) {}
      const outsideHours = /office hours/i.test(apiMessage);
      if (outsideHours) {
        // Outside office hours is expected overnight — not a broken mode / bad URL.
        // NOTE: no parking by user choice — keeps firing through 400s even though
        // they consume the ~60/budget like any other request (measured 2026-09-16).
        if (!SEQUENTIAL_QUIET_LOGS) {
          log(`   🌙 Outside office hours (400): ${apiMessage} — continuing (parking disabled)`);
        }
        return { found: false, outsideOfficeHours: true, error: apiMessage || 'OUTSIDE_OFFICE_HOURS', latencyMs: duration };
      }
      const isInsertedDataNoise = /check inserted data/i.test(apiMessage || bodyText);
      if (!isInsertedDataNoise) {
        log(`   ⚠️ Bad Request (400): ${apiMessage || bodyText.slice(0, 160) || 'no body'}`);
      }
      return { found: false, error: apiMessage || `HTTP 400`, latencyMs: duration };
    }
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const available = await response.json();
    
    // The API returns true/false
    if (available === true) {
      if (!SEQUENTIAL_QUIET_LOGS) {
        log(`   ✅ Appointments available! (stopping all other requests now)`);
      }
      
      // Return immediately with found=true to stop other requests
      // NO VERIFICATION - Just notify user to book manually
      return { found: true, latencyMs: duration };
    }
    
    return { found: false, latencyMs: duration };
    
  } catch (error) {
    const duration = Date.now() - startTime;
    // Check if request was aborted (this is expected when appointment is found)
    if (error.name === 'AbortError' || error.message.includes('aborted')) {
      return { found: false, cancelled: true };
    }
    
    // Record latency for non-aborted errors (useful for timing)
    
    const isConnectionError = error.message.includes('ECONNRESET') || 
                              error.message.includes('ETIMEDOUT') ||
                              error.message.includes('ECONNREFUSED') ||
                              error.message.includes('socket hang up');
    
    if (isConnectionError) {
      return { found: false, needIPRotation: true, error: error.message, latencyMs: duration };
    }
    
    return { found: false, error: error.message, latencyMs: duration };
  }
}


// Get appointment details after stopping all requests
async function getAppointmentDetails(officeId, visaId, serviceLevelId, token, agent, destination, tripDate) {
  log(`\n📋 Fetching appointment details...`);
  
  try {
    // Get months
    const monthsResult = await getAvailableMonths(officeId, visaId, serviceLevelId, token, agent, destination, tripDate);
    
    log(`   📊 Months result:`);
    log(`      Full response: ${JSON.stringify(monthsResult, null, 2)}`);
    log(`      months array: ${JSON.stringify(monthsResult.months)}`);
    log(`      months length: ${monthsResult.months ? monthsResult.months.length : 'undefined'}`);
    
    if (monthsResult.months && monthsResult.months.length > 0) {
      const month = monthsResult.months[0];
      log(`   📅 Available month: ${month}`);
      
      const daysResult = await getAvailableDays(officeId, visaId, serviceLevelId, token, agent, destination, tripDate, month);
      
      log(`   📊 Days result:`, JSON.stringify(daysResult));
      
      if (daysResult.days && daysResult.days.length > 0) {
        const day = daysResult.days[0];
        log(`   📆 Available day: ${day}`);
        
        const slotsResult = await getAvailableSlots(officeId, visaId, serviceLevelId, token, agent, destination, tripDate, day);
        
        log(`   📊 Slots result:`, JSON.stringify(slotsResult));
        
        if (slotsResult.slots && slotsResult.slots.length > 0) {
          log(`   🎯 Found ${slotsResult.slots.length} slot(s) in planning API`);
          
          // CRITICAL VERIFICATION: Check FREE slots from booking API
          log(`\n✅ Verifying bookable slots...`);
          const verification = await verifyFreeSlots(officeId, day, token, agent, 1);
          
          if (verification.success && verification.count > 0) {
            log(`   ✅✅✅ CONFIRMED: ${verification.count} FREE slot(s) actually available for booking!`);
            log(`   📌 Date: ${day}`);
            log(`   ⏰ Available times: ${verification.slots.join(', ')}`);
            
            return {
              success: true,
              month: month,
              date: day,
              slots: slotsResult.slots,
              freeSlots: verification.slots,
              freeSlotsCount: verification.count,
              verified: true
            };
          } else {
            log(`   ⚠️ WARNING: Slots shown in planning but NOT available for booking`);
            log(`   👁️ This might be a ghost slot - someone may have just booked it`);
            
            return {
              success: true,
              month: month,
              date: day,
              slots: slotsResult.slots,
              freeSlots: [],
              freeSlotsCount: 0,
              verified: false,
              warning: 'Slots not bookable'
            };
          }
        } else {
          log(`   ⚠️ No slots found in the day`);
        }
      } else {
        log(`   ⚠️ No days found in the month`);
      }
    } else {
      log(`   ⚠️ No months found or months is empty`);
    }
    
    // Could not get details
    log(`   ⚠️ Could not get complete appointment details`);
    return { success: false, month: 'unknown', date: 'unknown', slots: [] };
    
  } catch (error) {
    log(`   ❌ Error fetching appointment details: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// Aggressive Mode: Send multiple parallel requests
async function aggressiveCheck(officeId, visaId, serviceLevelId, token, agent, destination, tripDate, parallelCount = 3, abortSignal = null, forceTimeoutCallback = null, accountEmail = null) {
  log(`   💥 Aggressive mode: sending ${parallelCount} parallel requests...`);
  
  const promises = [];
  const aggStaggerMs = 50;
  const aggAnchorMs = ntpNow();
  for (let i = 0; i < parallelCount; i++) {
    await waitForStaggerSlot(aggAnchorMs, i, aggStaggerMs);
    promises.push(
      checkAvailability(officeId, visaId, serviceLevelId, token, agent, destination, tripDate, abortSignal, forceTimeoutCallback, accountEmail)
        .catch(err => ({ found: false, error: err.message }))
    );
  }
  
  // Wait for all to complete
  const results = await Promise.all(promises);
  
  // Check if any found appointment
  const found = results.find(r => r.found);
  if (found) {
    return found;
  }
  
  // Check if any need IP rotation
  const needsRotation = results.find(r => r.needIPRotation);
  if (needsRotation) {
    return needsRotation;
  }
  
  // Check if rate limited
  const rateLimited = results.find(r => r.rateLimited);
  if (rateLimited) {
    return rateLimited;
  }
  
  // Return first result (all failed)
  return results[0] || { found: false };
}

// Account checker worker - runs continuously for one account with PARALLEL requests
async function accountCheckerWorker(accountData, maxRequestsOverride = null, browser = null, syncFireAtMs = null, syncFireBoundaryMs = null, syncFireOptions = null) {
  enrichAccountData(accountData);
  const { account, token, sessionId, agent, ip, visaId } = accountData;
  const officeId = accountData.officeId || OFFICE_ID;
  const officeName = accountData.officeName || OFFICE_NAME;
  const visaTypeName = accountData.visaType || VISA_NAME;
  const syncOpts = syncFireOptions && typeof syncFireOptions === 'object' ? syncFireOptions : {};
  const syncFireMaxWaitMs = Math.max(
    SYNC_FIRE_MAX_WAIT_MS,
    Number(syncOpts.maxWaitMs) || SYNC_FIRE_MAX_WAIT_MS
  );
  const silentFirstFire = syncOpts.silentFirstFire === true;
  let firstFirePending = silentFirstFire;
  // 🧠 Intelligent mode (computed by launcher from enabled-account count, passed via opts).
  // When present, ALL manual timing (requestsPerMinute / aggressive interval / fan-out) is ignored.
  const smartIntervalMs = Number.isFinite(Number(syncOpts.smartIntervalMs)) && Number(syncOpts.smartIntervalMs) > 0
    ? Number(syncOpts.smartIntervalMs) : null;
  const initialDelayMs = Number.isFinite(Number(syncOpts.initialDelayMs)) && Number(syncOpts.initialDelayMs) > 0
    ? Number(syncOpts.initialDelayMs) : 0;

  syncAccountsFoundFromFile();
  if (hasAccountFoundThisSession(account.email)) {
    log(`\n⏭️ [${account.email}] Skipping - لقى معاد (مش هيتشيك تاني إلا بعد استرجاع)`);
    return;
  }
  
  // Check if account or IP is rate limited
  const rateLimitStatus = isRateLimited(account.email, ip);
  if (rateLimitStatus.limited) {
    const remainingMinutes = Math.ceil(rateLimitStatus.remainingMs / 60000);
    log(`\n⏸️ [${account.email}] Skipping - Rate limited for ${remainingMinutes} more minutes`);
    return;
  }
  
  if (!SEQUENTIAL_QUIET_LOGS) {
    log(`\n▶️ Starting checker for ${account.email} (IP: ${ip}) | Office: ${officeName} | Visa: ${visaTypeName} (${visaId})`);
  }
  
  // 🍪 Ensure WAF session cookie exists (fallback — usually pre-acquired after login)
  if (WAF_COOKIE_ENABLED && !accountWafCookies.has(String(account.email).toLowerCase())) {
    await acquireWafCookie(account.email, agent || null);
  }
  
  // ⏰ Wait for per-account start time if enabled
  await waitForPerAccountStartTime(account);

  // 🔄 START BACKGROUND TOKEN REFRESH TIMER (before strike wait — never at .000)
  let tokenRefreshTimer = null;
  if (ENABLE_AUTO_REFRESH && browser) {
    tokenRefreshTimer = setInterval(async () => {
      // Skip if checker already stopped (appointment found or rate limited)
      if (appointmentFound) {
        return;
      }
      if (typeof isRaceQuiet === 'function' && isRaceQuiet()) {
        return;
      }
      
      // 🛡️ Skip if this account was refreshed recently (pre-wave refresh probably just ran)
      if (hasRefreshedRecently(account.email)) {
        if (!SEQUENTIAL_QUIET_LOGS) {
          log(`   ⏭️ [${account.email}] Background refresh skipped (اتريفريش من قريب)`);
        }
        return;
      }
      
      // 🛡️ Never refresh inside the critical drop window — every ms counts there
      if (isNearAppointmentDropWindow()) {
        if (!SEQUENTIAL_QUIET_LOGS) {
          log(`   ⏭️ [${account.email}] Background refresh skipped (drop window)`);
        }
        return;
      }
      
      if (!SEQUENTIAL_QUIET_LOGS) {
        log(`\n🔄 [Background] Token refresh timer triggered for ${account.email}`);
      }
      try {
        await refreshTokenIfNeeded(accountData, browser);
      } catch (e) {
        if (!SEQUENTIAL_QUIET_LOGS) {
          log(`   ❌ [Background] Token refresh error: ${e.message}`);
        }
      }
    }, TOKEN_REFRESH_INTERVAL_MS);
    
    if (!SEQUENTIAL_QUIET_LOGS) {
      log(`   🔄 Background token refresh enabled (every ${TOKEN_REFRESH_MINUTES} minutes)`);
    }
  }
  
  // 💓 START KEEP-ALIVE PING TIMER (silent background — does not log or block checks)
  let keepAliveTimer = null;
  if (ENABLE_KEEP_ALIVE) {
    keepAliveTimer = setInterval(() => {
      if (appointmentFound) return;
      if (typeof isRaceQuiet === 'function' && isRaceQuiet()) return;
      // Fire-and-forget so checking is never delayed
      keepAlivePing(account.email).catch(() => {});
    }, KEEP_ALIVE_INTERVAL_MINUTES * 60 * 1000);
  }
  
  // Load aggressive mode config
const AGGRESSIVE_MODE = CONFIG.aggressiveMode || {};
  // 🧠 Intelligent mode flattens burst fan-out to 1 (per-account quota can't survive fan-out)
  const AGGRESSIVE_ENABLED = (AGGRESSIVE_MODE.enabled || false) && !smartIntervalMs;
  const PARALLEL_REQUESTS = smartIntervalMs ? 1 : (AGGRESSIVE_MODE.parallelRequests || 3);
  const AGGRESSIVE_INTERVAL = (AGGRESSIVE_MODE.intervalSeconds || 3) * 1000;
  const EFFECTIVE_SEQUENTIAL_MODE = ENABLE_SEQUENTIAL_MODE;

  if (EFFECTIVE_SEQUENTIAL_MODE) {
    // Once per process — each account worker used to spam this 23×
    if (!sequentialDelayBannerLogged) {
      sequentialDelayBannerLogged = true;
      log(`   ⏩ Sequential Mode: Wait-for-Response | delay after reply: ${SEQUENTIAL_DELAY}ms`);
    }
    if (!SEQUENTIAL_QUIET_LOGS) {
      const seqPreset = SEQUENTIAL_MODE_9AM.enabled === true
        ? '9 AM'
        : (ENABLE_SEQUENTIAL_PARALLEL_9AM ? '9 AM one-by-one' : 'General');
      log(`   🔄 Each request waits for response before sending next [${seqPreset}]`);
      if (ENABLE_SEQUENTIAL_PARALLEL_9AM) {
        log(`   👤 Accounts run one-by-one — on find, move to next account`);
      }
    }
  } else if (smartIntervalMs) {
    log(`   🧠 SMART intelligent mode: every ${Math.round(smartIntervalMs)}ms per account (manual requestsPerMinute/aggressive ignored)`);
    if (initialDelayMs > 0) log(`   🧠 Staggered start: +${Math.round(initialDelayMs)}ms so accounts never herd on the same millisecond`);
  } else if (AGGRESSIVE_ENABLED) {
    log(`   🔥 Aggressive Mode: ON`);
    log(`   💥 Parallel Requests: ${PARALLEL_REQUESTS}`);
    log(`   ⏱️  Interval: ${AGGRESSIVE_INTERVAL / 1000} seconds`);
  } else {
    log(`   📊 Parallel Mode: ${CONFIG.requestsPerMinute} requests/min`);
    log(`   ⏱️  Interval: ${CHECK_INTERVAL}ms between requests`);
  }
  
  let checkCount = 0;
  const maxChecks = maxRequestsOverride || 10000; // Use override if provided (for Round-Robin)
  
  if (maxRequestsOverride && !SEQUENTIAL_QUIET_LOGS) {
    log(`   🔢 Max requests for this account: ${maxRequestsOverride}`);
  }
  const ROTATE_IP_AFTER = CONFIG.rotateIPAfter || 15; // Rotate IP every N requests to avoid rate limit
  
  // Flag to stop all parallel requests when appointment is found
  let appointmentFound = false;
  let foundResult = null;
  
  // AbortController to cancel all pending requests immediately when appointment is found
  const globalAbortController = new AbortController();
  
  // Array to track active requests
  const activeRequests = [];
  
  // Array to store force timeout callbacks for all active requests
  const forceTimeoutCallbacks = [];
  
  // Track cancelled requests
  let cancelledCount = 0;
  
  // Shared abort signal check function for immediate cancellation
  const isAborted = () => appointmentFound || globalAbortController.signal.aborted;
  
  // Timer for sending requests at configured interval
  // 🧠 Intelligent mode: computed per-account spacing wins over every manual interval
  const sendInterval = smartIntervalMs ?? (AGGRESSIVE_ENABLED ? AGGRESSIVE_INTERVAL : CHECK_INTERVAL);
  const tightSendGaps = sendInterval > 0 && sendInterval <= 20;
  
  if (!SEQUENTIAL_QUIET_LOGS) {
    log(`   🚀 Starting request sender...`);
    if (typeof syncFireAtMs === 'number' && syncFireAtMs > 0 && (syncFireAtMs - ntpNow()) > 100) {
      log(`   ⏳ Armed — مستني الضربة ${formatCairoHms(syncFireAtMs, true)} قبل أول إرسال`);
    }
  }

  // Prefetch parallel-mode banners before strike wait (so .000 = send only)
  if (!EFFECTIVE_SEQUENTIAL_MODE) {
    log(`   🔀 Running in PARALLEL mode - multiple concurrent requests`);
    if (ENABLE_STOP_AT_TIME || ENABLE_STOP_AFTER_REQUESTS) {
      log(`   🛑 Stop Control: ${ENABLE_STOP_AT_TIME ? 'Time=' + STOP_AT_TIME : ''} ${ENABLE_STOP_AFTER_REQUESTS ? 'Requests=' + STOP_AFTER_REQUESTS : ''}`);
    }
  } else if (!SEQUENTIAL_QUIET_LOGS) {
    log(`   ⏩ Running in SEQUENTIAL mode - one request at a time`);
    if (ENABLE_STOP_AT_TIME || ENABLE_STOP_AFTER_REQUESTS) {
      log(`   🛑 Stop Control: ${ENABLE_STOP_AT_TIME ? 'Time=' + STOP_AT_TIME : ''} ${ENABLE_STOP_AFTER_REQUESTS ? 'Requests=' + STOP_AFTER_REQUESTS : ''}`);
    }
  }

  // 🎯 Strike wait LAST: all setup/logs above happen before the alarm
  if (typeof syncFireAtMs === 'number' && syncFireAtMs > 0) {
    const syncWaitMs = syncFireAtMs - ntpNow();
    if (syncWaitMs > 0 && syncWaitMs <= syncFireMaxWaitMs) {
      const boundaryMs = typeof syncFireBoundaryMs === 'number' && syncFireBoundaryMs > 0
        ? Math.min(syncFireBoundaryMs, 50)
        : 50;
      const prepareAt = syncFireAtMs - CHECK_PREARM_LEAD_MS;
      if (ntpNow() < prepareAt) {
        await waitUntilNtpEpochOrReschedule(prepareAt, {
          label: `sync-prearm:${account.email}`,
          tickEveryMs: 60000,
          spinBeforeMs: 0
        });
        throwIfLiveReschedule();
        prepareCheckRequestForAccount(accountData, 1);
      } else if (ntpNow() < syncFireAtMs) {
        prepareCheckRequestForAccount(accountData, 1);
      }
      await waitUntilNtpEpochOrReschedule(syncFireAtMs, {
        label: `sync-fire:${account.email}`,
        tickEveryMs: 60000,
        spinBeforeMs: boundaryMs
      });
    }
  }
  // 🧠 Staggered start: spread N accounts evenly so they never herd on the same millisecond
  // (only set by the parallel launcher; sequential one-by-one path never sets it)
  if (initialDelayMs > 0) {
    await sleep(initialDelayMs);
  }
  throwIfLiveReschedule();
  
  // SEQUENTIAL MODE: Wait for each response before sending next
  if (EFFECTIVE_SEQUENTIAL_MODE) {
    const tightSeqGaps = SEQUENTIAL_DELAY > 0 && SEQUENTIAL_DELAY <= 20;
    while (checkCount < maxChecks && !appointmentFound) {
      // Check stop control before sending new request (PER ACCOUNT)
      if (isLiveReschedulePending()) {
        if (!SEQUENTIAL_QUIET_LOGS) {
          log(`\n🔄 [${account.email}] إعادة جدولة حية — إيقاف التشيك`);
        }
        break;
      }
      if (shouldStopSendingRequests(account.email, checkCount)) {
        if (!SEQUENTIAL_QUIET_LOGS) {
          log(`\n🛑 [${account.email}] Stop control triggered - not sending new requests`);
          log(`   📊 Total requests sent for this account: ${checkCount}`);
        }
        break;
      }
      
      checkCount++;
      incrementAccountRequestCount(account.email);
      const quietFire = firstFirePending;
      if (firstFirePending) firstFirePending = false;

      // Defer log when gaps are tight — console I/O otherwise eats the delayMs
      if (!quietFire && !tightSeqGaps) {
        log(`\n🔍 [${account.email}] Sending sequential request #${checkCount}`);
      }

      let responseEndMs = 0;
      
      try {
        // Token prep before request
        if (!quietFire && needsTokenRefreshAtCheckTime(account.email)) {
          if (!SEQUENTIAL_QUIET_LOGS) {
            log(`   🔄 Token refresh needed (time-based)`);
          }
          const refreshed = await refreshTokenIfNeeded(accountData, browser);
          if (!refreshed) {
            if (!SEQUENTIAL_QUIET_LOGS) {
              log(`   ❌ Token refresh failed, stopping checker`);
            }
            break;
          }
        }
        
        const requestStartMs = ntpNow();
        let result;
        const reqNo = checkCount;

        // Log "sent" BEFORE awaiting reply (in-flight) → appears above Status in every mode
        if (quietFire || tightSeqGaps) {
          logRequestSentDeferred(
            `\n🔍 [${account.email}] Sequential #${reqNo} | sent ${formatCairoHms(requestStartMs, true)}`
          );
        }
        
        // Send request and WAIT for response
        if (AGGRESSIVE_ENABLED && !(quietFire && PARALLEL_REQUESTS <= 1)) {
          result = await aggressiveCheck(
            officeId,
            visaId,
            1,
            accountData.token,
            agent,
            DESTINATION,
            TRIP_DATE,
            PARALLEL_REQUESTS,
            null,  // No abort signal in sequential mode
            null,  // No force timeout callback
            account.email  // 🎭 Pass account email for unique spoofed IP
          );
        } else {
          result = await checkAvailability(
            officeId,
            visaId,
            1,
            accountData.token,
            agent,
            DESTINATION,
            TRIP_DATE,
            null,  // No abort signal in sequential mode
            null,  // No force timeout callback
            account.email  // 🎭 Pass account email for unique spoofed IP
          );
        }
        // Anchor the configured gap from the moment the reply arrives (not after logging)
        responseEndMs = ntpNow();
        
        // Handle token expiry
        if (result.tokenExpired) {
          if (result.soft401 || isTokenStillFresh(account.email, 120) || isNearAppointmentDropWindow()) {
            if (!SEQUENTIAL_QUIET_LOGS) {
              log(`   ⚡ Skipping reactive refresh (soft401/fresh/drop-window)`);
            }
          } else if (browser && ENABLE_REACTIVE_REFRESH) {
            if (!SEQUENTIAL_QUIET_LOGS) {
              log(`   🔄 Token expired (401), refreshing...`);
            }
            const newToken = await refreshTokenIfNeeded(accountData, browser);
            
            if (!newToken) {
              if (!SEQUENTIAL_QUIET_LOGS) {
                log(`   ❌ Token refresh failed, stopping checker`);
              }
              break;
            }
          } else {
            if (!SEQUENTIAL_QUIET_LOGS) {
              log(`   ⚠️ Token expired (401) - will get fresh token in next cycle`);
            }
            break;
          }
        }
        
        // CRITICAL: Check if appointment found
        if (result.found) {
          // 🎯 Single canonical found timestamp - used by log line, UI and Telegram (identical)
          const foundEpochMs = ntpNow();
          appointmentFound = true;
          markAccountFoundThisSession(account.email);
          
          if (SEQUENTIAL_QUIET_LOGS) {
            // 🎉 بانر لفت الانتباه — في كل الأوضاع التتابعية (الساعة 9 + المتوازي 9 + التتابعي العام)
            log(`\n${"🎉".repeat(60)}`);
            log(`🎉 FOUND APPOINTMENT AVAILABLE FOR: ${account.email}`);
            log(`⏭️ مش هيتشيك على الحساب ده تاني لحد تشييك جديد`);
            log(`${"🎉".repeat(60)}\n`);
          } else {
            log(`\n${"🎉".repeat(60)}`);
            log(`🎉 FOUND APPOINTMENT AVAILABLE FOR: ${account.email}`);
            log(`🛑 Sequential mode - no pending requests to abort`);
            log(`⏭️ مش هيتشيك على الحساب ده تاني لحد تشييك جديد`);
            log(`${"🎉".repeat(60)}\n`);
            
            // NO VERIFICATION - Just save immediately
            log(`\n✅✅✅ APPOINTMENT FOUND (via /checks API) ✅✅✅`);
          }
          
          // Set result fields for saving
          result.date = 'Check website';
          result.month = 'Check website';
          result.freeSlots = [];
          result.freeSlotsCount = 0;
          result.verified = false;
          result.slots = [];
          
          foundResult = result;
          
          // Save appointment
          try {
            let appointments = [];
            const appointmentFile = path.join(__dirname, 'appointment-found.json');
            
            if (fs.existsSync(appointmentFile)) {
              try {
                const existing = JSON.parse(fs.readFileSync(appointmentFile, 'utf8'));
                if (Array.isArray(existing)) {
                  appointments = existing;
                } else if (existing && existing.account) {
                  appointments = [existing];
                }
              } catch (e) {
                appointments = [];
              }
            }
            
            const now = new Date(foundEpochMs);
            const customerInfo = getAccountCustomerInfo(account);
            const newAppointment = {
              account: account.email,
              foundAt: now.toISOString(),
              foundAtReadable: `${new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', day: '2-digit', month: '2-digit', year: 'numeric' }).format(now)} ${formatCairoHms(now.getTime(), true)}`,
              office: officeName,
              visaType: visaTypeName,
              destination: DESTINATION || 'N/A',
              tripDate: TRIP_DATE,
              ...customerInfo,
              appointmentDate: 'Check website',
              appointmentMonth: 'Check website',
              bookingStatus: 'FOUND_VIA_CHECKS_API',
              note: 'Appointment detected by /checks API - Login immediately and book manually'
            };
            
            const existingIndex = appointments.findIndex(apt => apt.account === account.email);
            if (existingIndex >= 0) {
              appointments[existingIndex] = newAppointment;
            } else {
              appointments.push(newAppointment);
            }

            fs.writeFileSync(
              appointmentFile,
              JSON.stringify(appointments, null, 2),
              'utf8'
            );
            if (!SEQUENTIAL_QUIET_LOGS) {
              log(`✅ Appointment saved for ${account.email}`);
            }
            markAccountFoundInFile(account.email, { office: officeName, visaType: visaTypeName, tripDate: TRIP_DATE, destination: DESTINATION || 'N/A' });

            // 📱 Send Telegram notification
            try {
              const now = new Date(foundEpochMs);
              await sendTelegramNotification({
                accountEmail: account.email,
                office: officeName,
                visaType: visaTypeName,
                destination: DESTINATION || 'N/A',
                tripDate: TRIP_DATE,
                foundAt: now.toLocaleString('ar-EG', {
                  dateStyle: 'short',
                  timeStyle: 'medium',
                  hour12: true
                }),
                foundAtDate: now,
                requestSentDate: new Date(requestStartMs),
                responseReceivedDate: new Date(foundEpochMs),
                responseTimeMs: foundEpochMs - requestStartMs,
                ...customerInfo
              });
            } catch (e) {
              if (!SEQUENTIAL_QUIET_LOGS) {
                log(`⚠️ Could not send Telegram notification: ${e.message}`);
              }
            }
          } catch (e) {
            if (!SEQUENTIAL_QUIET_LOGS) {
              log(`⚠️ Could not save appointment: ${e.message}`);
            }
          }

          // STOP immediately - appointment found!
          break;
        }
        
        // Handle rate limiting
        if (result.rateLimited) {
          if (!SEQUENTIAL_QUIET_LOGS) {
            log(`\n⚠️ [${account.email}] Rate limited detected on request #${checkCount}`);
          }
          appointmentFound = true;

          addToRateLimited(account.email, accountData.ip, accountData.accountIndex, result.retryAfterMs ?? null);
          if (!SEQUENTIAL_QUIET_LOGS) {
            log(`⏹️ [${account.email}] Stopped checking - will resume after ${RATE_LIMIT_COOLDOWN} minutes`);
          }
          break;
        }
        
        // Handle IP rotation needs
        if (result.needIPRotation && !SEQUENTIAL_QUIET_LOGS) {
          log(`   ⚠️ Request #${checkCount} needs IP rotation`);
        }
        
        // Log response for normal "no appointment found" case
          if (!result.found && !result.rateLimited && !result.needIPRotation && !result.tokenExpired && !result.cancelled && result.latencyMs !== undefined && !SEQUENTIAL_QUIET_LOGS) {
        }
        
      } catch (error) {
        responseEndMs = responseEndMs || ntpNow();
        if (!SEQUENTIAL_QUIET_LOGS) {
          log(`   ❌ Request #${checkCount} error: ${error.message}`);
        }
      }

      // Absolute gap from reply → next fire (before IP rotation / extra work)
      if (!appointmentFound && SEQUENTIAL_DELAY > 0 && responseEndMs > 0) {
        await waitUntilEpochPrecise(responseEndMs + SEQUENTIAL_DELAY);
      }
      
      // Proactive IP rotation to avoid rate limiting
      if (!appointmentFound && USE_PROXY && checkCount % ROTATE_IP_AFTER === 0 && checkCount > 0) {
        log(`\n🔄 [${account.email}] Proactive IP rotation after ${checkCount} requests...`);
        
        try {
          usedIPs.delete(accountData.ip);
          
          const newIPData = await assignUniqueIP(account.email, accountData.accountIndex + checkCount);
          accountData.sessionId = newIPData.sessionId;
          accountData.agent = newIPData.agent;
          accountData.ip = newIPData.ip;
          
          if (!SEQUENTIAL_QUIET_LOGS) {
            log(`   ✅ [${account.email}] Rotated to new IP: ${newIPData.ip}`);
          }
          await preciseDelay(1000);
        } catch (e) {
          if (!SEQUENTIAL_QUIET_LOGS) {
            log(`   ⚠️ [${account.email}] Failed to rotate IP: ${e.message}`);
          }
        }
      }
    }
    
    if (!SEQUENTIAL_QUIET_LOGS) {
      log(`\n⏹️ [${account.email}] Sequential checker stopped`);
      log(`   📊 Total requests sent: ${checkCount}`);
      
      if (foundResult && foundResult.found) {
        log(`   ✅ Appointment found!`);
      } else if (appointmentFound) {
        log(`   ⚠️ Stopped (token expired or rate limited)`);
      } else {
        log(`   ❌ No appointment found`);
      }
    }
    
    // 🧹 CLEANUP: Stop background timers
    if (tokenRefreshTimer) {
      clearInterval(tokenRefreshTimer);
      if (!SEQUENTIAL_QUIET_LOGS) {
        log(`   🧹 Background token refresh timer stopped`);
      }
    }
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
    }
    
    return; // Exit function - sequential mode complete
  }
  
  // PARALLEL MODE: Send requests at fixed intervals (original behavior)
  // Absolute cadence from wave anchor — respects sendInterval without sleep drift
  const parallelWaveAnchorMs = ntpNow();
  let parallelFireSlot = 0;
  while (checkCount < maxChecks && !appointmentFound) {
    if (isLiveReschedulePending()) {
      log(`\n🔄 [${account.email}] إعادة جدولة حية — إيقاف التشيك`);
      break;
    }
    // CRITICAL: Check flag BEFORE sending new request
    if (appointmentFound) {
      log(`\n🛑 Appointment found - stopping request sender loop`);
      break;
    }
    
    // Check stop control before sending new request (PER ACCOUNT)
    if (shouldStopSendingRequests(account.email, checkCount)) {
      log(`\n🛑 [${account.email}] Stop control triggered - not sending new requests`);
      log(`   📊 Total requests sent for this account: ${checkCount}`);
      break;
    }

    const slot = parallelFireSlot++;
    if (slot > 0 && sendInterval > 0) {
      await waitForStaggerSlot(parallelWaveAnchorMs, slot, sendInterval);
    }
    if (appointmentFound || isLiveReschedulePending()) break;
    
    checkCount++;
    incrementAccountRequestCount(account.email);
    const isSilentThisFire = firstFirePending;
    if (firstFirePending) firstFirePending = false;
    
    // Send request without waiting for response
    const launchWave = async () => {
      const requestId = checkCount;
      
      // CRITICAL: Check abort flag IMMEDIATELY before even logging
      if (isAborted()) {
        cancelledCount++;
        return { found: false, cancelled: true, reason: 'pre-check-abort' };
      }
      
      try {
        // Check if token needs proactive refresh (based on time)
        if (!isSilentThisFire && needsTokenRefreshAtCheckTime(account.email)) {
          log(`   🔄 Token refresh needed (time-based)`);
          const refreshed = await refreshTokenIfNeeded(accountData, browser);
          if (!refreshed) {
            log(`   ❌ Token refresh failed, stopping checker`);
            appointmentFound = true;
            return { found: false, error: 'TOKEN_REFRESH_FAILED' };
          }
        }
        
        const requestStartMs = ntpNow();
        // Sent log queued before await — appears above Status (all gaps / silent first fire)
        if (!isSilentThisFire && !tightSendGaps) {
          log(`\n🔍 [${account.email}] Sending request #${requestId}`);
        } else {
          logRequestSentDeferred(
            `\n🔍 [${account.email}] Sending request #${requestId} | sent ${formatCairoHms(requestStartMs, true)} (Δ${requestStartMs - parallelWaveAnchorMs}ms)`
          );
        }
        
        let result;
        
        // Register force timeout callback for this request
        let forceTimeoutTrigger = null;
        const forceTimeoutCallback = (trigger) => {
          forceTimeoutTrigger = trigger;
        };
        // Store both callback and trigger wrapper for later use
        const triggerWrapper = () => forceTimeoutTrigger && forceTimeoutTrigger();
        forceTimeoutCallbacks.push(triggerWrapper);
        
        // Use aggressive or normal mode
        if (AGGRESSIVE_ENABLED && !(isSilentThisFire && PARALLEL_REQUESTS <= 1)) {
          result = await aggressiveCheck(
            officeId,
            visaId,
            1,
            accountData.token,
            agent,  // Use account's agent
            DESTINATION,
            TRIP_DATE,
            PARALLEL_REQUESTS,
            globalAbortController.signal,
            forceTimeoutCallback,
            account.email  // 🎭 Pass account email for unique spoofed IP
          );
        } else {
          result = await checkAvailability(
            officeId,
            visaId,
            1,
            accountData.token,
            agent,  // Use account's agent
            DESTINATION,
            TRIP_DATE,
            globalAbortController.signal,
            forceTimeoutCallback,
            account.email  // 🎭 Pass account email for unique spoofed IP
          );
        }
        
        // Handle token expiry differently based on mode
        if (result.tokenExpired) {
          // Never burn the drop window on a refresh for a still-fresh token / soft 401
          if (result.soft401 || isTokenStillFresh(account.email, 120) || isNearAppointmentDropWindow()) {
            log(`   ⚡ Skipping reactive refresh (soft401/fresh/drop-window) — keep firing`);
          } else if (browser && ENABLE_REACTIVE_REFRESH) {
            // Parallel mode: Try to refresh and retry
            log(`   🔄 Token expired (401), refreshing and retrying...`);
            const newToken = await refreshTokenIfNeeded(accountData, browser);
            
            if (newToken) {
              // Retry the request with new token
              if (AGGRESSIVE_ENABLED) {
                result = await aggressiveCheck(
                  officeId,
                  visaId,
                  1,
                  accountData.token,
                  agent,
                  DESTINATION,
                  TRIP_DATE,
                  PARALLEL_REQUESTS,
                  null,
                  null,
                  account.email  // 🎭 Pass account email for unique spoofed IP
                );
              } else {
                result = await checkAvailability(
                  officeId,
                  visaId,
                  1,
                  accountData.token,
                  agent,
                  DESTINATION,
                  TRIP_DATE,
                  null,
                  null,
                  account.email  // 🎭 Pass account email for unique spoofed IP
                );
              }
            } else {
              log(`   ❌ Token refresh failed, stopping checker`);
              appointmentFound = true;
              return { found: false, error: 'TOKEN_REFRESH_FAILED' };
            }
          } else {
            // Round-Robin mode: Stop and get fresh token in next cycle
            log(`   ⚠️ Token expired (401) - will get fresh token in next cycle`);
            appointmentFound = true;
            return { found: false, error: 'TOKEN_EXPIRED' };
          }
        }
        
        // Check if appointment found
        if (result.found) {
          // 🎯 Single canonical found timestamp - used by log line, UI and Telegram (identical)
          const foundEpochMs = ntpNow();
          // CRITICAL: Set flag FIRST - before ANY logging or processing
          appointmentFound = true;
          markAccountFoundThisSession(account.email);
          
          log(`   ✅ Appointment found by Request #${requestId}`);
          
          // FORCE TIMEOUT all pending requests IMMEDIATELY!
          // This triggers force timeout callbacks to abort with near-zero timeout
          log(`💥 Triggering FORCE TIMEOUT on ${forceTimeoutCallbacks.length} active requests...`);
          for (let i = 0; i < forceTimeoutCallbacks.length; i++) {
            try {
              const triggerFn = forceTimeoutCallbacks[i];
              if (typeof triggerFn === 'function') {
                triggerFn();
              }
            } catch (e) {
              // Ignore errors in force timeout
            }
          }
          
          // ABORT all pending requests IMMEDIATELY!
          // This will trigger socket destruction in httpFetch()
          globalAbortController.abort();
          
          log(`\n${"🎉".repeat(60)}`);
          log(`🎉 FOUND APPOINTMENT AVAILABLE FOR: ${account.email}`);
          log(`✅ All requests confirmed stopped!`);
          log(`⏭️ مش هيتشيك على الحساب ده تاني لحد تشييك جديد`);
          log(`${"🎉".repeat(60)}\n`);
          
          // NO VERIFICATION - Just save immediately
          log(`\n✅✅✅ APPOINTMENT FOUND (via /checks API) ✅✅✅`);
          
          // Set result fields for saving
          result.date = 'Check website';
          result.month = 'Check website';
          result.freeSlots = [];
          result.freeSlotsCount = 0;
          result.verified = false;
          result.slots = [];
          
          foundResult = result;
          
          // Save appointment
          try {
            let appointments = [];
            const appointmentFile = path.join(__dirname, 'appointment-found.json');
            
            if (fs.existsSync(appointmentFile)) {
              try {
                const existing = JSON.parse(fs.readFileSync(appointmentFile, 'utf8'));
                if (Array.isArray(existing)) {
                  appointments = existing;
                } else if (existing && existing.account) {
                  appointments = [existing];
                }
              } catch (e) {
                appointments = [];
              }
            }
            
            const now = new Date(foundEpochMs);
            const customerInfo = getAccountCustomerInfo(account);
            const newAppointment = {
              account: account.email,
              foundAt: now.toISOString(),
              foundAtReadable: `${new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', day: '2-digit', month: '2-digit', year: 'numeric' }).format(now)} ${formatCairoHms(now.getTime(), true)}`,
              office: officeName,
              visaType: visaTypeName,
              destination: DESTINATION || 'N/A',
              tripDate: TRIP_DATE,
              ...customerInfo,
              // NO VERIFICATION - Just mark as found
              appointmentDate: 'Check website',
              appointmentMonth: 'Check website',
              bookingStatus: 'FOUND_VIA_CHECKS_API',
              note: 'Appointment detected by /checks API - Login immediately and book manually'
            };
            
            const existingIndex = appointments.findIndex(apt => apt.account === account.email);
            if (existingIndex >= 0) {
              appointments[existingIndex] = newAppointment;
            } else {
              appointments.push(newAppointment);
            }
            
            fs.writeFileSync(
              appointmentFile,
              JSON.stringify(appointments, null, 2),
              'utf8'
            );
            log(`✅ Appointment saved for ${account.email}`);
            markAccountFoundInFile(account.email, { office: officeName, visaType: visaTypeName, tripDate: TRIP_DATE, destination: DESTINATION || 'N/A' });

            // 📱 Send Telegram notification
            try {
              const now = new Date(foundEpochMs);
              await sendTelegramNotification({
                accountEmail: account.email,
                office: officeName,
                visaType: visaTypeName,
                destination: DESTINATION || 'N/A',
                tripDate: TRIP_DATE,
                foundAt: now.toLocaleString('ar-EG', {
                  dateStyle: 'short',
                  timeStyle: 'medium',
                  hour12: true
                }),
                foundAtDate: now,
                requestSentDate: new Date(requestStartMs),
                responseReceivedDate: new Date(foundEpochMs),
                responseTimeMs: foundEpochMs - requestStartMs,
                ...customerInfo
              });
            } catch (e) {
              log(`⚠️ Could not send Telegram notification: ${e.message}`);
            }
          } catch (e) {
            log(`⚠️ Could not save appointment: ${e.message}`);
          }

          return { found: true, result };
        }
        
        // Handle rate limiting
        if (result.rateLimited) {
          log(`\n⚠️ [${account.email}] Rate limited detected on request #${requestId}`);
          appointmentFound = true; // Stop sending more requests for THIS account
          
          // 🚀 FIX: ABORT all pending requests IMMEDIATELY when rate limited!
          // This prevents pending requests from getting more 429 errors
          log(`💥 [${account.email}] Aborting ${activeRequests.length} pending requests to prevent more 429s...`);
          
          // Trigger force timeout on all active requests
          for (let i = 0; i < forceTimeoutCallbacks.length; i++) {
            try {
              const triggerFn = forceTimeoutCallbacks[i];
              if (typeof triggerFn === 'function') {
                triggerFn();
              }
            } catch (e) {
              // Ignore errors in force timeout
            }
          }
          
          // ABORT signal to cancel pending requests
          globalAbortController.abort();
          log(`   ✅ Abort signal sent to all pending requests`);
          
          addToRateLimited(account.email, accountData.ip, accountData.accountIndex);
          log(`⏹️ [${account.email}] Stopped checking - will resume after ${RATE_LIMIT_COOLDOWN} minutes`);
          log(`➡️ Round-Robin will continue with next account...`);
          
          return { rateLimited: true };
        }
        
        // Handle IP rotation needs
        if (result.needIPRotation) {
          log(`   ⚠️ Request #${requestId} needs IP rotation`);
        }
        
        // Log response for normal "no appointment found" case
        if (!result.found && !result.rateLimited && !result.needIPRotation && !result.tokenExpired && !result.cancelled && result.latencyMs !== undefined) {
        }
        
        return result;
        
      } catch (error) {
        // Check if error is from abort (this is expected when we find appointment)
        if (error.name === 'AbortError' || error.message.includes('aborted')) {
          cancelledCount++;
          log(`   ✅ Request #${requestId} CANCELLED successfully (appointment found)`);
          return { found: false, cancelled: true };
        }
        
        log(`   ❌ Request #${requestId} error: ${error.message}`);
        return { found: false, error: error.message };
      }
    };
    
    const requestPromise = launchWave();
    activeRequests.push(requestPromise);
    
    // Clean up completed requests periodically to avoid memory issues
    if (activeRequests.length > 50) {
      // Keep only the last 50 requests
      const settled = await Promise.allSettled(activeRequests.slice(0, activeRequests.length - 50));
      activeRequests.splice(0, activeRequests.length - 50);
    }
    
    // Proactive IP rotation to avoid rate limiting
    if (USE_PROXY && checkCount % ROTATE_IP_AFTER === 0 && checkCount > 0) {
      log(`\n🔄 [${account.email}] Proactive IP rotation after ${checkCount} requests...`);
      
      try {
        usedIPs.delete(accountData.ip);
        
        const newIPData = await assignUniqueIP(account.email, accountData.accountIndex + checkCount);
        accountData.sessionId = newIPData.sessionId;
        accountData.agent = newIPData.agent;
        accountData.ip = newIPData.ip;
        
        log(`   ✅ [${account.email}] Rotated to new IP: ${newIPData.ip}`);
        await preciseDelay(1000); // Small delay after rotation
      } catch (e) {
        log(`   ⚠️ [${account.email}] Failed to rotate IP: ${e.message}`);
        // Continue with old IP
      }
    }
    
    // Interval handled by absolute waitForStaggerSlot at top of loop
  }
  
  // Wait for remaining requests to complete (with shorter timeout if appointment found)
  if (appointmentFound && activeRequests.length > 0) {
    log(`\n⏳ [${account.email}] Waiting for ${activeRequests.length} remaining requests to complete...`);
    log(`   ⚡ Appointment found - waiting max 3 seconds for pending requests...`);
    
    // Race between all requests settling and a 3-second timeout
    const settlePromise = Promise.allSettled(activeRequests);
    const timeoutPromise = new Promise(resolve => setTimeout(resolve, 3000));
    
    await Promise.race([settlePromise, timeoutPromise]);
    log(`   ✅ Stopped waiting for remaining requests`);
  } else if (activeRequests.length > 0) {
    log(`\n⏳ [${account.email}] Waiting for ${activeRequests.length} remaining requests to complete...`);
    await Promise.allSettled(activeRequests);
  }
  
  log(`\n⏹️ [${account.email}] Checker stopped`);
  log(`   📊 Total requests sent: ${checkCount}`);
  if (cancelledCount > 0) {
    log(`   🛑 Requests cancelled: ${cancelledCount}`);
  }
  
  // Only say "Appointment found" if foundResult exists (not just appointmentFound flag)
  if (foundResult && foundResult.found) {
    log(`   ✅ Appointment found!`);
  } else if (appointmentFound) {
    log(`   ⚠️ Stopped (token expired or rate limited)`);
  } else {
    log(`   ❌ No appointment found`);
  }
  
  // 🧹 CLEANUP: Stop background timers
  if (tokenRefreshTimer) {
    clearInterval(tokenRefreshTimer);
    log(`   🧹 Background token refresh timer stopped`);
  }
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
  }
}

// =========================================================================
// ROUND-ROBIN MODE
// =========================================================================

// حساب وقت التشيك لحساب معين بناءً على الفاصل الزمني
function getNextCheckTime(accountIndex, startTime, intervalSeconds, lastCheckTime) {
  // Parse start time (MM:SS format)
  const [startMinute, startSecond] = (startTime || '04:30').split(':').map(Number);
  const interval = intervalSeconds || 60;
  
  // Use NTP wall clock (not Windows taskbar)
  const now = new Date(ntpNow());
  
  // إذا كان هناك وقت تشيك سابق (الحساب السابق اتأخر)
  if (lastCheckTime) {
    // شغل الحساب بعد الحساب السابق بالفاصل الزمني
    const targetTime = new Date(lastCheckTime.getTime() + (interval * 1000));
    
    // إذا الوقت فات، الحق الجدول فوراً (بدون تأخير اصطناعي)
    if (targetTime.getTime() <= ntpNow()) {
      return new Date(ntpNow());
    }
    
    return targetTime;
  }
  
  // الحساب الأول أو لا يوجد وقت سابق
  // حساب الوقت لهذا الحساب بناءً على index
  const offsetSeconds = accountIndex * interval;
  
  // بداية الوقت: الدقيقة والثانية المحددة في نفس الساعة (Cairo NTP)
  const baseTime = new Date(ntpNow());
  baseTime.setMinutes(startMinute);
  baseTime.setSeconds(startSecond);
  baseTime.setMilliseconds(0);
  
  // إضافة الفاصل الزمني لهذا الحساب
  let targetTime = new Date(baseTime.getTime() + (offsetSeconds * 1000));
  
  // إذا الوقت المحسوب فات، الحق الجدول فوراً
  if (targetTime.getTime() <= ntpNow()) {
    log(`   ⚠️ الوقت المحدد فات، سيبدأ التشيك فوراً`);
    return new Date(ntpNow());
  }
  
  return targetTime;
}

// Round-Robin Mode: كل حساب بفاصل زمني مخصص (تحضير متتالي)
// ============================================================================
// CLOCK-BURST + TRICKLE modes (measured server budget: token bucket ~60/account,
// refill ~0.45/min; ban extends on any request while banned — stay fully silent)
// ============================================================================

// Eligible accounts for the new modes: enabled, no hit this session, not parked.
function getModeEligibleAccounts(rawAccounts) {
  const out = [];
  (rawAccounts || []).forEach((acc, idx) => {
    if (!acc || !acc.email) return;
    if (acc.enabled === false) return;
    if (hasAccountFoundThisSession(acc.email)) return;
    if (isRateLimited(acc.email).limited) return;
    out.push({ account: acc, index: idx });
  });
  return out;
}

// 🍪 WAF warmup for the new modes: clock-burst used to fire its first /checks with
// NO cookiesession1 on fresh processes (empty accountWafCookies) → WAF answered 401
// on a perfectly valid token. Same guard the other modes use; homepage traffic only,
// off the /checks budget. Best-effort: never blocks session creation on failure.
async function ensureModeWafCookie(email) {
  try {
    if (WAF_COOKIE_ENABLED && email && !accountWafCookies.has(String(email).toLowerCase())) {
      await acquireWafCookie(email, null);
    }
  } catch (_) { /* fire path still sends; cookie harvests from the response */ }
}

// Token session per account for the new modes. Re-login when older than 13 min
// (server access tokens live 15 min). Refresh_token grant first (1 fast POST),
// full API login only when no/stale refresh token. Browser fallback on fail.
async function ensureModeSession(sessions, entry, browser, forceRelogin = false) {
  const key = emailKey(entry.account.email);
  let s = sessions.get(key);
  // Real token expiry decides (not session age) — see modeSessionFreshForBurst().
  const ageOk = modeSessionFreshForBurst(s);
  if (!forceRelogin && ageOk) return s;
  const email = entry.account.email;
  // Stale/missing session but we may hold a refresh_token from an earlier
  // cycle (global map, survives across bursts) — try 1 cheap refresh first.
  if (!forceRelogin && !hasRefreshedRecently(email)) {
    try {
      const rt = await directTokenRefresh(email);
      if (rt) {
        s = { account: entry.account, token: rt, agent: null, ip: '', accountIndex: entry.index, sessionId: null, acquiredAt: ntpNow() };
        enrichAccountData(s);
        sessions.set(key, s);
        log(`   ♻️ ${email} — refreshed via refresh_token (no full login)`);
        await ensureModeWafCookie(email);
        return s;
      }
    } catch (_) { /* fall through to full login */ }
  }
  let token = null;
  try { token = await loginViaAPI(entry.account, null, 3); } catch (_) { token = null; }
  if (!token && browser) {
    try { token = await loginAndGetToken(entry.account, browser); } catch (_) { token = null; }
  }
  if (!token) return null;
  s = { account: entry.account, token, agent: null, ip: '', accountIndex: entry.index, sessionId: null, acquiredAt: ntpNow() };
  enrichAccountData(s);
  sessions.set(key, s);
  await ensureModeWafCookie(email);
  return s;
}

// Single /checks fire with canonical args + token-expired retry. skipPace=true:
// slot timing is fixed by the mode; the fire is recorded, never delayed.
async function fireModeCheck(session, browser) {
  enrichAccountData(session);
  const email = session.account.email;
  const run = () => checkAvailability(
    session.officeId || OFFICE_ID,
    session.visaId,
    1, // serviceLevelId
    session.token,
    null, // agent: direct + spoof headers (proxy untested in new modes)
    DESTINATION,
    TRIP_DATE,
    null, // abortSignal
    null, // forceTimeoutCallback
    email,
    true  // skipPace
  );
  let result = await run();
  if (result && result.tokenExpired && !result.soft401) {
    try {
      const nt = await refreshTokenIfNeeded(session, browser);
      if (nt) { session.token = nt; session.acquiredAt = ntpNow(); result = await run(); }
    } catch (_) {}
  }
  // The server refused a token it had accepted seconds earlier (platform-side transient 401)
  // and it survived the whole in-window retry chain. Rare — but then don't walk into the next
  // burst (5 min later) with a session the server may treat as dead: age the session so the
  // next pre-arm refreshes/re-logins a fresh token instead of failing again.
  if (result && result.soft401 && result.retriesExhausted) {
    session.acquiredAt = 0;
    if (!SEQUENTIAL_QUIET_LOGS) {
      log(`   ♻️ ${email} — soft 401 persisted; forcing a fresh session before the next burst`);
    }
  }
  return result;
}

function modeParkRateLimited(session, retryAfterMs) {
  try { addToRateLimited(session.account.email, '', session.accountIndex ?? -1, retryAfterMs || null); } catch (_) {}
}

// Mirror the canonical found-handling (log + session mark + appointment file,
// which the notifiers watch). Keeps alerts working from the new modes.
function modeHandleFound(session, modeTag) {
  const email = session.account.email;
  const now = new Date(ntpNow());
  log(`\n   ✅ APPOINTMENT FOUND! [${modeTag}] ${email}`);
  markAccountFoundThisSession(email);
  try {
    const file = path.join(__dirname, 'appointment-found.json');
    let arr = [];
    if (fs.existsSync(file)) {
      try {
        const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
        arr = Array.isArray(cur) ? cur : (cur && cur.account ? [cur] : []);
      } catch (_) { arr = []; }
    }
    if (!arr.some(a => a && emailKey(a.account) === emailKey(email))) {
      arr.push({
        account: email,
        foundAt: now.toISOString(),
        office: session.officeName || OFFICE_NAME,
        visaType: session.visaType || VISA_NAME,
        destination: DESTINATION || 'N/A',
        tripDate: TRIP_DATE,
        bookingStatus: 'FOUND_VIA_' + modeTag,
        note: 'Appointment confirmed available - book manually'
      });
      fs.writeFileSync(file, JSON.stringify(arr, null, 2));
    }
  } catch (e) {
    log(`   ⚠️ Could not save appointment file: ${e.message}`);
  }
}

// Next wall-clock mark (minutes % everyMin == 0, seconds == 0) strictly after now.
function nextClockBurstMark(nowMs, everyMin) {
  const step = Math.max(1, Math.floor(everyMin || 5));
  let t = nowMs - (nowMs % 60000) + 60000;
  for (let i = 0; i < step + 2; i++) {
    if (new Date(t).getMinutes() % step === 0) return t;
    t += 60000;
  }
  return t;
}

async function runClockBurstMode(rawAccounts, browser) {
  const everyMin = CLOCK_BURST_EVERY_MIN;
  const windowMs = CLOCK_BURST_WINDOW_SEC * 1000;
  const perAccount = CLOCK_BURST_PER_ACCOUNT;
  const sessions = new Map();
  let totalFired = 0;
  let cycleNo = 0;
  if (USE_PROXY) log(`   ⚠️ Clock-burst runs direct (spoof headers on); proxy assignment not applied in this mode`);
  log(`⏰ Clock-burst: ${windowMs / 1000}s window ending on every min%${everyMin}==0 mark, ${perAccount} req/account/cycle`);
  log(`   🔧 Pre-arm ${CLOCK_BURST_PREARM_SEC}s early (clockBurst.preArmSec) — sessions prepared long before window, no last-second login`);
  log(`   Safe=2/cycle runs forever (refill 0.45/min); 4/cycle drains the bucket and trips after ~3h`);
  logAccountsSkippedBecauseFound('Clock-Burst');
  while (true) {
    throwIfLiveReschedule();
    if (ENABLE_STOP_AFTER_REQUESTS && STOP_AFTER_REQUESTS > 0 && totalFired >= STOP_AFTER_REQUESTS) {
      log(`\n🛑 Stop-after-requests reached (${totalFired}) — clock-burst done`);
      break;
    }
    const eligible = getModeEligibleAccounts(rawAccounts);
    if (eligible.length === 0) {
      if ((rawAccounts || []).every(a => hasAccountFoundThisSession(a && a.email))) {
        log(`\n✅ All accounts found — clock-burst done`); break;
      }
      log(`⏳ No eligible accounts (all parked) — waiting 60s...`);
      await sleep(60000);
      continue;
    }
    const mark = nextClockBurstMark(ntpNow(), everyMin);
    const windowStart = mark - windowMs;
    // Pre-arm lead is configurable (clockBurst.preArmSec, default 60s) — NOT a
    // few seconds before the check. Early enough that even slow logins/refreshes
    // finish before windowStart, so CHECKs fire on hot tokens with no login gap.
    const preArmLeadMs = CLOCK_BURST_PREARM_SEC * 1000;
    const preArmAt = windowStart - preArmLeadMs;
    if (windowStart - ntpNow() < preArmLeadMs + 2000) {
      log(`⏭️ Window too close (mark ${formatCairoHms(mark, true)}) — skipping to next`);
      await sleep(Math.max(1000, mark + 1000 - ntpNow()));
      continue;
    }
    cycleNo++;
    const R = perAccount * eligible.length;
    const gap = windowMs / R;
    log(`\n${'='.repeat(60)}`);
    log(`💥 Burst #${cycleNo}: mark ${formatCairoHms(mark, true)}, window ${CLOCK_BURST_WINDOW_SEC}s, ${eligible.length} accounts × ${perAccount} = ${R} reqs, slot every ${Math.round(gap)}ms`);
    log(`   🔧 Pre-arm ${CLOCK_BURST_PREARM_SEC}s before window (${formatCairoHms(preArmAt, true)} → ${formatCairoHms(windowStart, true)}): refresh-first, login only if needed`);
    // Pre-arm: prepare sessions EARLY so tokens are hot at windowStart.
    const msToPreArm = preArmAt - ntpNow();
    if (msToPreArm > 0) await sleep(msToPreArm);
    throwIfLiveReschedule();
    // Fast path: sessions that are REALLY usable (token expiry checked, not just age) → no
    // logins, no waiting. Anything about to expire is refreshed here, before the window.
    const freshCount = eligible.filter((e) => {
      const s = sessions.get(emailKey(e.account.email));
      return modeSessionFreshForBurst(s);
    }).length;
    let live = [];
    const tokenLifeSec = (e) => {
      const r = getTokenSecondsRemaining(e.account.email);
      return r === null ? Infinity : r;
    };
    const shortestLife = Math.min(...eligible.map(tokenLifeSec));
    const lifeLabel = Number.isFinite(shortestLife) ? `~${Math.round(shortestLife)}s` : 'unknown';
    // The actual reason per account: no session yet (fresh process), aged-out session,
    // unknown expiry, or token life at/below the safety margin.
    const whyStale = (e) => {
      const s = sessions.get(emailKey(e.account.email));
      if (!s || !s.token) return 'no-session';
      if (ntpNow() - (s.acquiredAt || 0) >= 13 * 60 * 1000) return `age>${Math.round((ntpNow() - s.acquiredAt) / 60000)}m`;
      const r = getTokenSecondsRemaining(e.account.email);
      return r === null ? 'life-?' : `life≤${Math.round(r)}s`;
    };
    const expiring = eligible
      .filter((e) => !modeSessionFreshForBurst(sessions.get(emailKey(e.account.email))))
      .map((e) => `${String(e.account.email).split('@')[0]}(${whyStale(e)})`);
    if (freshCount === eligible.length) {
      live = eligible.map((e) => sessions.get(emailKey(e.account.email)));
      log(`   ♻️ All ${live.length} sessions fresh (min token life ${lifeLabel}) — no login, checks fire immediately at window`);
    } else {
      // Parallel pre-arm: one slow login must NOT block the others past windowStart.
      log(`   🔐 Pre-arming ${eligible.length - freshCount}/${eligible.length} sessions in parallel — token life ≤ ${PREARM_MIN_TOKEN_SECONDS}s: ${expiring.join(', ')}`);
      const results = await Promise.allSettled(eligible.map((e) => ensureModeSession(sessions, e, browser)));
      results.forEach((res, i) => {
        if (res.status === 'fulfilled' && res.value) live.push(res.value);
        else log(`   ⚠️ Login failed for ${eligible[i].account.email} — excluded from burst #${cycleNo}`);
      });
      const overrun = ntpNow() - windowStart;
      if (overrun > 0) log(`   ⚠️ Pre-arm overran windowStart by ${Math.round(overrun)}ms — firing immediately (late)`);
    }
    if (live.length === 0) { log(`   ❌ No sessions — waiting for next mark`); continue; }
    // 🔌 Socket warmup (optional — disabled via warmupEnabled:false / disableWarmup:true):
    // prime each account's pooled keep-alive connection with cheap HEADs
    // (off the /checks budget) so the first burst request does NOT pay a cold TLS handshake
    // that pushes its response into the mark peak.
    // Two hops on purpose: the homepage HEAD keeps/refreshes cookiesession1 for the WAF, and
    // the API-origin HEAD warms the connection the /checks call actually reuses.
    if (WARMUP_ENABLED) {
    try {
      await Promise.allSettled(live.map(async (s) => {
        await ensureModeWafCookie(s.account.email);
        const ua = getAccountUserAgent(s.account.email);
        try {
          const wr = await httpFetch('https://egy.almaviva-visa.it/', {
            method: 'HEAD',
            headers: { 'User-Agent': ua, 'Connection': 'keep-alive' },
            agent: getAgentForAccount(s.account.email),
            timeout: 10000
          }, 'WARMUP', s.account.email);
          updateWafCookieFromResponse(s.account.email, wr);
        } catch (_) { /* best-effort: burst still fires on the main pool */ }
        if (WARMUP_API_ORIGIN) {
          try {
            const ar = await httpFetch(CHECKS_ORIGIN_ROOT, {
              method: 'HEAD',
              headers: { 'User-Agent': ua, 'Connection': 'keep-alive' },
              agent: getAgentForAccount(s.account.email),
              timeout: 10000
            }, 'WARMUP_API', s.account.email);
            updateWafCookieFromResponse(s.account.email, ar);
          } catch (_) { /* best-effort: cold connect is survivable, just slower */ }
        }
      }));
      const cookied = live.filter((s) => accountWafCookies.has(String(s.account.email).toLowerCase())).length;
      log(`   🔌 Warmup done: ${cookied}/${live.length} WAF cookies ready, sockets primed${WARMUP_API_ORIGIN ? ' (egy. + egyapi.)' : ''}`);
    } catch (_) {}
    }
    await waitUntilNtpEpochOrReschedule(windowStart);
    const t0 = ntpNow();
    const dead = new Set();
    let fired = 0, ok200 = 0, skipped = 0, soft401 = 0, expired401 = 0;
    const total = perAccount * live.length;
    const step = windowMs / total;
    for (let k = 0; k < total; k++) {
      const s = live[k % live.length];
      const key = emailKey(s.account.email);
      const slotEnd = windowStart + (k + 1) * step;
      if (!dead.has(key) && !hasAccountFoundThisSession(s.account.email) && !isRateLimited(s.account.email).limited) {
        // Safety net (near-never path — pre-arm warmup covers it): never fire naked.
        // A missing cookie here means a guaranteed WAF 401; acquiring it is cheaper.
        if (WAF_COOKIE_ENABLED && !accountWafCookies.has(key)) {
          await ensureModeWafCookie(s.account.email);
        }
        const r = await fireModeCheck(s, browser);
        fired++; totalFired++;
        if (r && r.found) { modeHandleFound(s, 'CLOCK_BURST'); dead.add(key); }
        else if (r && r.rateLimited) { modeParkRateLimited(s, r.retryAfterMs); dead.add(key); log(`   ⛔ 429 ${s.account.email} — parked, rest of its slots cancelled`); }
        else if (r && (r.outsideOfficeHours || r.skippedClosed)) { skipped++; }
        else if (r && r.soft401) { soft401++; }
        else if (r && r.tokenExpired) { expired401++; }
        else if (r && (r.found === false)) { ok200++; }
      } else { skipped++; }
      const wait = slotEnd - ntpNow();
      if (wait > 0) await sleep(wait);
    }
    log(`   🏁 Burst #${cycleNo} done in ${ntpNow() - t0}ms: fired=${fired} ok=${ok200} soft401=${soft401} expired401=${expired401} skipped=${skipped} parked=${dead.size}`);
  }
}

async function runTrickleMode(rawAccounts, browser) {
  const sessions = new Map();
  let ptr = 0, totalFired = 0;
  if (USE_PROXY) log(`   ⚠️ Trickle runs direct (spoof headers on); proxy assignment not applied in this mode`);
  log(`💧 Trickle: fixed 1 req / ${TRICKLE_PER_ACCOUNT_SEC}s / account (0.4/min, under measured refill 0.45)`);
  logAccountsSkippedBecauseFound('Trickle');
  while (true) {
    throwIfLiveReschedule();
    if (ENABLE_STOP_AFTER_REQUESTS && STOP_AFTER_REQUESTS > 0 && totalFired >= STOP_AFTER_REQUESTS) {
      log(`\n🛑 Stop-after-requests reached (${totalFired}) — trickle done`);
      break;
    }
    const eligible = getModeEligibleAccounts(rawAccounts);
    if (eligible.length === 0) {
      if ((rawAccounts || []).every(a => hasAccountFoundThisSession(a && a.email))) {
        log(`\n✅ All accounts found — trickle done`); break;
      }
      log(`⏳ No eligible accounts (all parked) — waiting 60s...`);
      await sleep(60000);
      continue;
    }
    const gap = Math.max(1000, Math.round((TRICKLE_PER_ACCOUNT_SEC * 1000) / eligible.length));
    const entry = eligible[ptr % eligible.length];
    ptr++;
    const cycleStart = ntpNow();
    const s = await ensureModeSession(sessions, entry, browser);
    if (!s) { log(`   ⚠️ Login failed for ${entry.account.email}`); continue; }
    log(`🔍 [${entry.account.email}] trickle fire (gap ${Math.round(gap / 100) / 10}s, ${eligible.length} eligible)`);
    const r = await fireModeCheck(s, browser);
    totalFired++;
    if (r && r.found) modeHandleFound(s, 'TRICKLE');
    else if (r && r.rateLimited) { modeParkRateLimited(s, r.retryAfterMs); log(`   ⛔ 429 ${entry.account.email} — parked`); }
    else if (r && r.tokenExpired) log(`   ⚠️ Token issue for ${entry.account.email} — will re-login next turn`);
    const wait = gap - (ntpNow() - cycleStart);
    if (wait > 0) await sleep(wait);
  }
}

async function runRoundRobinMode(rawAccounts, browser) {
  let currentIndex = 0;
  let lastActualCheckTime = null; // تتبع وقت التشيك الفعلي للحساب السابق
  
  // Get Round-Robin settings
  const rrStartTime = CONFIG.rrStartTime || '04:30';
  const rrInterval = CONFIG.rrInterval || 60;
  
  log(`📊 إجمالي الحسابات: ${rawAccounts.length}`);
  log(`⏰ وقت البداية: ${rrStartTime} (دقيقة:ثانية)`);
  log(`⏳ الفاصل الزمني: ${rrInterval} ثانية`);
  log(`⏭️ الحساب اللي يلقى معاد بيتتخطى لحد ما تبدأ جلسة تشييك جديدة`);
  log("");
  logAccountsSkippedBecauseFound('Round-Robin');
  
  // Track actual account position (ignoring rate-limited ones)
  let actualAccountPosition = 0;
  
  while (true) {
    // Stop when every account in this run already found an appointment
    const allFound = rawAccounts.every(acc => hasAccountFoundThisSession(acc.email));
    if (allFound) {
      log("\n✅ كل الحسابات لقت معاد في الجلسة دي — إيقاف Round-Robin");
      break;
    }

    // Find next available account (skip rate limited + already found this session)
    let attempts = 0;
    let selectedRawAccount = null;
    let selectedIndex = currentIndex;
    
    while (attempts < rawAccounts.length) {
      const testAccount = rawAccounts[selectedIndex];

      if (hasAccountFoundThisSession(testAccount.email)) {
        log(`⏭️ تخطي ${testAccount.email} - لقى معاد قبل كده في الجلسة دي`);
        selectedIndex = (selectedIndex + 1) % rawAccounts.length;
        attempts++;
        continue;
      }

      const rateLimitCheck = isRateLimited(testAccount.email);
      
      if (!rateLimitCheck.limited) {
        selectedRawAccount = rawAccounts[selectedIndex];
        break;
      }
      
      const remainingMin = Math.ceil(rateLimitCheck.remainingMs / 60000);
      log(`⏸️ تخطي ${testAccount.email} - محظور (${remainingMin} دقيقة)`);
      selectedIndex = (selectedIndex + 1) % rawAccounts.length;
      attempts++;
    }
    
    // If all remaining accounts are rate limited (found ones already skipped)
    if (!selectedRawAccount) {
      log("\n⚠️ لا يوجد حساب متاح الآن (محظور أو لقى معاد)!");
      log("⏳ انتظار دقيقة واحدة...");
      await sleep(60000);
      continue;
    }
    
    // Calculate timing for next check based on ACTUAL position (not original index)
    // This ensures rate-limited accounts don't affect timing
    const checkTime = getNextCheckTime(actualAccountPosition, rrStartTime, rrInterval, lastActualCheckTime);
    const waitMs = checkTime.getTime() - ntpNow();
    
    log(`\n${"=".repeat(60)}`);
    log(`📅 الحساب التالي: ${selectedRawAccount.email}`);
    log(`🕐 الوقت الحالي (NTP): ${formatCairoHms(ntpNow(), true)}`);
    log(`🚀 وقت التشيك المحدد (NTP): ${formatCairoHms(checkTime.getTime(), true)}`);
    log(`⏱️  الوقت المتبقي: ${Math.ceil(waitMs / 1000)} ثانية`);
    if (lastActualCheckTime) {
      log(`📌 الحساب السابق بدأ في: ${formatCairoHms(lastActualCheckTime.getTime(), true)}`);
    }
    log(`${"=".repeat(60)}\n`);
    
  if (USE_PROXY && USE_PROXY_FOR_LOGIN) {
    // ========== PHASE 1: ASSIGN IP أولاً ==========
    log(`\n🌐 المرحلة 1: الحصول على IP فريد للحساب ${selectedRawAccount.email}`);
    log("=".repeat(60));
    let assignedForLogin;
    try {
      assignedForLogin = await assignUniqueIP(selectedRawAccount.email, selectedIndex);
      log(`✅ تم الحصول على IP: ${assignedForLogin.ip}`);
    } catch (e) {
      log(`❌ فشل الحصول على IP: ${e.message}`);
      log(`⏭️ الانتقال للحساب التالي...\n`);
      currentIndex = (selectedIndex + 1) % rawAccounts.length;
      continue;
    }

    // ========== PHASE 2: LOGIN باستخدام نفس ال IP ==========
    log(`\n🔐 المرحلة 2: تسجيل الدخول للحساب ${selectedRawAccount.email} (باستخدام البروكسي)`);
    log("=".repeat(60));
    let token = await loginViaAPI(selectedRawAccount, assignedForLogin.agent, 3);
    if (!token) {
      log(`   ⚠️ API login failed after 3 attempts, trying browser...`);
      const browserProxy = getBrowserProxyConfig(assignedForLogin.sessionId, assignedForLogin.ip);
      token = await loginAndGetToken(selectedRawAccount, browser, browserProxy);
    }

    if (!token) {
      log(`❌ فشل تسجيل الدخول للحساب ${selectedRawAccount.email}`);
      log(`⏭️ الانتقال للحساب التالي...\n`);
      currentIndex = (selectedIndex + 1) % rawAccounts.length;
      continue;
    }

    log(`✅ تم تسجيل الدخول بنجاح`);

    const accountData = {
      account: selectedRawAccount,
      token: token,
      accountIndex: selectedIndex,
      sessionId: assignedForLogin.sessionId,
      agent: assignedForLogin.agent,
      ip: assignedForLogin.ip,
    };
    enrichAccountData(accountData);

    // Skip Phase 3 (already have IP)

  } else {
    // ========== PHASE 1: LOGIN (بدون بروكسي) ==========
    log(`\n🔐 المرحلة 1: تسجيل الدخول للحساب ${selectedRawAccount.email}`);
    log("=".repeat(60));
    
    // Try API login first - 3 attempts
    let token = await loginViaAPI(selectedRawAccount, null, 3);
    if (!token) {
      log(`   ⚠️ API login failed after 3 attempts, trying browser...`);
      token = await loginAndGetToken(selectedRawAccount, browser);
    }
    
    if (!token) {
      log(`❌ فشل تسجيل الدخول للحساب ${selectedRawAccount.email}`);
      log(`⏭️ الانتقال للحساب التالي...\n`);
      currentIndex = (selectedIndex + 1) % rawAccounts.length;
      continue;
    }
    
    log(`✅ تم تسجيل الدخول بنجاح`);
    
    const accountData = {
      account: selectedRawAccount,
      token: token,
      accountIndex: selectedIndex,
      sessionId: null,
      agent: null,
      ip: null,
    };
    enrichAccountData(accountData);
    
    // ========== PHASE 2: ASSIGN IP (إذا كان البروكسي مفعل) ==========
    if (USE_PROXY) {
      log(`\n🌐 المرحلة 2: الحصول على IP فريد`);
      log("=".repeat(60));
      
      try {
        const ipData = await assignUniqueIP(selectedRawAccount.email, selectedIndex);
        accountData.sessionId = ipData.sessionId;
        accountData.agent = ipData.agent;
        accountData.ip = ipData.ip;
        log(`✅ تم الحصول على IP: ${ipData.ip}`);
      } catch (e) {
        log(`❌ فشل الحصول على IP: ${e.message}`);
        log(`⏭️ الانتقال للحساب التالي...\n`);
        currentIndex = (selectedIndex + 1) % rawAccounts.length;
        continue;
      }
    } else {
      log(`\n⚠️ المرحلة 2: تخطي (البروكسي معطل)`);
      accountData.ip = 'no-proxy';
    }
  }
    
    // ========== PHASE 3+4: ARM CHECKER BEFORE STRIKE (dress before alarm) ==========
    const strikeAtMs = checkTime.getTime();
    // Chain next account from planned strike (not from worker end) so interval is respected
    lastActualCheckTime = checkTime;
    const remainingWaitMs = strikeAtMs - ntpNow();
    if (remainingWaitMs > 0) {
      log(`\n⏰ المرحلة 3: تجهيز التشيك قبل الموعد`);
      log("=".repeat(60));
      log(`⏳ Armed — الإرسال عند ${formatCairoHms(strikeAtMs, true)} (بعد ~${Math.ceil(remainingWaitMs / 1000)}ث)`);
    } else {
      log(`\n✅ الوقت حان بالفعل، بدء التشيك فوراً...`);
    }

    log(`\n🔍 المرحلة 4: checker جاهز لـ ${selectedRawAccount.email}`);
    const maxRequestsForAccount = CONFIG.rrRequestsPerAccount || 25;

    try {
      await accountCheckerWorker(
        accountData,
        maxRequestsForAccount,
        null,
        remainingWaitMs > 0 ? strikeAtMs : null,
        50,
        remainingWaitMs > 0
          ? { maxWaitMs: 25 * 60 * 60 * 1000, silentFirstFire: true }
          : null
      );
    } catch (err) {
      log(`❌ خطأ في ${selectedRawAccount.email}: ${err.message}`);
    }
    
    // Check if appointment was found by THIS account
    const appointmentFile = path.join(__dirname, 'appointment-found.json');
    let appointmentFoundByThisAccount = hasAccountFoundThisSession(selectedRawAccount.email);
    
    if (!appointmentFoundByThisAccount && fs.existsSync(appointmentFile)) {
      try {
        const appointments = JSON.parse(fs.readFileSync(appointmentFile, 'utf8'));
        if (Array.isArray(appointments) && appointments.length > 0) {
          appointmentFoundByThisAccount = appointments.some(apt =>
            String(apt.account || '').toLowerCase() === String(selectedRawAccount.email).toLowerCase()
          );
        }
      } catch (e) {}
    }
    
    if (appointmentFoundByThisAccount) {
      markAccountFoundThisSession(selectedRawAccount.email);
      log(`\n🎉 تم العثور على موعد لـ ${selectedRawAccount.email}`);
      log(`⏭️ الحساب ده مش هيتشيك تاني لحد تشييك جديد — باقي الحسابات تكمل`);
    } else {
      log(`\n❌ [لم يتم العثور على موعد]`);
    }
    
    // Release IP for reuse by other accounts
    if (accountData.ip && accountData.ip !== 'no-proxy') {
      usedIPs.delete(accountData.ip);
      log(`\n🔄 تم تحرير IP ${accountData.ip} لإعادة الاستخدام`);
    }
    
    // Browser context already closed in loginAndGetToken()
    // No need to close again here
    
    // Move to next account
    currentIndex = (selectedIndex + 1) % rawAccounts.length;
    actualAccountPosition++; // Increment actual position counter
    log(`\n➡️ انتهى التشيك - الانتقال للحساب التالي\n`);
  }
  
  log("\n✅ Round-Robin Mode انتهى!");
}

// Parallel Round-Robin Mode: Login all accounts once, then rotate through them
// 🛑 ABORT MECHANISM:
// When an appointment is found, ALL pending requests are immediately aborted using AbortController
// This prevents interference with the booking process and saves resources
// The abort happens at multiple levels:
//   1. Current account's remaining requests (via abortController.abort())
//   2. All other accounts' pending requests (if continueAfterFound is false)
//   3. Proper error handling for AbortError to track cancelled requests
async function runParallelRoundRobinMode(accounts, browser) {
  log("\n" + "=".repeat(60));
  log("🔄 PARALLEL ROUND-ROBIN MODE");
  log("=".repeat(60));
  
  const PRROBIN_MODE = CONFIG.parallelRoundRobinMode || {};
  const continueAfterFound = PRROBIN_MODE.continueAfterFound !== false;
  const checkIntervalSeconds = PRROBIN_MODE.checkIntervalSeconds ?? 30;
  const maxRequestsPerAccount = PRROBIN_MODE.maxRequestsPerAccount ?? 50;
  const rrIntervalMs = Math.max(0, Number(checkIntervalSeconds) * 1000);
  
  // Display interval in milliseconds for better clarity
  const intervalDisplay = checkIntervalSeconds === 0 ? '0ms (فوري)' : `${checkIntervalSeconds}s (${checkIntervalSeconds * 1000}ms)`;
  log(`Accounts: ${accounts.length} | Interval: ${intervalDisplay} | Max Requests: ${maxRequestsPerAccount === 0 ? 'Unlimited' : maxRequestsPerAccount}`);
  log(`Continue after found: ${continueAfterFound ? 'Yes' : 'No'}`);
  log(`⏭️ الحساب اللي يلقى معاد بيتتخطى لحد ما تبدأ جلسة تشييك جديدة`);
  log("=".repeat(60) + "\n");
  
  // PHASE 1: LOGIN ALL ACCOUNTS
  log(`Phase 1: Logging in ${accounts.length} accounts...`);
  
  let accountsData = [];

  if (USE_PROXY && USE_PROXY_FOR_LOGIN) {
    const results = await assignIPsBatched(accounts);
    
    const prepared = [];
    for (const result of results) {
      const { account, index, ipData, rateLimited, success, error } = result;
      if (rateLimited) {
        const rateLimitCheck = isRateLimited(account.email);
        const remainingMin = Math.ceil(rateLimitCheck.remainingMs / 60000);
        log(`   [${index + 1}/${accounts.length}] ${account.email} - Rate limited (${remainingMin}m)`);
        continue;
      }
      if (!success) {
        log(`   [${index + 1}/${accounts.length}] ${account.email} - IP assignment failed: ${error}`);
        continue;
      }
      prepared.push({
        account,
        index,
        agent: ipData.agent,
        sessionId: ipData.sessionId,
        ip: ipData.ip
      });
    }
    
    accountsData = await loginAccountsSimultaneously(prepared, { browser, alreadyPrepared: true });
  } else {
    accountsData = await loginAccountsSimultaneously(accounts, { browser, alreadyPrepared: false });
  }

  
  if (accountsData.length === 0) {
    log("\nNo accounts logged in!");
    return;
  }
  
  log(`\n${accountsData.length} logged in successfully`)
  
  // PHASE 2: ASSIGN IPs (IF PROXY ENABLED and NOT already assigned for login)
  if (USE_PROXY && !USE_PROXY_FOR_LOGIN) {
    log(`\nPhase 2: Assigning IPs...`);
    
    for (const accountData of accountsData) {
      try {
        const ipData = await assignUniqueIP(accountData.account.email, accountData.accountIndex);
        accountData.sessionId = ipData.sessionId;
        accountData.agent = ipData.agent;
        accountData.ip = ipData.ip;
      } catch (e) {
        log(`   ✗ IP failed for ${accountData.account.email}: ${e.message}`);
        const index = accountsData.indexOf(accountData);
        accountsData.splice(index, 1);
      }
    }
    
    log(`${accountsData.length} IPs assigned`);
    
    // 🚀 PRE-WARM PROXY CONNECTIONS for faster first requests!
    log(`\n🚀 Pre-warming proxy connections...`);
    const warmupPromises = accountsData.map(async (accountData) => {
      if (!accountData.agent) return false;
      
      try {
        // Make a quick HEAD request to warm up the connection
        const warmupReq = await impersonatedFetch('https://egyapi.almaviva-visa.it/', {
          method: 'HEAD',
          agent: accountData.agent,
          timeout: 10000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Connection': 'keep-alive'
          }
        }).catch(() => null);
        
        if (warmupReq) {
          log(`   ✅ Pre-warmed connection for ${accountData.account.email}`);
          return true;
        }
        return false;
      } catch (e) {
        return false;
      }
    });
    
    const warmupResults = await Promise.all(warmupPromises);
    const successCount = warmupResults.filter(r => r).length;
    log(`   ✅ Pre-warmed ${successCount}/${accountsData.length} proxy connections`);
    
  } else if (!USE_PROXY_FOR_LOGIN) {
    log(`\nPhase 2: Proxy disabled, skipping IP assignment`);
    for (const accountData of accountsData) {
      accountData.ip = 'no-proxy';
    }
  } else {
    log(`\nPhase 2: IPs already assigned during login`);
  }
  
  if (accountsData.length === 0) {
    log("\nNo accounts ready!");
    return;
  }

  await acquireWafCookiesBulk(accountsData, 10);
  
  // =========================
  // PHASE 3 PREP BEFORE STRIKE (dress before alarm)
  // =========================
  log(`Phase 3: Arming round-robin checks قبل الضربة...\n`);

  let appointmentsFound = [];
  let globalStop = false;
  const accountsWithAppointments = new Set();
  const completedAccounts = new Set();
  for (const acc of accountsData) {
    if (hasAccountFoundThisSession(acc.account.email)) {
      completedAccounts.add(acc.account.email);
      accountsWithAppointments.add(acc.account.email);
    }
  }
  const accountRequestCounts = new Map();
  accountsData.forEach(acc => accountRequestCounts.set(acc.account.email, 0));
  const accountAbortedCounts = new Map();
  accountsData.forEach(acc => accountAbortedCounts.set(acc.account.email, 0));
  const responseTimes = [];
  let accountIndex = 0;
  let rrSilentFirstFire = true;

  await runScheduledStrikeGate('round-robin', accountsData, browser, {
    skipIfPerAccount: true
  });

  // Absolute next-account schedule (respects configured interval; no setTimeout drift)
  let rrNextAccountEpoch = null;
  const scheduleNextProcessAccount = () => {
    if (globalStop) return;
    if (rrIntervalMs <= 0) {
      setImmediate(() => { if (!globalStop) processAccount(); });
      return;
    }
    if (rrNextAccountEpoch == null) {
      rrNextAccountEpoch = ntpNow() + rrIntervalMs;
    } else {
      rrNextAccountEpoch += rrIntervalMs;
    }
    // If we fell behind, keep absolute grid (fire ASAP for missed slot, don't reset chain)
    const target = rrNextAccountEpoch;
    scheduleAtEpochPrecise(target, () => {
      if (!globalStop) processAccount();
    });
  };
  
  async function processAccount() {
    // Check if we should stop
    if (globalStop) {
      return;
    }
    // Find next available account (skip completed and rate limited)
    let attempts = 0;
    let selectedAccountData = null;
    let startIndex = accountIndex % accountsData.length;
    let actualIndex = startIndex;
    
    while (attempts < accountsData.length) {
      const testData = accountsData[actualIndex];
      
      // Skip if account completed (found appointment OR rate limited) or found earlier this session
      if (completedAccounts.has(testData.account.email) || hasAccountFoundThisSession(testData.account.email)) {
        actualIndex = (actualIndex + 1) % accountsData.length;
        attempts++;
        continue;
      }
      
      const rateLimitCheck = isRateLimited(testData.account.email);
      
      if (!rateLimitCheck.limited) {
        selectedAccountData = testData;
        break;
      }
      
      const remainingMin = Math.ceil(rateLimitCheck.remainingMs / 60000);
      log(`   Skipping ${testData.account.email} - Rate limited (${remainingMin}m)`);
      actualIndex = (actualIndex + 1) % accountsData.length;
      attempts++;
    }
    
    // All accounts are rate limited or completed
    if (!selectedAccountData) {
      // Check if all accounts are truly completed
      if (completedAccounts.size >= accountsData.length) {
        log(`\nAll accounts completed (found appointments or rate limited)!`);
        globalStop = true;
        return;
      }
      // Otherwise just skip this cycle
      accountIndex++;
      scheduleNextProcessAccount();
      return;
    }
    
    const account = selectedAccountData.account;
    const currentCount = accountRequestCounts.get(account.email) || 0;
    
    // Wait for per-account start time if enabled (only waits on first check for this account)
    if (ENABLE_PER_ACCOUNT_START_TIME && currentCount === 0) {
      await waitForPerAccountStartTime(account);
    }
    
    log(`\nChecking ${account.email} (IP: ${selectedAccountData.ip})`);
    log(`   Sending ${maxRequestsPerAccount} requests... (Total sent: ${currentCount})`);
    
    // Check if token needs refresh
    if (!(rrSilentFirstFire && currentCount === 0) && needsTokenRefreshAtCheckTime(account.email)) {
      log(`   Token refresh needed...`);
      const refreshed = await refreshTokenIfNeeded(selectedAccountData, browser);
      if (!refreshed) {
        log(`   ✗ Token refresh failed - skipping`);
        accountIndex++;
        scheduleNextProcessAccount();
        return;
      }
    }
    
    // Create AbortController for this account's requests
    const abortController = new AbortController();
    const abortSignal = abortController.signal;
    
    // Store abort controller for potential cancellation
    selectedAccountData.abortController = abortController;
    
    // Schedule next account NOW (before sending requests) — absolute epoch
    accountIndex++;
    if (rrIntervalMs > 0) {
      log(`   Next account scheduled in ${checkIntervalSeconds}s (precise)...\n`);
    } else {
      log(`   Next account scheduled immediately...\n`);
    }
    scheduleNextProcessAccount();
    
    // Send ALL requests for this account (maxRequestsPerAccount)
    let requestsSent = 0;
    let foundAppointmentInThisRound = false;
    
    for (let reqNum = 1; reqNum <= maxRequestsPerAccount; reqNum++) {
      // Check if already aborted
      if (abortSignal.aborted) {
        log(`   ⚠️ Remaining requests cancelled (${maxRequestsPerAccount - reqNum + 1} cancelled)`);
        break;
      }
      
      const quietFire = rrSilentFirstFire && reqNum === 1;
      if (quietFire) rrSilentFirstFire = false;
      if (!quietFire) {
        log(`   Request ${reqNum}/${maxRequestsPerAccount}...`);
      }
      
      try {
        // Measure response time
        const startTime = ntpNow();
        enrichAccountData(selectedAccountData);
        const result = await checkAvailability(
          selectedAccountData.officeId || OFFICE_ID,
          selectedAccountData.visaId,
          1, // serviceLevelId
          selectedAccountData.token,
          selectedAccountData.agent,
          DESTINATION,
          TRIP_DATE,
          abortSignal, // Pass abort signal
          null,  // No force timeout callback
          account.email  // 🎭 Pass account email for unique spoofed IP
        );
        const responseTime = ntpNow() - startTime;
        responseTimes.push(responseTime);
        
        requestsSent++;
        accountRequestCounts.set(account.email, (accountRequestCounts.get(account.email) || 0) + 1);
        
        // Handle token expiry
        if (result.tokenExpired) {
          if (result.soft401 || isTokenStillFresh(account.email, 120) || isNearAppointmentDropWindow()) {
            log(`      ⚡ Soft/drop-window 401 — skip refresh, continue`);
          } else {
            log(`      Token expired - refreshing...`);
            const newToken = await refreshTokenIfNeeded(selectedAccountData, browser);
            if (!newToken) {
              log(`      ✗ Token refresh failed`);
              break; // Stop sending more requests for this account
            }
            // Retry this request
            reqNum--; // Repeat this iteration
            continue;
          }
        }
        
        // Handle found appointment
        if (result.found) {
          // 🎯 Single canonical found timestamp - used by log line, UI and Telegram (identical)
          const foundEpochMs = ntpNow();
          log(`\n   ✅ APPOINTMENT FOUND! (${responseTime}ms)`);
          appointmentsFound.push(account.email);
          foundAppointmentInThisRound = true;
          
          // Save appointment
          try {
            let appointments = [];
            const appointmentFile = path.join(__dirname, 'appointment-found.json');
            
            if (fs.existsSync(appointmentFile)) {
              try {
                const existing = JSON.parse(fs.readFileSync(appointmentFile, 'utf8'));
                if (Array.isArray(existing)) {
                  appointments = existing;
                } else if (existing && existing.account) {
                  appointments = [existing];
                }
              } catch (e) {
                appointments = [];
              }
            }
            
            const now = new Date(foundEpochMs);
            const customerInfo = getAccountCustomerInfo(account);
            const newAppointment = {
              account: account.email,
              foundAt: now.toISOString(),
              foundAtReadable: `${new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', day: '2-digit', month: '2-digit', year: 'numeric' }).format(now)} ${formatCairoHms(now.getTime(), true)}`,
              office: (selectedAccountData?.officeName || accountData?.officeName || OFFICE_NAME),
              visaType: (selectedAccountData?.visaType || accountData?.visaType || VISA_NAME),
              destination: DESTINATION || 'N/A',
              tripDate: TRIP_DATE,
              ...customerInfo,
              appointmentDate: 'Check website',
              appointmentMonth: 'Check website',
              bookingStatus: 'FOUND_VIA_PARALLEL_RR',
              note: 'Appointment found in Parallel Round-Robin mode'
            };
            
            const existingIndex = appointments.findIndex(apt => apt.account === account.email);
            if (existingIndex >= 0) {
              appointments[existingIndex] = newAppointment;
            } else {
              appointments.push(newAppointment);
            }
            
            fs.writeFileSync(
              appointmentFile,
              JSON.stringify(appointments, null, 2),
              'utf8'
            );
            log(`      Saved to appointment-found.json`);

            // 📱 Send Telegram notification
            try {
              const now = new Date(foundEpochMs);
              await sendTelegramNotification({
                accountEmail: account.email,
                office: (selectedAccountData?.officeName || accountData?.officeName || OFFICE_NAME),
                visaType: (selectedAccountData?.visaType || accountData?.visaType || VISA_NAME),
                destination: DESTINATION || 'N/A',
                tripDate: TRIP_DATE,
                foundAt: now.toLocaleString('ar-EG', {
                  dateStyle: 'short',
                  timeStyle: 'medium',
                  hour12: true
                }),
                foundAtDate: now,
                requestSentDate: new Date(startTime),
                responseReceivedDate: new Date(foundEpochMs),
                responseTimeMs: foundEpochMs - startTime,
                ...customerInfo
              });
            } catch (e) {
              log(`⚠️ Could not send Telegram notification: ${e.message}`);
            }
          } catch (e) {
            log(`      ✗ Failed to save: ${e.message}`);
          }
          
          // CRITICAL: Abort all pending requests for THIS account immediately
          log(`      🛑 Aborting remaining requests for this account...`);
          abortController.abort();
          
          // Mark this account as completed (found appointment) for this whole bot session
          accountsWithAppointments.add(account.email);
          completedAccounts.add(account.email);
          markAccountFoundThisSession(account.email);
          markAccountFoundInFile(account.email, {
            office: (selectedAccountData?.officeName || accountData?.officeName || OFFICE_NAME),
            visaType: (selectedAccountData?.visaType || accountData?.visaType || VISA_NAME),
            tripDate: TRIP_DATE,
            destination: DESTINATION || 'N/A'
          });
          log(`      Account excluded from further checks until استرجاع`);
          
          // CRITICAL: If NOT continuing, abort ALL OTHER accounts' requests too
          if (!continueAfterFound) {
            log(`\n🛑 CRITICAL: Aborting ALL pending requests from ALL accounts...`);
            let abortedCount = 0;
            for (const accData of accountsData) {
              if (accData.abortController && accData.account.email !== account.email) {
                try {
                  accData.abortController.abort();
                  abortedCount++;
                } catch (e) {
                  // Already aborted or doesn't exist
                }
              }
            }
            log(`      ✓ Aborted requests from ${abortedCount} other account(s)`);
            log(`\nStopping (appointment found)\n`);
            globalStop = true;
          }
          
          break; // Stop sending more requests for this account
        }
        
        // Handle rate limiting
        if (result.rateLimited) {
          log(`      ⚠️ Rate limited - excluding from rotation (${responseTime}ms)`);
          addToRateLimited(account.email, selectedAccountData.ip, selectedAccountData.accountIndex);
          completedAccounts.add(account.email); // Mark as completed
          break; // Stop sending more requests for this account
        }
        
        // No appointment found
        
      } catch (error) {
        // Handle AbortError specially
        if (error.name === 'AbortError') {
          log(`      🛑 Request aborted (appointment found - preventing interference)`);
          // Count aborted requests
          const currentAborted = accountAbortedCounts.get(account.email) || 0;
          accountAbortedCounts.set(account.email, currentAborted + 1);
          break; // Stop the loop immediately
        }
        
        log(`      \u2717 Error: ${error.message}`);
        // Continue with next request
      }
    }
    
    // Check if we should stop globally
    if (globalStop) {
      return;
    }
    
    // Check if ALL accounts are completed (found appointment OR rate limited)
    if (completedAccounts.size >= accountsData.length) {
      log(`\nAll accounts completed (found appointments or rate limited)!`);
      globalStop = true;
      return;
    }
    
    // Next account already scheduled at the beginning
  }
  
  // Start the first account immediately
  processAccount();
  
  // Wait for all accounts to complete
  while (!globalStop) {
    await sleep(1000);
  }
  
  log("\n" + "=".repeat(60));
  log("✅ Parallel Round-Robin Mode Completed");
  log("=".repeat(60));
  
  // Show appointments found
  if (appointmentsFound.length > 0) {
    log(`\nAppointments found: ${appointmentsFound.length}`);
    appointmentsFound.forEach(email => log(`   ✓ ${email}`));
  } else {
    log(`\nNo appointments found`);
  }
  
  // Show request statistics
  log(`\nRequest Statistics:`);
  let totalRequests = 0;
  let totalAborted = 0;
  for (const [email, count] of accountRequestCounts.entries()) {
    const aborted = accountAbortedCounts.get(email) || 0;
    if (aborted > 0) {
      log(`   ${email}: ${count} requests (${aborted} aborted)`);
    } else {
      log(`   ${email}: ${count} requests`);
    }
    totalRequests += count;
    totalAborted += aborted;
  }
  log(`\nTotal requests: ${totalRequests}`);
  if (totalAborted > 0) {
    log(`🛑 Total aborted: ${totalAborted} (prevented interference with appointments)`);
  }
  
  // Show connection optimization statistics
  log(`\n⚡ Performance Optimization Stats:`);
  log(`   🚀 Connections reused: ${connectionReuseCount} times`);
  log(`   💾 DNS cache size: ${Object.keys(dnsCache).length} domains`);
  log(`   🔌 Connection pool: Keep-Alive enabled (faster requests)`);
  log(`   ⚡ TCP_NODELAY: Enabled (no buffering delay)`);
  
  // Show response time statistics
  if (responseTimes.length > 0) {
    const avgResponseTime = Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length);
    const minResponseTime = Math.min(...responseTimes);
    const maxResponseTime = Math.max(...responseTimes);
    log(`\n⏱️ Response Time Stats:`);
    log(`   Average: ${avgResponseTime}ms`);
    log(`   Min: ${minResponseTime}ms`);
    log(`   Max: ${maxResponseTime}ms`);
  }
  
  log("=".repeat(60) + "\n");
}

// =========================================================================
// SEQUENTIAL AGGRESSIVE MODE
// Sends one request per account in sequence with configurable delay
// Doesn't wait for response - fires at intervals regardless
// =========================================================================
async function runSequentialAggressiveMode(accounts, browser) {
  log("\n" + "=".repeat(60));
  log("⚡🔥 SEQUENTIAL AGGRESSIVE MODE");
  log("=".repeat(60));
  
  const SAM_MODE = CONFIG.sequentialAggressiveMode || {};
  let delayBetweenAccountsMs = SAM_MODE.delayBetweenAccountsMs ?? 200;
  let delayBetweenCyclesMs = SAM_MODE.delayBetweenCyclesMs ?? 1000;
  // 🆕 NEW: When true, only stop the account that found appointment (others continue)
  // When false (default), stop ALL accounts when ANY appointment is found
  const stopOnlyFoundAccount = SAM_MODE.stopOnlyFoundAccount !== false; // Default TRUE
  // 🧠 Smart auto-distribution: derive gaps from account count so every account
  // fires exactly on quota (max speed, no 429). Recomputed after login with the
  // real active count; manual values are kept only when smart is disabled.
  let smartSched = null;
  if (isSmartPacingEnabled(SAM_MODE)) {
    smartSched = computeSmartSchedule(accounts.length);
    delayBetweenAccountsMs = smartSched.interAccountMs;
    delayBetweenCyclesMs = smartSched.cycleDelayMs;
  }
  
  log(`Accounts: ${accounts.length} | Delay between accounts: ${delayBetweenAccountsMs}ms | Delay between cycles: ${delayBetweenCyclesMs}ms`);
  log(`Strategy: 1 request per account, then wait ${delayBetweenCyclesMs}ms before next cycle`);
  log(`🆕 Stop only found account: ${stopOnlyFoundAccount ? 'YES (other accounts continue)' : 'NO (stop all)'}`);
  log("=".repeat(60) + "\n");
  
  // PHASE 1: LOGIN ALL ACCOUNTS
  log(`Phase 1: Logging in ${accounts.length} accounts...`);
  
  const accountsData = [];
  
  // If using proxy for login, assign all IPs in parallel first (MUCH FASTER!)
  if (USE_PROXY && USE_PROXY_FOR_LOGIN) {
    const results = await assignIPsBatched(accounts);
    
    // Now login all accounts with their assigned IPs in parallel
    const loginTasks = results.map(async (result) => {
      const { account, index, ipData, rateLimited, success, error } = result;
      const i = index;
      
      if (rateLimited) {
        const rateLimitCheck = isRateLimited(account.email);
        const remainingMin = Math.ceil(rateLimitCheck.remainingMs / 60000);
        log(`   [${i + 1}/${accounts.length}] ${account.email} - Rate limited (${remainingMin}m)`);
        return null;
      }
      
      if (!success) {
        log(`   [${i + 1}/${accounts.length}] ${account.email} - IP assignment failed: ${error}`);
        return null;
      }
      
      log(`   [${i + 1}/${accounts.length}] ${account.email} (IP: ${ipData.ip})`);
      
      // Try API login first (faster, no browser) - 3 attempts
      let token = await loginViaAPI(account, ipData.agent, 3);
      
      // Fallback to browser login if API fails
      if (!token) {
        log(`   ⚠️ API login failed after 3 attempts, trying browser...`);
        const browserProxy = getBrowserProxyConfig(ipData.sessionId, ipData.ip);
        token = await loginAndGetToken(account, browser, browserProxy);
      }
      
      if (token) {
        const accountData = enrichAccountData({
          account,
          token,
          accountIndex: i,
          sessionId: ipData.sessionId,
          agent: ipData.agent,
          ip: ipData.ip
        });
        
        // Link for auto-token-update
        account._currentAccountData = accountData;
        
        log(`      ✓ Success`);
        return accountData;
      } else {
        log(`      ✗ Failed`);
        return null;
      }
    });
    
    const loginResults = await Promise.all(loginTasks);
    accountsData.push(...loginResults.filter(Boolean));
  } else {
    // Original flow: login without proxy first (parallel)
    const loginTasks = accounts.map(async (account, i) => {
      
      // Skip rate-limited accounts during initial login
      const rateLimitCheck = isRateLimited(account.email);
      if (rateLimitCheck.limited) {
        const remainingMin = Math.ceil(rateLimitCheck.remainingMs / 60000);
        log(`   [${i + 1}/${accounts.length}] ${account.email} - Rate limited (${remainingMin}m)`);
        return null;
      }
      
      log(`   [${i + 1}/${accounts.length}] ${account.email}`);
      
      // Try API login first (faster, no browser) - 3 attempts
      let token = await loginViaAPI(account, null, 3);
      
      // Fallback to browser login if API fails
      if (!token) {
        log(`   ⚠️ API login failed after 3 attempts, trying browser...`);
        token = await loginAndGetToken(account, browser);
      }
      
      if (token) {
        const accountData = enrichAccountData({
          account,
          token,
          accountIndex: i,
          sessionId: null,
          agent: null,
          ip: null
        });
        
        // Link for auto-token-update
        account._currentAccountData = accountData;
        
        log(`      ✓ Success`);
        return accountData;
      } else {
        log(`      ✗ Failed`);
        return null;
      }
    });
    
    const loginResults = await Promise.all(loginTasks);
    accountsData.push(...loginResults.filter(Boolean));
  }
  
  if (accountsData.length === 0) {
    log("\nNo accounts logged in!");
    return;
  }
  
  log(`\n${accountsData.length} logged in successfully`);
  
  // PHASE 2: ASSIGN IPs (IF PROXY ENABLED and NOT already assigned for login)
  if (USE_PROXY && !USE_PROXY_FOR_LOGIN) {
    log(`\nPhase 2: Assigning IPs...`);
    
    for (const accountData of accountsData) {
      try {
        const ipData = await assignUniqueIP(accountData.account.email, accountData.accountIndex);
        accountData.sessionId = ipData.sessionId;
        accountData.agent = ipData.agent;
        accountData.ip = ipData.ip;
      } catch (e) {
        log(`   ✗ IP failed for ${accountData.account.email}: ${e.message}`);
        const index = accountsData.indexOf(accountData);
        accountsData.splice(index, 1);
      }
    }
    
    log(`${accountsData.length} IPs assigned`);
  } else if (!USE_PROXY) {
    log(`\nPhase 2: Proxy disabled, skipping IP assignment`);
    for (const accountData of accountsData) {
      accountData.ip = accountData.ip || 'no-proxy';
    }
  } else {
    log(`\nPhase 2: IPs already assigned during login`);
  }
  
  if (accountsData.length === 0) {
    log("\nNo accounts ready!");
    return;
  }

  // 🧠 Recompute with the real logged-in count (some accounts may have failed login)
  if (isSmartPacingEnabled(SAM_MODE)) {
    smartSched = computeSmartSchedule(accountsData.length);
    delayBetweenAccountsMs = smartSched.interAccountMs;
    delayBetweenCyclesMs = smartSched.cycleDelayMs;
    logSmartSchedule(smartSched, 'SEQ-AGGRESSIVE');
  }

  await acquireWafCookiesBulk(accountsData, 10);

  // Per-account office + visa from accounts.json (fixes Study/Business etc. sending Tourism visaId=1)
  for (const accountData of accountsData) {
    enrichAccountData(accountData);
  }
  log(`\n📋 Checks will use per-account office/visa:`);
  for (const accountData of accountsData.slice(0, 5)) {
    log(`   ✅ [${accountData.account.email}] Office: ${accountData.officeName} (${accountData.officeId}) | Visa: ${accountData.visaType} (${accountData.visaId})`);
  }
  if (accountsData.length > 5) {
    log(`   … and ${accountsData.length - 5} more`);
  }
  
  // =========================
  // PHASE 3 PREP BEFORE STRIKE (dress before alarm)
  // =========================
  log(`\nPhase 3: Arming Sequential Aggressive checks...`);
  log(`⚡ 1 request per account every ${delayBetweenAccountsMs}ms (not waiting for response)\n`);

  let globalStop = false;
  let appointmentsFound = [];
  const completedAccounts = new Set();
  syncAccountsFoundFromFile();
  for (const acc of accountsData) {
    if (hasAccountFoundThisSession(acc.account.email)) {
      completedAccounts.add(acc.account.email);
    }
  }
  const accountRequestCounts = new Map();
  accountsData.forEach(acc => accountRequestCounts.set(acc.account.email, 0));
  const activeRequests = [];
  const globalAbortController = new AbortController();
  const accountAbortControllers = new Map();
  accountsData.forEach(acc => {
    accountAbortControllers.set(acc.account.email, new AbortController());
  });

  // Per-account start time: wait for each account's individual time before starting
  if (ENABLE_PER_ACCOUNT_START_TIME) {
    log(`\n⏰ Per-account start times enabled - each account will wait for its own scheduled time`);
    const perAccountWaitPromises = accountsData.map(accountData => 
      waitForPerAccountStartTime(accountData.account)
    );
    await Promise.all(perAccountWaitPromises);
    log(`✅ All per-account start times reached. Starting checks...\n`);
  }
  
  // Function to process results from completed requests
    const processResult = async (result, accountData, timing = {}) => {
      if (result.found) {
        // 🎯 Single canonical found timestamp - used by log line, UI and Telegram (identical)
        const foundEpochMs = ntpNow();
        timing = {
          ...timing,
          responseReceivedDate: new Date(foundEpochMs),
          responseTimeMs: foundEpochMs - (timing.requestSentDate ? timing.requestSentDate.getTime() : ntpNow())
        };
        log(`\n${"🎉".repeat(60)}`);
        log(`🎉 FOUND APPOINTMENT AVAILABLE FOR: ${accountData.account.email}`);
        log(`⏭️ مش هيتشيك على الحساب ده تاني لحد تشييك جديد`);
        log(`${"🎉".repeat(60)}\n`);
        log(`⚡✅ APPOINTMENT FOUND for ${accountData.account.email}!`);
      appointmentsFound.push(accountData.account.email);
      completedAccounts.add(accountData.account.email);
      markAccountFoundThisSession(accountData.account.email);
      markAccountFoundInFile(accountData.account.email, {
        office: accountData.officeName || OFFICE_NAME,
        visaType: accountData.visaType || VISA_NAME,
        tripDate: TRIP_DATE,
        destination: DESTINATION || 'N/A'
      });
      
      // Save appointment immediately
      try {
        let appointments = [];
        const appointmentFile = path.join(__dirname, 'appointment-found.json');
        
        if (fs.existsSync(appointmentFile)) {
          try {
            const existing = JSON.parse(fs.readFileSync(appointmentFile, 'utf8'));
            if (Array.isArray(existing)) {
              appointments = existing;
            } else if (existing && existing.account) {
              appointments = [existing];
            }
          } catch (e) {
            appointments = [];
          }
        }
        
        const now = new Date(foundEpochMs);
        const customerInfo = getAccountCustomerInfo(accountData.account);
        const resolvedOffice = accountData.officeName || OFFICE_NAME;
        const resolvedVisa = accountData.visaType || VISA_NAME;
        const newAppointment = {
          account: accountData.account.email,
          foundAt: now.toISOString(),
            foundAtReadable: `${new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', day: '2-digit', month: '2-digit', year: 'numeric' }).format(now)} ${formatCairoHms(now.getTime(), true)}`,
          office: resolvedOffice,
          visaType: resolvedVisa,
          destination: DESTINATION || 'N/A',
          tripDate: TRIP_DATE,
          ...customerInfo,
          appointmentDate: 'Check website',
          appointmentMonth: 'Check website',
          bookingStatus: 'FOUND_VIA_SEQ_AGGRESSIVE',
          note: 'Appointment found in Sequential Aggressive mode'
        };
        
        const existingIndex = appointments.findIndex(apt => apt.account === accountData.account.email);
        if (existingIndex >= 0) {
          appointments[existingIndex] = newAppointment;
        } else {
          appointments.push(newAppointment);
        }
        
        fs.writeFileSync(appointmentFile, JSON.stringify(appointments, null, 2), 'utf8');
        log(`   Saved to appointment-found.json (${resolvedOffice} | ${resolvedVisa})`);

        // 📱 Send Telegram notification
        try {
          const now = new Date(foundEpochMs);
          await sendTelegramNotification({
            accountEmail: accountData.account.email,
            office: resolvedOffice,
            visaType: resolvedVisa,
            destination: DESTINATION || 'N/A',
            tripDate: TRIP_DATE,
            foundAt: now.toLocaleString('ar-EG', {
              dateStyle: 'short',
              timeStyle: 'medium',
              hour12: true
            }),
            foundAtDate: now,
            ...timing,
            ...customerInfo
          });
        } catch (e) {
          log(`⚠️ Could not send Telegram notification: ${e.message}`);
        }
      } catch (e) {
        log(`   ✗ Failed to save: ${e.message}`);
      }
      
      // 🆕 NEW: Handle based on stopOnlyFoundAccount setting
      if (stopOnlyFoundAccount) {
        // ONLY stop this specific account - others continue!
        const accountController = accountAbortControllers.get(accountData.account.email);
        if (accountController) {
          accountController.abort();
        }
        log(`   ➡️ Remaining active accounts: ${accountsData.length - completedAccounts.size}`);
      } else {
        // Original behavior: stop ALL accounts
        log(`   🛑 Stopping ALL accounts (stopOnlyFoundAccount is false)`);
        globalAbortController.abort();
        globalStop = true;
      }
    }
    
    if (result.rateLimited) {
      log(`   ⚠️ ${accountData.account.email} Rate limited`);
      addToRateLimited(accountData.account.email, accountData.ip, accountData.accountIndex);
      completedAccounts.add(accountData.account.email);
      // Abort only this account's pending requests
      const accountController = accountAbortControllers.get(accountData.account.email);
      if (accountController) {
        accountController.abort();
      }
    }
  };
  
  // Main loop - cycles through accounts sequentially
  let cycleCount = 0;
  const maxCycles = 100000; // Safety limit

  // Strike wait LAST — all prep above is done (dress before alarm)
  if (CONFIG.enableScheduledCheck && CONFIG.scheduledCheckTime) {
    await runScheduledStrikeGate('seq-aggressive', accountsData, browser);
  }
  
  while (!globalStop && cycleCount < maxCycles) {
    cycleCount++;
    
    // Don't log before the wave when gaps are tight — logging itself costs ms
    const tightGaps = delayBetweenAccountsMs <= 20;

    // Absolute stagger: fire at anchor + i*delay (not sleep-after-fire which drifts to ~15ms)
    const waveAnchorMs = ntpNow();
    const cycleStartTime = waveAnchorMs;
    if (cycleCount > 1 && !tightGaps) {
      log(`\n🔄 Cycle ${cycleCount} started at ${formatCairoHms(waveAnchorMs, true)} - Sending requests to ${accountsData.length - completedAccounts.size} active accounts...`);
    }
    let staggerSlot = 0;
    
    for (let i = 0; i < accountsData.length && !globalStop; i++) {
      const accountData = accountsData[i];
      const account = accountData.account;
      
      // Skip completed accounts (found appointment or rate limited)
      if (completedAccounts.has(account.email)) {
        continue;
      }
      
      // Skip rate limited
      const rateLimitCheck = isRateLimited(account.email);
      if (rateLimitCheck.limited) {
        continue;
      }

      const slot = staggerSlot++;
      await waitForStaggerSlot(waveAnchorMs, slot, delayBetweenAccountsMs);
      if (globalStop || isLiveReschedulePending()) break;
      
      // Check if token needs refresh (skip blocking refresh on the very first fire)
      if (!(cycleCount === 1 && slot === 0) && needsTokenRefreshAtCheckTime(account.email)) {
        log(`   🔄 Token refresh needed for ${account.email}...`);
        const refreshed = await refreshTokenIfNeeded(accountData, browser);
        if (!refreshed) {
          log(`   ✗ Token refresh failed - skipping ${account.email}`);
          completedAccounts.add(account.email);
          continue;
        }
      }
      
      // Increment request count
      accountRequestCounts.set(account.email, (accountRequestCounts.get(account.email) || 0) + 1);
      const reqCount = accountRequestCounts.get(account.email);
      
      // 🆕 Get the appropriate abort signal based on mode
      const accountAbortController = accountAbortControllers.get(account.email);
      const abortSignal = stopOnlyFoundAccount 
        ? accountAbortController.signal  // Per-account signal
        : globalAbortController.signal;  // Global signal (stops all)
      
      // 🆕 Check if this account's controller is already aborted (found appointment)
      if (abortSignal.aborted) {
        log(`   ⏭️ [${account.email}] Skipping - account already found appointment`);
        continue;
      }

      const isCriticalFirstFire = cycleCount === 1 && slot === 0;
      const deferLog = tightGaps;
      if (!deferLog) {
        log(`   [${account.email}] Request #${reqCount}`);
      }
      
      // Fire request WITHOUT waiting for response
      const firedAtMs = ntpNow();
      // Queue sent log BEFORE starting HTTP — appears above Status, not under replies
      if (deferLog || isCriticalFirstFire) {
        const activeLeft = accountsData.length - completedAccounts.size;
        logRequestSentDeferred(
          (slot === 0
            ? `\n🔄 Cycle ${cycleCount} started at ${formatCairoHms(waveAnchorMs, true)} - Sending requests to ${activeLeft} active accounts...\n`
            : '') +
          `   [${account.email}] Request #${reqCount} | sent ${formatCairoHms(firedAtMs, true)} (Δ${firedAtMs - waveAnchorMs}ms)`
        );
      }
      const requestPromise = (async () => {
        const reqStartMs = firedAtMs;
        try {
          const result = await checkAvailability(
            accountData.officeId || OFFICE_ID,
            accountData.visaId,
            1,
            accountData.token,
            accountData.agent,
            DESTINATION,
            TRIP_DATE,
            abortSignal,  // 🆕 Use the appropriate abort signal
            null,  // No force timeout callback
            account.email  // 🎭 Pass account email for unique spoofed IP
          );
          const reqEndMs = Date.now();
          
          // Process result when it comes back (async)
          await processResult(result, accountData, {
            requestSentDate: new Date(reqStartMs),
            responseReceivedDate: new Date(reqEndMs),
            responseTimeMs: reqEndMs - reqStartMs
          });
          return result;
        } catch (error) {
          if (error.name === 'AbortError') {
            return { found: false, cancelled: true };
          }
          return { found: false, error: error.message };
        }
      })();
      
      activeRequests.push(requestPromise);
      
      // Clean up old completed requests to avoid memory issues
      if (activeRequests.length > 100) {
        await Promise.allSettled(activeRequests.slice(0, 50));
        activeRequests.splice(0, 50);
      }
    }
    
    // Check if all accounts are completed
    if (completedAccounts.size >= accountsData.length) {
      log(`\nAll accounts completed (found appointments or rate limited)!`);
      globalStop = true;
      break;
    }
    
    // Wait between cycles - calculated from wave START (NTP) for precise timing
    if (!globalStop && delayBetweenCyclesMs > 0) {
      const nextCycleAt = cycleStartTime + delayBetweenCyclesMs;
      const cycleElapsed = ntpNow() - cycleStartTime;
      const remainingWait = nextCycleAt - ntpNow();
      
      const logCycleWait = () => {
        if (remainingWait > 0) {
          log(`⏳ Cycle took ${cycleElapsed}ms - waiting ${remainingWait}ms for next cycle at ${formatCairoHms(nextCycleAt, true)}`);
        } else {
          log(`⚡ Cycle took ${cycleElapsed}ms (longer than interval) - starting next cycle immediately`);
        }
      };
      if (tightGaps) setImmediate(logCycleWait);
      else logCycleWait();

      if (remainingWait > 0) {
        const nextAccounts = accountsData.filter((a) => !completedAccounts.has(a.account.email));
        await waitUntilFireWithPreRefresh(nextCycleAt, nextAccounts, browser, `sam-cycle-${cycleCount + 1}`);
      }
    }
  }
  
  // Wait for remaining active requests (with timeout)
  if (activeRequests.length > 0) {
    log(`\n⏳ Waiting for ${activeRequests.length} remaining requests (max 5s)...`);
    const timeoutPromise = new Promise(resolve => setTimeout(resolve, 5000));
    await Promise.race([Promise.allSettled(activeRequests), timeoutPromise]);
  }
  
  log("\n" + "=".repeat(60));
  log("✅ Sequential Aggressive Mode Completed");
  log("=".repeat(60));
  
  // Show statistics
  if (appointmentsFound.length > 0) {
    log(`\nAppointments found: ${appointmentsFound.length}`);
    appointmentsFound.forEach(email => log(`   ✓ ${email}`));
  } else {
    log(`\nNo appointments found`);
  }
  
  log(`\nRequest Statistics:`);
  let totalRequests = 0;
  for (const [email, count] of accountRequestCounts.entries()) {
    log(`   ${email}: ${count} requests`);
    totalRequests += count;
  }
  log(`\nTotal requests: ${totalRequests}`);
  log(`Total cycles: ${cycleCount}`);
  log("=".repeat(60) + "\n");
}

async function runSequentialAggressivePlusMode(accounts, browser) {
  const isFakeProbe = FAKE_PROBE_ACTIVE === true;
  log("\n" + "=".repeat(60));
  log(isFakeProbe ? "🧪⚡ FAKE PROBE — SEQUENTIAL AGGRESSIVE PLUS" : "⚡🔥 SEQUENTIAL AGGRESSIVE PLUS MODE");
  log("=".repeat(60));
  
  const SAM_MODE = isFakeProbe
    ? (CONFIG.sequentialAggressiveFakeMode || {})
    : (CONFIG.sequentialAggressivePlusMode || {});
  let delayBetweenAccountsMs = SAM_MODE.delayBetweenAccountsMs ?? 200;
  let delayBetweenCyclesMs = SAM_MODE.delayBetweenCyclesMs ?? 1000;
  // 🆕 NEW: When true, only stop the account that found appointment (others continue)
  // When false (default), stop ALL accounts when ANY appointment is found
  const stopOnlyFoundAccount = SAM_MODE.stopOnlyFoundAccount !== false; // Default TRUE
  // 🧠 Smart auto-distribution (same as classic mode); fake probe keeps manual timing.
  let smartSchedPlus = null;
  if (!isFakeProbe && isSmartPacingEnabled(SAM_MODE)) {
    smartSchedPlus = computeSmartSchedule(accounts.length);
    delayBetweenAccountsMs = smartSchedPlus.interAccountMs;
    delayBetweenCyclesMs = smartSchedPlus.cycleDelayMs;
  }

  // Fake probe: optional dedicated schedule (does not touch main config permanently)
  const prevSchedule = {
    enable: CONFIG.enableScheduledCheck,
    time: CONFIG.scheduledCheckTime
  };
  if (isFakeProbe && SAM_MODE.enableScheduledCheck && SAM_MODE.scheduledCheckTime) {
    CONFIG.enableScheduledCheck = true;
    CONFIG.scheduledCheckTime = SAM_MODE.scheduledCheckTime;
  }
  
  log(`Accounts: ${accounts.length} | Delay between accounts: ${delayBetweenAccountsMs}ms | Delay between cycles: ${delayBetweenCyclesMs}ms`);
  if (isFakeProbe) {
    log(`🧪 Fake targets (${FAKE_PROBE_TARGETS.length}): ${FAKE_PROBE_TARGETS.map(t => `${t.officeName}/${t.visaType}`).join(' | ')}`);
    log(`Strategy: لكل اكاونت → كل التاشيرات/المراكز المختارة في نفس اللحظة`);
  } else {
    log(`Strategy: 1 request per account, then wait ${delayBetweenCyclesMs}ms before next cycle`);
  }
  const maxCyclesConfig = SAM_MODE.maxCycles > 0 ? SAM_MODE.maxCycles : '♾️ Unlimited (100k safety cap)';
  log(`🆕 Stop only found account: ${stopOnlyFoundAccount ? 'YES (other accounts continue)' : 'NO (stop all)'}`);
  log(`⏹️ Max cycles: ${maxCyclesConfig}`);
  log("=".repeat(60) + "\n");
  
  // PHASE 1: LOGIN ALL ACCOUNTS
  log(`Phase 1: Logging in ${accounts.length} accounts...`);
  
  let accountsData = [];

  if (USE_PROXY && USE_PROXY_FOR_LOGIN) {
    const results = await assignIPsBatched(accounts);
    
    const prepared = [];
    for (const result of results) {
      const { account, index, ipData, rateLimited, success, error } = result;
      if (rateLimited) {
        const rateLimitCheck = isRateLimited(account.email);
        const remainingMin = Math.ceil(rateLimitCheck.remainingMs / 60000);
        log(`   [${index + 1}/${accounts.length}] ${account.email} - Rate limited (${remainingMin}m)`);
        continue;
      }
      if (!success) {
        log(`   [${index + 1}/${accounts.length}] ${account.email} - IP assignment failed: ${error}`);
        continue;
      }
      prepared.push({
        account,
        index,
        agent: ipData.agent,
        sessionId: ipData.sessionId,
        ip: ipData.ip
      });
    }
    
    accountsData = await loginAccountsSimultaneously(prepared, { browser, alreadyPrepared: true });
  } else {
    accountsData = await loginAccountsSimultaneously(accounts, { browser, alreadyPrepared: false });
  }

  
  if (accountsData.length === 0) {
    log("\nNo accounts logged in!");
    return;
  }
  
  log(`\n${accountsData.length} logged in successfully`)
  
  // PHASE 2: ASSIGN IPs (IF PROXY ENABLED and NOT already assigned for login)
  if (USE_PROXY && !USE_PROXY_FOR_LOGIN) {
    log(`\nPhase 2: Assigning IPs...`);
    
    for (const accountData of accountsData) {
      try {
        const ipData = await assignUniqueIP(accountData.account.email, accountData.accountIndex);
        accountData.sessionId = ipData.sessionId;
        accountData.agent = ipData.agent;
        accountData.ip = ipData.ip;
      } catch (e) {
        log(`   ✗ IP failed for ${accountData.account.email}: ${e.message}`);
        const index = accountsData.indexOf(accountData);
        accountsData.splice(index, 1);
      }
    }
    
    log(`${accountsData.length} IPs assigned`);
  } else if (!USE_PROXY_FOR_LOGIN) {
    log(`\nPhase 2: Proxy disabled, skipping IP assignment`);
    for (const accountData of accountsData) {
      accountData.ip = 'no-proxy';
    }
  } else {
    log(`\nPhase 2: IPs already assigned during login`);
  }
  
  if (accountsData.length === 0) {
    log("\nNo accounts ready!");
    return;
  }

  // 🧠 Recompute with the real logged-in count (some accounts may have failed login)
  if (!isFakeProbe && isSmartPacingEnabled(SAM_MODE)) {
    smartSchedPlus = computeSmartSchedule(accountsData.length);
    delayBetweenAccountsMs = smartSchedPlus.interAccountMs;
    delayBetweenCyclesMs = smartSchedPlus.cycleDelayMs;
    logSmartSchedule(smartSchedPlus, 'SEQ-AGGRESSIVE-PLUS');
  }

  await acquireWafCookiesBulk(accountsData, 10);
  
  // Pre-warm per-account data BEFORE scheduling wait (so prep never eats into .000)
  // Prep + spoofed IP generation stays silent (still runs in background)
  for (const accountData of accountsData) {
    try { enrichAccountData(accountData); } catch (_) {}
    try { getSpoofedIPForAccount(accountData.account.email); } catch (_) {}
  }

  // Resolve scheduled target early (log only) — actual wait is RIGHT before first request
  const scheduledTarget = getScheduledCheckTarget('first start');
  
  // Per-account start time: wait for each account's individual time before starting
  if (ENABLE_PER_ACCOUNT_START_TIME) {
    log(`\n⏰ Per-account start times enabled - each account will wait for its own scheduled time`);
    const perAccountWaitPromises = accountsData.map(accountData => 
      waitForPerAccountStartTime(accountData.account)
    );
    await Promise.all(perAccountWaitPromises);
    log(`✅ All per-account start times reached. Starting checks...\n`);
  }
  
  // PHASE 3: SEQUENTIAL AGGRESSIVE CHECKS
  log(`\nPhase 3: Starting Sequential Aggressive Plus checks...`);
  log(`⚡ Firing 1 request per account every ${delayBetweenAccountsMs}ms (not waiting for response)\n`);
  
  const restartDelayMinutes = SAM_MODE.restartDelayMinutes || 0;
  let shouldRestart = false;
  let pendingFireAtMs = null; // NTP epoch for next round start (null = fire ASAP)
  let isFirstRound = true;
  
  // 💓 Silent background keep-alive (no logs, fire-and-forget — won't delay checks)
  let keepAliveInterval = null;
  if (ENABLE_KEEP_ALIVE && accountsData.length > 0) {
    keepAliveInterval = setInterval(() => {
      if (typeof isRaceQuiet === 'function' && isRaceQuiet()) return;
      for (const accountData of accountsData) {
        if (accountCurrentTokens.has(accountData.account.email)) {
          keepAlivePing(accountData.account.email).catch(() => {});
        }
      }
    }, KEEP_ALIVE_INTERVAL_MINUTES * 60 * 1000);
  }
  
  do {
    // ── 1) Prep round state BEFORE the precise wait (so wait→first request is instant) ──
    let globalStop = false;
    let appointmentsFound = [];
    // Keep accounts that already found an appointment out of every restarted round (session-wide)
    const completedAccounts = new Set();
    if (isFakeProbe) {
      syncFakeProbeFoundFromFile();
      for (const acc of accountsData) {
        if (hasFakeProbeAccountFullyFound(acc.account.email)) {
          completedAccounts.add(acc.account.email);
        }
      }
      logAccountsSkippedBecauseFound('Fake Probe');
    } else {
      syncAccountsFoundFromFile();
      for (const acc of accountsData) {
        if (hasAccountFoundThisSession(acc.account.email)) {
          completedAccounts.add(acc.account.email);
        }
      }
      logAccountsSkippedBecauseFound('Sequential Aggressive Plus');
    }
    const accountRequestCounts = new Map();
    accountsData.forEach(acc => accountRequestCounts.set(acc.account.email, 0));
    
    // Track active requests (don't wait for them during the fire loop)
    const activeRequests = [];
    let roundClosed = false;
    suppressLateHttpLogs = false;
    
    // Global abort controller for all requests (used when stopOnlyFoundAccount is false)
    const globalAbortController = new AbortController();
    
    // 🆕 Per-account abort controllers (used when stopOnlyFoundAccount is true)
    const accountAbortControllers = new Map();
    accountsData.forEach(acc => {
      accountAbortControllers.set(acc.account.email, new AbortController());
    });
    
    // Function to process results from completed requests
    // targetOverride: fake-probe office/visa for this specific request
    const processResult = async (result, accountData, timing = {}, targetOverride = null) => {
      if (result.found) {
        const resolvedOffice = targetOverride?.officeName || accountData.officeName || OFFICE_NAME;
        const resolvedVisa = targetOverride?.visaType || accountData.visaType || VISA_NAME;
        const resolvedOfficeId = targetOverride?.officeId || accountData.officeId || OFFICE_ID;
        const resolvedVisaId = targetOverride?.visaId || accountData.visaId || VISA_TYPE_TO_ID[resolvedVisa] || 1;

        // 🎯 Single canonical found timestamp - used by log line, UI and Telegram (identical)
        const foundEpochMs = ntpNow();
        timing = {
          ...timing,
          responseReceivedDate: new Date(foundEpochMs),
          responseTimeMs: foundEpochMs - (timing.requestSentDate ? timing.requestSentDate.getTime() : ntpNow())
        };
        // Always handle FOUND even if the round already closed
        if (roundClosed) {
          log(`🎉 FOUND (late) for ${accountData.account.email} | ${resolvedOffice} | ${resolvedVisa}`);
        } else {
          log(`\n${"🎉".repeat(60)}`);
          log(`🎉 FOUND APPOINTMENT AVAILABLE FOR: ${accountData.account.email}`);
          log(`   📍 ${resolvedOffice} | 🎫 ${resolvedVisa}`);
          if (isFakeProbe) {
            log(`⏭️ الهدف ده هيتخطى — باقي التاشيرات/المراكز لنفس الحساب تكمل`);
          } else {
            log(`⏭️ مش هيتشيك على الحساب ده تاني لحد تشييك جديد`);
          }
          log(`${"🎉".repeat(60)}\n`);
        }
        appointmentsFound.push(`${accountData.account.email} | ${resolvedOffice} | ${resolvedVisa}`);

        if (isFakeProbe) {
          accountsFoundThisSession.add(fakeProbeTargetKey(accountData.account.email, resolvedOfficeId, resolvedVisaId));
          markFakeProbeFoundInFile(accountData.account.email, {
            office: resolvedOffice,
            visaType: resolvedVisa,
            tripDate: TRIP_DATE,
            destination: DESTINATION || 'N/A'
          });
          if (hasFakeProbeAccountFullyFound(accountData.account.email)) {
            completedAccounts.add(accountData.account.email);
          }
        } else {
          completedAccounts.add(accountData.account.email);
          markAccountFoundThisSession(accountData.account.email);
          markAccountFoundInFile(accountData.account.email, {
            office: resolvedOffice,
            visaType: resolvedVisa,
            tripDate: TRIP_DATE,
            destination: DESTINATION || 'N/A'
          });
        }
        
        // Save appointment immediately
        try {
          let appointments = [];
          const appointmentFile = path.join(__dirname, 'appointment-found.json');
          
          if (fs.existsSync(appointmentFile)) {
            try {
              const existing = JSON.parse(fs.readFileSync(appointmentFile, 'utf8'));
              if (Array.isArray(existing)) {
                appointments = existing;
              } else if (existing && existing.account) {
                appointments = [existing];
              }
            } catch (e) {
              appointments = [];
            }
          }
          
          const now = new Date(foundEpochMs);
          const customerInfo = getAccountCustomerInfo(accountData.account);
          const newAppointment = {
            account: accountData.account.email,
            foundAt: now.toISOString(),
          foundAtReadable: `${new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', day: '2-digit', month: '2-digit', year: 'numeric' }).format(now)} ${formatCairoHms(now.getTime(), true)}`,
            office: resolvedOffice,
            visaType: resolvedVisa,
            destination: DESTINATION || 'N/A',
            tripDate: TRIP_DATE,
            ...customerInfo,
            appointmentDate: 'Check website',
            appointmentMonth: 'Check website',
            bookingStatus: isFakeProbe ? 'FOUND_VIA_FAKE_PROBE' : 'FOUND_VIA_SEQ_AGGRESSIVE_PLUS',
            note: isFakeProbe
              ? 'Appointment found in Fake Probe (timing) mode'
              : 'Appointment found in Sequential Aggressive Plus mode'
          };
          
          // Fake probe: one green card per account+office+visa (same email can appear twice)
          const existingIndex = isFakeProbe
            ? appointments.findIndex(apt =>
                apt.account === accountData.account.email &&
                apt.office === resolvedOffice &&
                apt.visaType === resolvedVisa)
            : appointments.findIndex(apt => apt.account === accountData.account.email);
          if (existingIndex >= 0) {
            appointments[existingIndex] = newAppointment;
          } else {
            appointments.push(newAppointment);
          }
          
          fs.writeFileSync(appointmentFile, JSON.stringify(appointments, null, 2), 'utf8');
          log(`   Saved to appointment-found.json (${resolvedOffice} | ${resolvedVisa})`);
  
          // 📱 Send Telegram notification
          try {
            const now = new Date(foundEpochMs);
            const tgOk = await sendTelegramNotification({
              accountEmail: accountData.account.email,
              office: resolvedOffice,
              visaType: resolvedVisa,
              destination: DESTINATION || 'N/A',
              tripDate: TRIP_DATE,
              foundAt: now.toLocaleString('ar-EG', {
                dateStyle: 'short',
                timeStyle: 'medium',
                hour12: true
              }),
              foundAtDate: now,
              isFakeProbe: isFakeProbe,
              ...timing,
              ...customerInfo
            });
            if (isFakeProbe) {
              log(tgOk
                ? `   📱 Telegram: تم إرسال إشعار التقاط (${resolvedOffice} | ${resolvedVisa})`
                : `   ⚠️ Telegram: فشل إرسال إشعار التقاط (${resolvedOffice} | ${resolvedVisa})`);
            }
          } catch (e) {
            log(`⚠️ Could not send Telegram notification: ${e.message}`);
          }
        } catch (e) {
          log(`   ✗ Failed to save: ${e.message}`);
        }
        
        // 🆕 NEW: Handle based on stopOnlyFoundAccount setting
        if (isFakeProbe) {
          // Don't abort whole account on one visa — other targets keep firing
          if (completedAccounts.has(accountData.account.email)) {
            const accountController = accountAbortControllers.get(accountData.account.email);
            if (accountController) accountController.abort();
          }
          log(`   ➡️ Remaining active accounts: ${accountsData.length - completedAccounts.size}`);
        } else if (stopOnlyFoundAccount) {
          // ONLY stop this specific account - others continue!
          const accountController = accountAbortControllers.get(accountData.account.email);
          if (accountController) {
            accountController.abort();
          }
          log(`   ➡️ Remaining active accounts: ${accountsData.length - completedAccounts.size}`);
        } else {
          // Original behavior: stop ALL accounts
          log(`   🛑 Stopping ALL accounts (stopOnlyFoundAccount is false)`);
          globalAbortController.abort();
          globalStop = true;
        }
      }
      
      if (result.rateLimited) {
        if (!roundClosed) {
          log(`   ⚠️ ${accountData.account.email} Rate limited`);
        }
        addToRateLimited(accountData.account.email, accountData.ip, accountData.accountIndex);
        completedAccounts.add(accountData.account.email);
        // Abort only this account's pending requests
        const accountController = accountAbortControllers.get(accountData.account.email);
        if (accountController) {
          accountController.abort();
        }
      }
    };
    
    // Main loop - cycles through accounts sequentially
    let cycleCount = 0;
    const maxCycles = SAM_MODE.maxCycles > 0 ? SAM_MODE.maxCycles : 100000; // Configurable, default 100000 safety cap

    // ── 2) Precise NTP wait AFTER prep, IMMEDIATELY before first request ──
    if (isFirstRound && scheduledTarget) {
      await runScheduledStrikeGate('first start', accountsData, browser, {
        precomputed: scheduledTarget
      });
    } else if (pendingFireAtMs && pendingFireAtMs > ntpNow()) {
      prepareCheckRequestsForAccounts(accountsData, 1);
      await waitUntilNtpEpochOrReschedule(pendingFireAtMs, {
        label: 'seq-aggressive-restart',
        tickEveryMs: 60000,
        spinBeforeMs: 50,
        onTick: (remaining) => {
          if (RACE_MODE_ENABLED && remaining <= RACE_MODE_LEAD_MS) {
            enterRaceQuiet(`متبقي ${Math.max(1, Math.ceil(remaining / 1000))}ث`);
          }
          if (isRaceQuiet()) return;
          if (remaining > 2000) {
            const sec = Math.ceil(remaining / 1000);
            if (sec <= 120) log(`   ⏳ متبقي ${sec}ث للضربة...`);
          }
        }
      });
      exitRaceQuiet();
    }
    pendingFireAtMs = null;
    isFirstRound = false;
    throwIfLiveReschedule();

    // Anchor restart + cycle timing to the exact fire moment
    const checkRoundStartMs = ntpNow();
    if (restartDelayMinutes > 0) {
      // Defer this log until after first request is queued (avoid delaying fire)
      setImmediate(() => {
        log(`⏱️ بداية التشييك (NTP): ${formatCairoHms(checkRoundStartMs, true)} → إعادة التشغيل المستهدفة بعد ${restartDelayMinutes} د: ${formatCairoHms(checkRoundStartMs + restartDelayMinutes * 60 * 1000, true)}`);
      });
    }
    
    while (!globalStop && !isLiveReschedulePending() && cycleCount < maxCycles) {
      cycleCount++;
      
      // Don't log before the wave when gaps are tight — logging itself costs ms
      const tightGaps = delayBetweenAccountsMs <= 20;
      
      // Absolute stagger from cycle start (avoids ~15ms setTimeout floor)
      const waveAnchorMs = cycleCount === 1 ? checkRoundStartMs : ntpNow();
      const cycleStartTime = waveAnchorMs;
      if (cycleCount > 1 && !tightGaps) {
        log(`\n🔄 Cycle ${cycleCount} started at ${formatCairoHms(cycleStartTime, true)} (NTP) - Sending requests to ${accountsData.length - completedAccounts.size} active accounts...`);
      }
      let staggerSlot = 0;

      for (let i = 0; i < accountsData.length && !globalStop && !isLiveReschedulePending(); i++) {
        const accountData = accountsData[i];
        const account = accountData.account;
        
        // Skip completed accounts (found appointment or rate limited)
        if (completedAccounts.has(account.email)) {
          continue;
        }
        
        // Skip rate limited
        const rateLimitCheck = isRateLimited(account.email);
        if (rateLimitCheck.limited) {
          continue;
        }

        const slot = staggerSlot++;
        await waitForStaggerSlot(waveAnchorMs, slot, delayBetweenAccountsMs);
        if (globalStop || isLiveReschedulePending()) break;
        
        // Check if token needs refresh (skip blocking refresh on the very first fire)
        if (!(cycleCount === 1 && slot === 0) && needsTokenRefreshAtCheckTime(account.email)) {
          log(`   🔄 Token refresh needed for ${account.email}...`);
          const refreshed = await refreshTokenIfNeeded(accountData, browser);
          if (!refreshed) {
            log(`   ✗ Token refresh failed - skipping ${account.email}`);
            completedAccounts.add(account.email);
            continue;
          }
        }
        
        // Increment request count
        accountRequestCounts.set(account.email, (accountRequestCounts.get(account.email) || 0) + 1);
        const reqCount = accountRequestCounts.get(account.email);
        
        // 🆕 Get the appropriate abort signal based on mode
        const accountAbortController = accountAbortControllers.get(account.email);
        const abortSignal = stopOnlyFoundAccount 
          ? accountAbortController.signal  // Per-account signal
          : globalAbortController.signal;  // Global signal (stops all)
        
        // 🆕 Check if this account's controller is already aborted (found appointment)
        if (abortSignal.aborted) {
          log(`   ⏭️ [${account.email}] Skipping - account already found appointment`);
          continue;
        }

        const isCriticalFirstFire = cycleCount === 1 && slot === 0;
        const deferLog = tightGaps;
        if (!deferLog) {
          log(`   [${account.email}] Request #${reqCount}${isFakeProbe ? ` ×${FAKE_PROBE_TARGETS.filter(t => !hasFakeProbeTargetFound(account.email, t.officeId, t.visaId)).length} targets` : ''}`);
        }
        
        // Fire request WITHOUT waiting for response
        const firedAtMs = ntpNow();
        const requestPromise = (async () => {
          try {
            if (isFakeProbe) {
              const pendingTargets = FAKE_PROBE_TARGETS.filter(
                t => !hasFakeProbeTargetFound(account.email, t.officeId, t.visaId)
              );
              if (pendingTargets.length === 0) {
                completedAccounts.add(account.email);
                return { found: false, skipped: true };
              }
              const settled = await Promise.all(pendingTargets.map(async (t) => {
                try {
                  const result = await checkAvailability(
                    t.officeId,
                    t.visaId,
                    1,
                    accountData.token,
                    accountData.agent,
                    DESTINATION,
                    TRIP_DATE,
                    abortSignal,
                    null,
                    account.email
                  );
                  return { t, result };
                } catch (error) {
                  if (error.name === 'AbortError') {
                    return { t, result: { found: false, cancelled: true } };
                  }
                  return { t, result: { found: false, error: error.message } };
                }
              }));
              const reqEndMs = Date.now();
              for (const { t, result } of settled) {
                await processResult(result, accountData, {
                  requestSentDate: new Date(firedAtMs),
                  responseReceivedDate: new Date(reqEndMs),
                  responseTimeMs: reqEndMs - firedAtMs
                }, t);
              }
              return settled.map(s => s.result);
            }

            const result = await checkAvailability(
              accountData.officeId || OFFICE_ID,
              accountData.visaId,
              1,
              accountData.token,
              accountData.agent,
              DESTINATION,
              TRIP_DATE,
              abortSignal,  // 🆕 Use the appropriate abort signal
              null,  // No force timeout callback
              account.email  // 🎭 Pass account email for unique spoofed IP
            );
            const reqEndMs = Date.now();
            
            // Process result when it comes back (async)
            await processResult(result, accountData, {
              requestSentDate: new Date(firedAtMs),
              responseReceivedDate: new Date(reqEndMs),
              responseTimeMs: reqEndMs - firedAtMs
            });
            return result;
          } catch (error) {
            if (error.name === 'AbortError') {
              return { found: false, cancelled: true };
            }
            return { found: false, error: error.message };
          }
        })();

        if (isCriticalFirstFire || deferLog) {
          setImmediate(() => {
            if (slot === 0) {
              log(`\n🔄 Cycle ${cycleCount} started at ${formatCairoHms(waveAnchorMs, true)} (NTP) - Sending requests to ${accountsData.length - completedAccounts.size} active accounts...`);
            }
            log(`   [${account.email}] Request #${reqCount} | sent ${formatCairoHms(firedAtMs, true)} (Δ${firedAtMs - waveAnchorMs}ms)`);
          });
        }
        
        activeRequests.push(requestPromise);
        
        // Clean up old completed requests to avoid memory issues
        if (activeRequests.length > 100) {
          await Promise.allSettled(activeRequests.slice(0, 50));
          activeRequests.splice(0, 50);
        }
      }
      
      // Check if all accounts are completed
      if (completedAccounts.size >= accountsData.length) {
        log(`\nAll accounts completed (found appointments or rate limited)!`);
        globalStop = true;
        break;
      }
      
      // Wait between cycles - from cycle START on NTP clock
      if (!globalStop && delayBetweenCyclesMs > 0) {
        const nextCycleAt = cycleStartTime + delayBetweenCyclesMs;
        const cycleElapsed = ntpNow() - cycleStartTime;
        const remainingWait = nextCycleAt - ntpNow();

        const logCycleWait = () => {
          if (remainingWait > 0) {
            log(`⏳ Cycle took ${cycleElapsed}ms - waiting ${remainingWait}ms for next cycle at ${formatCairoHms(nextCycleAt, true)} (NTP)`);
          } else {
            log(`⚡ Cycle took ${cycleElapsed}ms (longer than interval) - starting next cycle immediately`);
          }
        };
        if (tightGaps) setImmediate(logCycleWait);
        else logCycleWait();

        if (remainingWait > 0) {
          const nextAccounts = accountsData.filter((a) => !completedAccounts.has(a.account.email));
          await waitUntilFireWithPreRefresh(nextCycleAt, nextAccounts, browser, `cycle-${cycleCount + 1}`);
        }
      }
    }
    
    // Check if stopped due to max cycles
    if (SAM_MODE.maxCycles > 0 && cycleCount >= SAM_MODE.maxCycles) {
      log(`\n⏹️ Reached maximum cycles (${SAM_MODE.maxCycles}) - bot stopped`);
    }
    
    // Wait for remaining active requests (aligned with checks timeout — not a fixed 5s)
    if (isLiveReschedulePending()) {
      try { globalAbortController.abort(); } catch (_) {}
      for (const controller of accountAbortControllers.values()) {
        try { controller.abort(); } catch (_) {}
      }
      throwIfLiveReschedule();
    }
    if (activeRequests.length > 0) {
      const settleTimeoutMs = Math.max(CHECKS_TIMEOUT || REQUEST_TIMEOUT || 30000, 5000) + 2000;
      const settleSec = Math.ceil(settleTimeoutMs / 1000);
      log(`\n⏳ Waiting for ${activeRequests.length} remaining requests (max ${settleSec}s)...`);
      await Promise.race([
        Promise.allSettled(activeRequests),
        new Promise(resolve => setTimeout(resolve, settleTimeoutMs))
      ]);
    }

    // Close the round: stop late Status lines from mixing into Completed / next-round prep
    roundClosed = true;
    suppressLateHttpLogs = true;
    try { globalAbortController.abort(); } catch (_) {}
    for (const controller of accountAbortControllers.values()) {
      try { controller.abort(); } catch (_) {}
    }
    await sleep(50);
    
    log("\n" + "=".repeat(60));
    log("✅ Sequential Aggressive Plus Plus Mode Completed");
    log("=".repeat(60));
    
    // Show statistics
    if (appointmentsFound.length > 0) {
      log(`\nAppointments found: ${appointmentsFound.length}`);
      appointmentsFound.forEach(email => log(`   ✓ ${email}`));
    } else {
      log(`\nNo appointments found`);
    }
    
    // Request Statistics kept internal (not printed to log)
    log(`Total cycles: ${cycleCount}`);
    log("=".repeat(60) + "\n");
    
    // AUTO-RESTART: schedule next fire at (check start + N min). Wait happens AFTER next prep.
    // Accounts that already found an appointment stay skipped until a new bot/check session.
    if (restartDelayMinutes > 0 && SAM_MODE.maxCycles > 0 && cycleCount >= SAM_MODE.maxCycles && completedAccounts.size < accountsData.length) {
      shouldRestart = true;
      pendingFireAtMs = checkRoundStartMs + restartDelayMinutes * 60 * 1000;
      const waitMs = pendingFireAtMs - ntpNow();
      const foundCount = isFakeProbe
        ? accountsData.filter(a => hasFakeProbeAccountFullyFound(a.account.email)).length
        : accountsData.filter(a => hasAccountFoundThisSession(a.account.email)).length;
      const remainingAccounts = accountsData.length - foundCount;
      log(`\n🔄 إعادة التشغيل بعد ${restartDelayMinutes} د من بداية التشييك (NTP)`);
      log(`   🎯 الموعد المستهدف: ${formatCairoHms(pendingFireAtMs, true)}`);
      log(`   ⏭️ الحسابات اللي لقت معاد هتتتخطى | المتبقي للتشييك: ${remainingAccounts}/${accountsData.length}`);
      if (waitMs > 0) {
        log(`   ⏳ المتبقي الآن: ${Math.ceil(waitMs / 1000)} ثانية (التجهيز ثم الانتظار الدقيق)`);
      } else {
        log(`\n⚡ الدورات أخدت أطول من ${restartDelayMinutes} د — الدورة الجاية فور التجهيز`);
      }
      log(`\n🔄 تجهيز الجولة التالية...\n`);
      // Sync found accounts from file in case any were restored via UI
      if (isFakeProbe) syncFakeProbeFoundFromFile();
      else syncAccountsFoundFromFile();
    } else {
      shouldRestart = false;
    }
  } while (shouldRestart);
  
  suppressLateHttpLogs = false;

  // Restore main schedule if fake probe temporarily overrode it
  if (isFakeProbe) {
    CONFIG.enableScheduledCheck = prevSchedule.enable;
    CONFIG.scheduledCheckTime = prevSchedule.time;
  }
  
  // 🧹 Clean up keep-alive timer (silent)
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
  }
}

// ----- Main Bot -----------------------------------------------------------
// 🆕 Parse --single-account argument for per-account terminal mode
const SINGLE_ACCOUNT_ARG = process.argv.find(arg => arg.startsWith('--single-account='));
const SINGLE_ACCOUNT_INDEX = SINGLE_ACCOUNT_ARG ? parseInt(SINGLE_ACCOUNT_ARG.split('=')[1]) : -1;
const IS_SINGLE_ACCOUNT_MODE = SINGLE_ACCOUNT_INDEX >= 0;
// Group window from manager: filter to one office + visa type (set by run_visa_*.cmd)
const VISA_TYPE_FILTER = String(process.env.BOT_VISA_TYPE || '').trim();
const OFFICE_FILTER = String(process.env.BOT_OFFICE || '').trim();
const IS_VISA_TYPE_MODE = VISA_TYPE_FILTER.length > 0;

(async () => {
  try {
    fs.writeFileSync(BOT_LOGS_FILE, '', 'utf8');
  } catch (e) {}
  initSessionLogFile();

  // Request timing follows Windows system clock (taskbar)
  try {
    await syncNtpClock();
    startNtpAutoSync(2 * 60 * 1000);
    log(`🖥️ Windows clock mode | الإطلاق على ساعة الجهاز | الآن ${formatCairoHms(ntpNow(), true)}`);
  } catch (e) {
    log(`⚠️ Clock init failed (${e.message}) — using Date.now()`);
  }
  
  loadRateLimitedAccounts();
  
  // 🆕 Single-account / group window title (+ active check mode)
  if (IS_SINGLE_ACCOUNT_MODE) {
    const allAccounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    const targetAccount = allAccounts[SINGLE_ACCOUNT_INDEX];
    if (targetAccount) {
      const email = targetAccount.email || `Account-${SINGLE_ACCOUNT_INDEX}`;
      setBotWindowTitle(email);
      log(`🚀 Starting SINGLE ACCOUNT Mode for: ${email}`);
    }
  } else if (IS_VISA_TYPE_MODE) {
    const groupLabel = OFFICE_FILTER
      ? `${OFFICE_FILTER} | ${VISA_TYPE_FILTER}`
      : VISA_TYPE_FILTER;
    setBotWindowTitle(groupLabel);
    log(`🚀 Starting GROUP Mode: ${groupLabel}`);
  } else {
    setBotWindowTitle('Multi-Account');
    log("🚀 Starting Multi-Account Parallel Bot (FIXED VERSION)");
  }
  log(`   🪟 Window title mode: ${getActiveCheckModeLabel()}`);
  
  log("=" .repeat(60));
  log("");
  log("✅ FIXES:");
  log("   • Uses correct API endpoints (months -> days -> slots)");
  log("   • Properly checks actual available appointments");
  log("   • Includes tripDate parameter");
  log("");
  log("💡 Strategy:");
  if (USE_PROXY && USE_PROXY_FOR_LOGIN) {
    log("   • Phase 1: Assign unique proxy IP to each account");
    log("   • Phase 2: Login all accounts (WITH assigned proxy IP)");
    log("   • Phase 3: Run checks using same IP");
  } else {
    log("   • Phase 1: Login all accounts (WITHOUT proxy)");
    log("   • Phase 2: Assign unique proxy IP to each account");
    log("   • Phase 3: Run parallel checks on all accounts (WITH proxy)");
  }
  log("");
  log("⚠️ Configuration:");
  log(`   • Office / Visa: PER-ACCOUNT (from each account in accounts.json)`);
  if (IS_VISA_TYPE_MODE) {
    log(`   • This window group: ${VISA_TYPE_FILTER}`);
  } else {
    log(`   • Fallback only if account has no visa set: ${OFFICE_NAME} | ${VISA_NAME}`);
  }
  log(`   • Trip Date: ${TRIP_DATE}`);
  log(`   • Destination: ${DESTINATION || 'None'}`);
  log(`   • Requests per minute: ${CONFIG.requestsPerMinute}`);
  log(`   • Max accounts: ${MAX_ACCOUNTS}`);
  log(`   • Proxy: ${USE_PROXY ? 'Enabled' : 'Disabled'}`);
  if (USE_PROXY) {
    log(`   • Proxy Mode: ${PROXY_MODE}`);
    if (PROXY_MODE === 'list') {
      log(`   • IP List: ${IP_LIST.length} IP(s) available`);
    }
    log(`   • Require IP Prefix (${REQUIRED_IP_PREFIX}*): ${REQUIRE_IP_PREFIX ? 'Yes' : 'No'}`);
  }
  log(`   • Rate limit cooldown: ${RATE_LIMIT_COOLDOWN} minutes`);
  if (rateLimitedAccounts.size > 0) {
    log(`   • Rate limited accounts: ${rateLimitedAccounts.size}`);
  }
  if (IS_SINGLE_ACCOUNT_MODE) {
    log(`   • 🆕 Mode: SINGLE ACCOUNT (index: ${SINGLE_ACCOUNT_INDEX})`);
  }
  if (IS_VISA_TYPE_MODE) {
    log(`   • 🆕 Mode: GROUP WINDOW → ${VISA_TYPE_FILTER}`);
  }
  log("");
  log("=" .repeat(60));
  log("");
  
// Check which mode is enabled for account loading
  const SEQ_AGG_MODE = CONFIG.sequentialAggressiveMode || {};
  const SEQ_AGG_PLUS_MODE = CONFIG.sequentialAggressivePlusMode || {};
  const SEQ_AGG_FAKE_MODE = CONFIG.sequentialAggressiveFakeMode || {};
  const isSeqAggressiveMode = SEQ_AGG_MODE.enabled === true;
  const isSeqAggressivePlusMode = SEQ_AGG_PLUS_MODE.enabled === true;
  const isSeqAggressiveFakeMode = SEQ_AGG_FAKE_MODE.enabled === true;
  const isRoundRobinMode = CONFIG.enableRoundRobin || (CONFIG.parallelRoundRobinMode && CONFIG.parallelRoundRobinMode.enabled);
  let accounts = isSeqAggressiveFakeMode
    ? (() => {
        try {
          if (!fs.existsSync(FAKE_ACCOUNTS_FILE)) return [];
          return JSON.parse(fs.readFileSync(FAKE_ACCOUNTS_FILE, 'utf8'));
        } catch (_) { return []; }
      })()
    : loadAccounts(isRoundRobinMode || isSeqAggressiveMode || isSeqAggressivePlusMode || IS_SINGLE_ACCOUNT_MODE);
  if (accounts.length === 0) {
    log(isSeqAggressiveFakeMode ? "❌ No fake/test accounts found in accounts-fake.json!" : "❌ No accounts found!");
    await safeExit(1);
  }

  // Sync in-memory found accounts set with file (catches restored accounts)
  if (isSeqAggressiveFakeMode) {
    FAKE_PROBE_ACTIVE = true;
    FAKE_PROBE_TARGETS = buildFakeProbeTargets(SEQ_AGG_FAKE_MODE);
    syncFakeProbeFoundFromFile();
  } else {
    syncAccountsFoundFromFile();
  }

  log(`✅ Found ${accounts.length} account(s)`);
  
  // Determine which accounts to use based on mode
  let accountsToUse;
  
  // 🆕 Single-account mode: use only the specified account
  if (IS_SINGLE_ACCOUNT_MODE) {
    const allAccounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    if (SINGLE_ACCOUNT_INDEX >= allAccounts.length) {
      log(`❌ Account index ${SINGLE_ACCOUNT_INDEX} not found! (total: ${allAccounts.length})`);
      await safeExit(1);
    }
    const targetAccount = allAccounts[SINGLE_ACCOUNT_INDEX];
    accountsToUse = [targetAccount];
    log(`🎯 Single Account Mode: ${targetAccount.email}`);
    if (targetAccount.scheduledStartTime) {
      log(`   ⏰ Scheduled start: ${targetAccount.scheduledStartTime}`);
    }
  }
  // Fake probe — uses enabled accounts from accounts-fake.json
  else if (isSeqAggressiveFakeMode) {
    accountsToUse = accounts.filter(acc => acc.enabled === true);
    if (accountsToUse.length === 0) {
      log("❌ No fake accounts enabled!");
      log("⚠️ فعّل حسابات من تاب التيست/الفيك في المدير");
      await safeExit(1);
    }
    if (FAKE_PROBE_TARGETS.length === 0) {
      log("❌ No fake probe targets (offices × visas) configured!");
      await safeExit(1);
    }
    log(`🧪 Fake Probe Mode: ${accountsToUse.length} account(s) | targets: ${FAKE_PROBE_TARGETS.map(t => `${t.officeName}/${t.visaType}`).join(', ')}`);
  }
  // Sequential Aggressive Plus - uses accounts with enabled = true
  else if (isSeqAggressivePlusMode) {
    accountsToUse = accounts.filter(acc => acc.enabled === true);
    
    if (accountsToUse.length === 0) {
      log("❌ No accounts enabled for Sequential Aggressive Plus Mode!");
      log("⚠️ Please enable at least one account using the 'تفعيل' button");
      log("🔗 http://localhost:3004");
      await safeExit(1);
    }
    
    log(`⚡🔥🚀 Sequential Aggressive Plus Mode: ${accountsToUse.length} account(s) enabled`);
  }
  // Sequential Aggressive Mode (classic/clean) - uses accounts with enabled = true
  else if (isSeqAggressiveMode) {
    accountsToUse = accounts.filter(acc => acc.enabled === true);
    
    if (accountsToUse.length === 0) {
      log("❌ No accounts enabled for Sequential Aggressive Mode!");
      log("⚠️ Please enable at least one account using the 'تفعيل' button");
      log("🔗 http://localhost:3004");
      await safeExit(1);
    }
    
    log(`⚡🔥 Sequential Aggressive Mode: ${accountsToUse.length} account(s) enabled`);
  }
  // Round-Robin modes
  else if (isRoundRobinMode) {
    if (CONFIG.parallelRoundRobinMode?.enabled) {
      // Parallel RR: same as Sequential Aggressive — use "تفعيل" accounts
      accountsToUse = accounts.filter(acc => acc.enabled === true);
      
      if (accountsToUse.length === 0) {
        log("❌ No accounts enabled for Parallel Round-Robin!");
        log("⚠️ Please enable at least one account using the 'تفعيل' button");
        log("🔗 http://localhost:3004");
        await safeExit(1);
      }
      
      log(`🔄 Parallel Round-Robin Mode: ${accountsToUse.length} account(s) enabled`);
    } else {
      // Classic Round-Robin: uses accounts with roundRobinEnabled = true (from "RR" button)
      accountsToUse = accounts.filter(acc => acc.roundRobinEnabled === true);
      
      if (accountsToUse.length === 0) {
        log("❌ No accounts enabled for Round-Robin mode!");
        log("⚠️ Please enable at least one account in the web interface (RR button)");
        log("🔗 http://localhost:3004");
        await safeExit(1);
      }
      
      log(`🔄 Round-Robin Mode: ${accountsToUse.length} account(s) enabled`);
    }
  } else {
    accountsToUse = accounts.slice(0, MAX_ACCOUNTS);
    log(`🔹 Using ${accountsToUse.length} account(s)`);
  }

  // Group window: keep only accounts whose office + primary visa match this window
  if (IS_VISA_TYPE_MODE && !IS_SINGLE_ACCOUNT_MODE && !isSeqAggressiveFakeMode) {
    const before = accountsToUse.length;
    accountsToUse = accountsToUse.filter(acc => {
      const types = Array.isArray(acc.enabledVisaTypes) ? acc.enabledVisaTypes : [];
      const visaOk = String(types[0] || '').trim() === VISA_TYPE_FILTER;
      if (!visaOk) return false;
      if (!OFFICE_FILTER) return true;
      const office = (acc.office === 'Alexandria') ? 'Alexandria' : 'Cairo';
      return office === OFFICE_FILTER;
    });
    const groupLabel = OFFICE_FILTER
      ? `${OFFICE_FILTER} | ${VISA_TYPE_FILTER}`
      : VISA_TYPE_FILTER;
    log(`🎫 Group filter "${groupLabel}": ${accountsToUse.length}/${before} account(s)`);
    if (accountsToUse.length === 0) {
      log(`❌ No accounts for group "${groupLabel}"`);
      await safeExit(1);
    }
  }

  if (isSeqAggressiveFakeMode) {
    syncFakeProbeFoundFromFile();
    const lockedFake = accountsToUse.filter(acc => hasFakeProbeAccountFullyFound(acc.email));
    if (lockedFake.length > 0) {
      log(`\n🔒 ${lockedFake.length} حساب فيك خلّص كل الأهداف — هيتخطى:`);
      for (const acc of lockedFake) log(`   ⏭️ ${acc.email}`);
      accountsToUse = accountsToUse.filter(acc => !hasFakeProbeAccountFullyFound(acc.email));
    }
  } else {
    syncAccountsFoundFromFile();
    const lockedAccounts = accountsToUse.filter(acc => acc.foundAt || hasAccountFoundThisSession(acc.email));
    if (lockedAccounts.length > 0) {
      log(`\n🔒 ${lockedAccounts.length} حساب لقط معاد — مش هيتشيك إلا بعد استرجاع:`);
      for (const acc of lockedAccounts) {
        log(`   ⏭️ ${acc.email}`);
      }
      accountsToUse = accountsToUse.filter(acc => !acc.foundAt && !hasAccountFoundThisSession(acc.email));
    }
  }
  if (accountsToUse.length === 0) {
    log(`❌ كل الحسابات في المجموعة دي لقطت معاد. اعمل استرجاع من الواجهة لو عايز تشييك جديد.`);
    await safeExit(0);
  }
  log("");
  if (isSeqAggressiveFakeMode) {
    log("📋 FAKE PROBE TARGETS (من إعدادات التيست — مش من حسابات الفيك):");
    for (const t of FAKE_PROBE_TARGETS) {
      log(`   🎯 ${t.officeName} (${t.officeId}) | ${t.visaType} (${t.visaId})`);
    }
    log(`📋 Fake accounts (${accountsToUse.length}):`);
    for (const acc of accountsToUse) {
      log(`   ✅ ${acc.email}`);
    }
  } else {
  log("📋 ACCOUNT OFFICE + VISA (from accounts.json — this is what will be used):");
  for (const acc of accountsToUse) {
    const t = resolveAccountTargets(acc);
    const rawTypes = Array.isArray(acc.enabledVisaTypes) ? acc.enabledVisaTypes : [];
    if (rawTypes.length === 0) {
      log(`   ⚠️ ${acc.email} → Office: ${t.officeName} | Visa: ${t.visaType} (${t.visaId}) [FALLBACK — no enabledVisaTypes saved]`);
    } else {
      log(`   ✅ ${acc.email} → Office: ${t.officeName} | Visa: ${t.visaType} (${t.visaId})`);
    }
  }
  }
  log("");
  
  // Colab/server override: BOT_HEADLESS=1 (set by the Colab cell) or Linux with no
  // display. System Chrome (channel) + headed mode only exist on a Windows desktop —
  // on a server Playwright must use its bundled chromium headless instead.
  const BOT_HEADLESS = ['1', 'true', 'yes'].includes(String(process.env.BOT_HEADLESS || '').trim().toLowerCase())
    || (process.platform === 'linux' && !process.env.DISPLAY);
  const launchOptions = {
    headless: BOT_HEADLESS ? true : false,
    ...(BOT_HEADLESS ? {} : { channel: "chrome" }),
    args: [
      "--disable-blink-features=AutomationControlled",
      "--ignore-certificate-errors",
      "--ignore-certificate-errors-spki-list",
      "--disable-webrtc",
      "--enforce-webrtc-ip-permission-check",
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-web-security",
      "--disable-features=BlockInsecurePrivateNetworkRequests",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu"
    ]
  };
  
  // Optional: wait until (checkTime − 2 min) before login/prep — runs each live cycle
  // (see live reschedule loop below)

  // =========================
  // SELECTED CHECK MODE (wrapped as a function so it can be triggered)
  // =========================
  const runSelectedCheckMode = async (accountsToUse, browser) => {

  // Priority -1: Fake Probe (isolated timing discovery)
  if (isSeqAggressiveFakeMode) {
    log("\n" + "=".repeat(60));
    log("🧪⚡ FAKE PROBE MODE ENABLED (عدواني متتابع متقدم — فيك)");
    log("=".repeat(60) + "\n");
    log("📋 الاستراتيجية:");
    log(`   • حسابات من accounts-fake.json فقط`);
    log(`   • لكل اكاونت: كل التاشيرات × المراكز المختارة في نفس اللحظة`);
    log(`   • فاصل ${SEQ_AGG_FAKE_MODE.delayBetweenAccountsMs || 100}ms بين الاكاونتات`);
    log(`   • أهداف: ${FAKE_PROBE_TARGETS.map(t => `${t.officeName}/${t.visaType}`).join(' | ')}`);
    log("");
  FAKE_PROBE_ACTIVE = true;
  await runSequentialAggressivePlusMode(accountsToUse, browser);
  FAKE_PROBE_ACTIVE = false;
  throwIfLiveReschedule();
  return;
  }

  // Priority 0a: Clock-Burst (synchronized 10s window on 5-min marks)
  if (ENABLE_CLOCK_BURST) {
    log("\n" + "=".repeat(60));
    log("💥⏰ CLOCK-BURST MODE ENABLED");
    log("=".repeat(60) + "\n");
    log("📋 الاستراتيجية:");
    log(`   • نافذة ${CLOCK_BURST_WINDOW_SEC} ثانية قبل كل علامة دقيقة % ${CLOCK_BURST_EVERY_MIN} == 0`);
    log(`   • ${CLOCK_BURST_PER_ACCOUNT} ريكوست لكل اكاونت في الدورة, موزعة بالتساوي على كل ميلي ثانية`);
    log(`   • حد آمن 2/دورة للأبد — 4/دورة أسرع لكن يحرق الباكت بعد ~3 ساعات`);
    log("");
    await runClockBurstMode(accountsToUse, browser);
    throwIfLiveReschedule();
    await closeBotBrowser(browser);
    return;

  // Priority 0b: Trickle (continuous rotation, fixed safe pace, no clock)
  } else if (ENABLE_TRICKLE) {
    log("\n" + "=".repeat(60));
    log("💧 TRICKLE MODE ENABLED");
    log("=".repeat(60) + "\n");
    log("📋 الاستراتيجية:");
    log(`   • تناوب مستمر بدون نوافذ ساعة`);
    log(`   • 1 ريكوست لكل اكاونت كل ${TRICKLE_PER_ACCOUNT_SEC} ثانية (0.4/دقيقة — تحت معدل التعافي المقاس 0.45)`);
    log("");
    await runTrickleMode(accountsToUse, browser);
    throwIfLiveReschedule();
    await closeBotBrowser(browser);
    return;
  }

  // Priority 0: Sequential Aggressive Plus (NTP / maxCycles / restart)
  if (isSeqAggressivePlusMode) {
    log("\n" + "=".repeat(60));
    log("⚡🔥🚀 SEQUENTIAL AGGRESSIVE PLUS MODE ENABLED");
    log("=".repeat(60) + "\n");
    log("📋 الاستراتيجية:");
    log(`   • ريكوست واحد لكل اكاونت (نسخة متقدمة)`);
    log(`   • فاصل ${SEQ_AGG_PLUS_MODE.delayBetweenAccountsMs || 200} ميلي ثانية بين كل اكاونت`);
    log(`   • توقيت NTP + أقصى دورات + إعادة تشغيل اختيارية`);
    const stopOnlyPlus = SEQ_AGG_PLUS_MODE.stopOnlyFoundAccount !== false;
    if (stopOnlyPlus) {
      log(`   • لما اكاونت يلاقي موعد → يوقف هو بس وباقي الاكاونتات تكمل`);
    } else {
      log(`   • لما اكاونت يلاقي موعد → كل الاكاونتات توقف`);
    }
    log(`   • الحساب اللي يلقى معاد مش هيتشيك تاني (حتى بعد إعادة التشغيل) لحد تشييك جديد`);
    log("");
    await runSequentialAggressivePlusMode(accountsToUse, browser);
    throwIfLiveReschedule();
    await closeBotBrowser(browser);

  // Priority 0b: Sequential Aggressive classic (clean tls style)
  } else if (isSeqAggressiveMode) {
    log("\n" + "=".repeat(60));
    log("⚡🔥 SEQUENTIAL AGGRESSIVE MODE ENABLED");
    log("=".repeat(60) + "\n");
    log("📋 الاستراتيجية:");
    log(`   • ريكوست واحد لكل اكاونت`);
    log(`   • فاصل ${SEQ_AGG_MODE.delayBetweenAccountsMs || 200} ميلي ثانية بين كل اكاونت`);
    log(`   • بيرفع في الوقت المحدد بغض النظر عن رد الريكوست السابق`);
    const stopOnlyMode = SEQ_AGG_MODE.stopOnlyFoundAccount !== false;
    if (stopOnlyMode) {
      log(`   • لما اكاونت يلاقي موعد → يوقف هو بس وباقي الاكاونتات تكمل`);
    } else {
      log(`   • لما اكاونت يلاقي موعد → كل الاكاونتات توقف`);
    }
    log("");
    
    await runSequentialAggressiveMode(accountsToUse, browser);
    throwIfLiveReschedule();
    await closeBotBrowser(browser);
    
  // Priority 1: Parallel Round-Robin Mode (if enabled)
  } else if (CONFIG.parallelRoundRobinMode?.enabled) {
    log("\n" + "=".repeat(60));
    log("🔄🚀 PARALLEL ROUND-ROBIN MODE ENABLED");
    log("=".repeat(60) + "\n");
    
    await runParallelRoundRobinMode(accountsToUse, browser);
    await closeBotBrowser(browser);
    
  } else if (CONFIG.enableRoundRobin) {
    // Priority 2: Original Round-Robin mode
    // In Round-Robin mode, skip bulk login and IP assignment
    // Each account will be prepared individually just before its turn
    log("\n" + "=".repeat(60));
    log("🔄 ROUND-ROBIN MODE ENABLED (ORIGINAL)");
    log("=".repeat(60) + "\n");
    log("📋 الاستراتيجية:");
    log("   • كل حساب يعمل تشيك رأس كل 5 دقائق (XX:X0, XX:X5)");
    log("   • التحضير يتم قبل التشيك مباشرة (Login + IP)");
    log("   • تخطي الحسابات المحظورة");
    log("   • بعد الانتهاء، ينتقل للحساب التالي");
    log("");
    
    await runRoundRobinMode(accountsToUse, browser);
    await closeBotBrowser(browser);
    
  } else {
    // Priority 3: Parallel mode (default)
    // PARALLEL MODE: Login all accounts first, then run checks in parallel
    log("\n" + "=".repeat(60));
    log(USE_PROXY && USE_PROXY_FOR_LOGIN
      ? "🔐 PHASE 1: LOGIN ALL ACCOUNTS (WITH PROXY)"
      : "🔐 PHASE 1: LOGIN ALL ACCOUNTS (WITHOUT PROXY)");
    log("=".repeat(60) + "\n");
    
    
    let accountsData = [];
    
    if (USE_PROXY && USE_PROXY_FOR_LOGIN) {
      const results = await assignIPsBatched(accountsToUse, (_account, i) =>
        IS_SINGLE_ACCOUNT_MODE ? SINGLE_ACCOUNT_INDEX : i
      );
      
      const prepared = [];
      for (const result of results) {
        const { account, index, ipData, rateLimited, success, error } = result;
        if (rateLimited) {
          const rateLimitCheck = isRateLimited(account.email);
          const remainingMin = Math.ceil(rateLimitCheck.remainingMs / 60000);
          log(`   ${account.email} - Rate limited (${remainingMin}m)`);
          continue;
        }
        if (!success) {
          log(`   ${account.email} - IP assignment failed: ${error}`);
          continue;
        }
        prepared.push({
          account,
          index,
          agent: ipData.agent,
          sessionId: ipData.sessionId,
          ip: ipData.ip
        });
      }
      
      accountsData = await loginAccountsSimultaneously(prepared, { browser, alreadyPrepared: true });
    } else {
      const prepared = accountsToUse.map((account, i) => ({
        account,
        index: IS_SINGLE_ACCOUNT_MODE ? SINGLE_ACCOUNT_INDEX : i,
        agent: null,
        sessionId: null,
        ip: null
      })).filter(({ account }) => !isRateLimited(account.email).limited);
      
      accountsData = await loginAccountsSimultaneously(prepared, { browser, alreadyPrepared: true });
    }
    
    if (accountsData.length === 0) {
      log("\n❌ No accounts logged in successfully!");
      await safeExit(1);
    }
    
    log(`\n✅ Successfully logged in ${accountsData.length} account(s)`);
    
    // 🍪 Acquire WAF session cookies early (before the scheduled wait — never at strike time)
    await acquireWafCookiesBulk(accountsData, 10);
    
    // =========================
    // PHASE 2: ASSIGN UNIQUE IPs (ONLY IF PROXY ENABLED and NOT already assigned)
    // =========================
    if (USE_PROXY && !USE_PROXY_FOR_LOGIN) {
      log("\n" + "=".repeat(60));
      log("🌐 PHASE 2: ASSIGN UNIQUE PROXY IPs");
      log("=".repeat(60) + "\n");
      
      for (const accountData of accountsData) {
        try {
          const ipData = await assignUniqueIP(accountData.account.email, accountData.accountIndex);
          accountData.sessionId = ipData.sessionId;
          accountData.agent = ipData.agent;
          accountData.ip = ipData.ip;
        } catch (e) {
          log(`❌ Failed to assign IP to ${accountData.account.email}: ${e.message}`);
          const index = accountsData.indexOf(accountData);
          accountsData.splice(index, 1);
        }
      }
      
      if (accountsData.length === 0) {
        log("\n❌ No accounts have proxy IPs!");
        await safeExit(1);
      }
      
      log(`\n✅ Assigned unique proxy IPs to ${accountsData.length} account(s)`);
      
      // 🚀 PRE-WARM PROXY CONNECTIONS for faster first requests!
      log(`\n🚀 Pre-warming proxy connections...`);
      const warmupPromises = accountsData.map(async (accountData) => {
        if (!accountData.agent) return false;
        
        try {
          // Make a quick HEAD request to warm up the connection
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 10000);
          
          const warmupReq = await impersonatedFetch('https://egyapi.almaviva-visa.it/', {
            method: 'HEAD',
            agent: accountData.agent,
            signal: controller.signal,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Connection': 'keep-alive'
            }
          }).catch(() => null);
          
          clearTimeout(timeoutId);
          
          if (warmupReq) {
            log(`   ✅ Pre-warmed connection for ${accountData.account.email}`);
            return true;
          }
          return false;
        } catch (e) {
          log(`   ⚠️ Failed to pre-warm ${accountData.account.email}: ${e.message}`);
          return false;
        }
      });
      
      const warmupResults = await Promise.all(warmupPromises);
      const successCount = warmupResults.filter(r => r).length;
      log(`✅ Pre-warmed ${successCount}/${accountsData.length} proxy connections - ready for fast requests!\n`);
      
    } else if (!USE_PROXY_FOR_LOGIN) {
      log("\n" + "=".repeat(60));
      log("⚠️ PHASE 2: SKIPPED (Proxy disabled)");
      log("=".repeat(60));
      log("\nℹ️ All accounts will use your real IP address");
      log("⚠️ Warning: Without proxy, rate limiting may occur faster\n");
      
      // Set null values for proxy-related fields
      for (const accountData of accountsData) {
        accountData.sessionId = null;
        accountData.agent = null;
        accountData.ip = 'no-proxy';
      }
    } else {
      log("\n" + "=".repeat(60));
      log("✅ PHASE 2: IPs already assigned during login");
      log("=".repeat(60) + "\n");
    }
    
    const successfulAccounts = accountsData;
    
    // =========================
    // PER-ACCOUNT OFFICE + VISA
    // =========================
    log("\n" + "=".repeat(60));
    log("📋 RESOLVING PER-ACCOUNT OFFICE + VISA");
    log("=".repeat(60) + "\n");
    
    for (const accountData of successfulAccounts) {
      enrichAccountData(accountData);
      log(`✅ [${accountData.account.email}] Office: ${accountData.officeName} (${accountData.officeId}) | Visa: ${accountData.visaType} (${accountData.visaId})`);
    }
  
    // =========================
    // SCHEDULED STRIKE TARGET (wait after workers are armed — "لبس قبل المنبّه")
    // =========================
    let scheduledTarget = null;
    if (CONFIG.enableScheduledCheck && CONFIG.scheduledCheckTime && !ENABLE_PER_ACCOUNT_START_TIME) {
      log("\n" + "=".repeat(60));
      log("⏰ SCHEDULED TIME ENABLED");
      log("=".repeat(60) + "\n");
      scheduledTarget = getScheduledCheckTarget('parallel');
    }
    
    // =========================
    // PHASE 3: PARALLEL CHECKING
    // =========================
    log("\n" + "=".repeat(60));
    log("🔄 PHASE 3: PARALLEL CHECKING");
    log("=".repeat(60) + "\n");

    // Sequential Mode (general): optional repeat cycles — skip accounts that already found
    const seq2Cfg = CONFIG.sequentialMode2 || {};
    const seq2RepeatEnabled = SEQUENTIAL_MODE_GENERAL.enabled === true && seq2Cfg.repeatCycles === true;
    const repeatIntervalMinutes = Math.max(1, parseInt(seq2Cfg.repeatIntervalMinutes, 10) || 5);
    const maxRepeatCycles = (parseInt(seq2Cfg.maxCycles, 10) || 0) > 0
      ? parseInt(seq2Cfg.maxCycles, 10)
      : Number.POSITIVE_INFINITY;

    let cycleNum = 0;
    // 🧠 Intelligent rotation: cap each account at R requests (below the observed
    // ~55-req death count), then rotate to fresh standby accounts so per-account
    // buckets never fill and coverage stretches across time. Only engages when
    // standby accounts exist — otherwise workers run uncapped, exactly as before.
    const smartRotCfg = isSmartPacingEnabled(null) ? (getSmartPacingConfig().rotation || {}) : null;
    const rotationOn = !!smartRotCfg && smartRotCfg.enabled !== false;
    const smartMaxReqPerAccount = rotationOn
      ? Math.max(10, parseInt(smartRotCfg.maxRequestsPerAccount, 10) || 45)
      : 0;
    const usedInRotation = new Set();
    let waveNum = 0;
    const repeatIntervalMs = repeatIntervalMinutes * 60 * 1000;
    while (true) {
      cycleNum++;

      // New cycle: reset stop-after-N counters, keep found-session skip list
      if (cycleNum > 1) {
        perAccountRequestCount.clear();
        perAccountStopFlags.clear();
      }

      const accountsForCycle = successfulAccounts.filter(
        (a) => !hasAccountFoundThisSession(a.account.email) &&
          !(rotationOn && usedInRotation.has(emailKey(a.account.email)))
      );

      if (accountsForCycle.length === 0) {
        log(`\n⏭️ مفيش حسابات متبقية للتشيك (اللي لقطت معاد هتتجاهل)`);
        break;
      }

      // 🧠 Rotation wave cap: only cap this wave if fresh standby accounts exist
      // beyond it — otherwise run uncapped (continuous hitting, unchanged behavior).
      const standbyBeyondWave = rotationOn
        ? successfulAccounts.filter(
            (a) => !hasAccountFoundThisSession(a.account.email) &&
              !usedInRotation.has(emailKey(a.account.email)) &&
              !accountsForCycle.includes(a)
          ).length
        : 0;
      const waveCap = rotationOn && standbyBeyondWave > 0 && smartMaxReqPerAccount > 0
        ? smartMaxReqPerAccount
        : null;
      if (rotationOn && waveCap) {
        log(`\n🔄 Rotation wave ${waveNum + 1}: ${accountsForCycle.length} active (cap ~${waveCap} req each) + ${standbyBeyondWave} standby`);
      }

      // Interval is measured from cycle START (not from cycle end)
      const cycleStartMs = ntpNow();

      if (seq2RepeatEnabled) {
        log(`🚀 Cycle ${cycleNum} | checking ${accountsForCycle.length} account(s)` +
          (accountsFoundThisSession.size ? ` | skipped found: ${accountsFoundThisSession.size}` : '') +
          `\n`);
      } else if (ENABLE_SEQUENTIAL_PARALLEL_9AM) {
        log(`🚀 التتابعي المتوازي 9ص: حساب بعد حساب (${accountsForCycle.length}) — بعد اللقط ينتقل للتالي\n`);
      } else if (scheduledTarget && cycleNum === 1) {
        log(`🚀 تجهيز ${accountsForCycle.length} checker قبل الضربة — الإرسال عند ${formatCairoHms(scheduledTarget.targetEpoch, true)}\n`);
      } else {
        log(`🚀 Starting parallel checks on ${accountsForCycle.length} account(s)...\n`);
      }

      // Use the main browser for token refresh (already open from login phase)
      if (ENABLE_SEQUENTIAL_PARALLEL_9AM) {
        // One account at a time — dress before alarm, then fire first account immediately
        if (scheduledTarget && cycleNum === 1) {
          log(`🚀 تجهيز قبل الضربة — أول حساب عند ${formatCairoHms(scheduledTarget.targetEpoch, true)}\n`);
          await runScheduledStrikeGate(
            'parallel-seq9',
            accountsForCycle,
            browser,
            { precomputed: scheduledTarget }
          );
        }
        for (let i = 0; i < accountsForCycle.length; i++) {
          const accountData = accountsForCycle[i];
          const email = accountData.account.email;

          if (ENABLE_STOP_AT_TIME && shouldStopSendingRequests(null, 0)) {
            log(`\n🛑 Stop-at-time reached — إيقاف قبل ما نبدأ ${email}`);
            break;
          }

          if (!(scheduledTarget && cycleNum === 1 && i === 0)) {
            log(`\n➡️ [${i + 1}/${accountsForCycle.length}] بدء تشيك: ${email}`);
          }
          try {
            await accountCheckerWorker(
              accountData,
              null,
              browser,
              null,
              null,
              scheduledTarget && cycleNum === 1 && i === 0
                ? { silentFirstFire: true }
                : null
            );
          } catch (err) {
            if (!SEQUENTIAL_QUIET_LOGS) {
              log(`❌ Error in checker for ${email}: ${err.message}`);
            }
          }

          if (hasAccountFoundThisSession(email)) {
            log(`✅ [${email}] لقط معاد — الانتقال للحساب التالي فورًا`);
          } else {
            log(`⏭️ [${email}] انتهى بدون لقط — الانتقال للحساب التالي`);
          }
        }
      } else {
        let syncFireAtMs = null;
        let syncFireBoundaryMs = null;
        let syncFireOpts = null;

        if (scheduledTarget && cycleNum === 1) {
          // Dress before alarm: workers arm now, fire at scheduled strike
          syncFireAtMs = scheduledTarget.targetEpoch;
          syncFireBoundaryMs = 50;
          syncFireOpts = {
            maxWaitMs: 25 * 60 * 60 * 1000,
            silentFirstFire: true
          };
        } else if (SYNC_FIRE_ENABLED) {
          const now = ntpNow();
          syncFireAtMs = now + (1000 - (now % 1000)) + 100;
          syncFireBoundaryMs = 50;
        }

        // 🧠 Intelligent mode: ignore ALL manual timing, compute the best schedule
        // from the live enabled-account count (max speed, no 429, full-time coverage)
        let smartSchedParallel = null;
        if (isSmartPacingEnabled(null)) {
          smartSchedParallel = computeSmartSchedule(accountsForCycle.length);
          logSmartSchedule(smartSchedParallel, 'PARALLEL/GROUP');
        }

        const checkerPromises = accountsForCycle.map((accountData, workerIndex) =>
          accountCheckerWorker(
            accountData,
            waveCap,
            browser,
            syncFireAtMs,
            syncFireBoundaryMs,
            {
              ...(syncFireOpts || {}),
              // 🧠 Intelligent mode: ignore ALL manual timing, run the computed best schedule
              ...(smartSchedParallel ? {
                smartIntervalMs: smartSchedParallel.cycleTimeMs,
                initialDelayMs: workerIndex * smartSchedParallel.interAccountMs
              } : {})
            }
          ).catch((err) => {
            if (!SEQUENTIAL_QUIET_LOGS) {
              log(`❌ Error in checker for ${accountData.account.email}: ${err.message}`);
            }
          })
        );

        // Token refresh + bulk pre-arm on main while workers are already armed/waiting
        if (scheduledTarget && cycleNum === 1) {
          await waitUntilFireWithPreRefresh(
            scheduledTarget.targetEpoch,
            accountsForCycle,
            browser,
            'parallel',
            { cairoWall: scheduledTarget.cairoWall }
          );
        }

        await Promise.all(checkerPromises);
        throwIfLiveReschedule();

        // 🧠 Rotation: park this wave's accounts, continue with fresh standby accounts.
        // Skipped for repeat/seq9/fake paths which own their account flow.
        if (rotationOn && waveCap && !seq2RepeatEnabled && !ENABLE_SEQUENTIAL_PARALLEL_9AM && !FAKE_PROBE_ACTIVE) {
          for (const a of accountsForCycle) usedInRotation.add(emailKey(a.account.email));
          const standbyLeft = successfulAccounts.filter(
            (a) => !hasAccountFoundThisSession(a.account.email) && !usedInRotation.has(emailKey(a.account.email))
          ).length;
          if (standbyLeft > 0) {
            waveNum++;
            log(`\n🔄 Rotation: wave ${waveNum} parked at ~${smartMaxReqPerAccount} req/account — continuing with ${standbyLeft} fresh account(s)`);
            continue; // next while(true) iteration launches the next wave immediately
          }
          log(`\n✅ Rotation complete: all accounts used, no standby left`);
        }
      }

      if (isLiveReschedulePending()) throwIfLiveReschedule();

      if (!seq2RepeatEnabled) break;

      if (cycleNum >= maxRepeatCycles) {
        log(`\n⏹️ وصلنا لحد أقصى الجولات (${maxRepeatCycles})`);
        break;
      }

      const remaining = successfulAccounts.filter(
        (a) => !hasAccountFoundThisSession(a.account.email)
      ).length;
      if (remaining === 0) {
        log(`\n⏭️ كل الحسابات لقطت معاد — إيقاف التكرار`);
        break;
      }

      // Respect global stop-at-time between cycles
      if (ENABLE_STOP_AT_TIME && shouldStopSendingRequests(null, 0)) {
        log(`\n🛑 Stop-at-time reached — stopping repeat cycles`);
        break;
      }

      // Wait only the remaining time until (cycleStart + interval)
      const elapsedMs = ntpNow() - cycleStartMs;
      const waitMs = Math.max(0, repeatIntervalMs - elapsedMs);
      const nextCycleAt = cycleStartMs + repeatIntervalMs;
      if (waitMs > 0) {
        log(`\n⏳ الجولة الجاية الساعة ${formatCairoHms(nextCycleAt, true)} (بعد ${Math.ceil(waitMs / 1000)} ث | الفاصل من بداية التشييك)`);
        const nextAccounts = successfulAccounts.filter(
          (a) => !hasAccountFoundThisSession(a.account.email)
        );
        await waitUntilFireWithPreRefresh(nextCycleAt, nextAccounts, browser, `seq2-cycle-${cycleNum + 1}`);
      } else {
        log(`\n⚡ الجولة أخدت أطول من ${repeatIntervalMinutes} د — الجولة ${cycleNum + 1} فورًا (متبقي ${remaining} حساب)`);
      }
      // Sync found accounts from file in case any were restored via UI
      syncAccountsFoundFromFile();
    }
    
    // Now close the browser after all checks are done
    await closeBotBrowser(browser);
    log("\n✅ All checkers completed!");
  }
  }; // end runSelectedCheckMode

  // =========================
  // CHECK MODE EXECUTION (+ live reschedule loop)
  // =========================
  startLiveWindowControl({ accountCount: accountsToUse.length });
  // Browser is a login FALLBACK only (API login goes first). On servers without a
  // display/Chrome the launch fails — keep going with browser=null (API login only)
  // instead of killing the whole run.
  let browser = null;
  try {
    browser = await chromium.launch(launchOptions);
  } catch (e) {
    const why = String((e && e.message) || e || '').split('\n')[0].slice(0, 160);
    log(`⚠️ Browser launch failed (${why}) — continuing WITHOUT browser (API login only)`);
    browser = null;
  }
  try {
    while (true) {
      updateLiveWindowMeta({
        status: 'running',
        scheduledCheckTime: CONFIG.scheduledCheckTime || '',
        enableScheduledCheck: !!CONFIG.enableScheduledCheck,
        accounts: accountsToUse.length
      });
      try {
        await waitForLoginBeforeCheck();
        await runSelectedCheckMode(accountsToUse, browser);
      } catch (e) {
        if (!isLiveRescheduleError(e)) throw e;
      }

      const cmd = consumePendingLiveReschedule();
      if (!cmd) break;

      CONFIG.enableScheduledCheck = true;
      CONFIG.scheduledCheckTime = cmd.scheduledCheckTime;
      updateLiveWindowMeta({
        status: 'relogin',
        scheduledCheckTime: cmd.scheduledCheckTime,
        enableScheduledCheck: true
      });

      log(`\n${'='.repeat(60)}`);
      log(`🔄 إعادة جدولة حية لهذه النافذة → ${cmd.scheduledCheckTime}`);
      log(`🔐 تسجيل دخول جديد لكل حسابات اللوج — النافذة تفضل مفتوحة`);
      log(`${'='.repeat(60)}\n`);

      try { await browser.close(); } catch (_) {}
      clearSessionAuthStateForRelogin();
      try {
        browser = await chromium.launch(launchOptions);
      } catch (e) {
        const why = String((e && e.message) || e || '').split('\n')[0].slice(0, 160);
        log(`⚠️ Browser relaunch failed (${why}) — continuing WITHOUT browser`);
        browser = null;
      }
    }
  } finally {
    stopLiveWindowControl();
    try { await browser.close(); } catch (_) {}
  }

  // Don't let the console vanish when the bot process exits
  await holdConsoleOpen();
  
})().catch(async (err) => {
  try { stopLiveWindowControl(); } catch (_) {}
  log(`❌ FATAL ERROR: ${err.message}`);
  console.error(err);
  await safeExitSync(1);
});

// Top-level error handlers to prevent silent crashes
process.on('exit', () => {
  finalizeSessionLog('exit');
});
process.on('SIGINT', () => {
  finalizeSessionLog('SIGINT');
  process.exit(0);
});
process.on('SIGTERM', () => {
  finalizeSessionLog('SIGTERM');
  process.exit(0);
});
process.on('SIGHUP', () => {
  finalizeSessionLog('SIGHUP');
  process.exit(0);
});

process.on('uncaughtException', async (err) => {
  try {
    log(`💥 UNCAUGHT EXCEPTION: ${err.message}`);
  } catch (_) {
    console.error(`💥 UNCAUGHT EXCEPTION: ${err.message}`);
  }
  console.error(err.stack);
  finalizeSessionLog('uncaughtException');
  await safeExitSync(1);
});

process.on('unhandledRejection', async (reason) => {
  try {
    log(`💥 UNHANDLED REJECTION: ${reason?.message || reason}`);
  } catch (_) {
    console.error(`💥 UNHANDLED REJECTION: ${reason?.message || reason}`);
  }
  console.error(reason?.stack || '');
  finalizeSessionLog('unhandledRejection');
  await safeExitSync(1);
});

