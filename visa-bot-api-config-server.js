// visa-bot-api-config-server.js - Configuration server for API bot
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { spawn, spawnSync } from 'child_process';
import { getAccurateUtcMs } from './ntp-clock.js';

// Must stay in sync with VISA_TYPE_TO_ID in visa-bot-api-multi-account-FIXED.js
const BOT_VISA_TYPE_TO_ID = {
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
    'Tourism Visa (C)': 1,
    'Business Visa (C)': 5,
    'Sport Visa (C)': 10
};

function normalizeVisaTitle(title) {
    return String(title || '')
        .toLowerCase()
        .replace(/[()]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function httpsJson({ url, method = 'GET', headers = {}, body = null, rejectUnauthorized = true, timeoutMs = 25000 }) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const u = new URL(url);
        const req = https.request({
            protocol: u.protocol,
            hostname: u.hostname,
            port: u.port || 443,
            path: u.pathname + u.search,
            method,
            headers,
            rejectUnauthorized,
            timeout: timeoutMs
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                if (settled) return;
                settled = true;
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                if (text) {
                    try { json = JSON.parse(text); } catch (_) {}
                }
                resolve({ status: res.statusCode || 0, text, json, headers: res.headers });
            });
        });
        req.on('timeout', () => {
            req.destroy(new Error('timeout'));
        });
        req.on('error', (err) => {
            if (settled) return;
            settled = true;
            reject(err);
        });
        if (body) req.write(body);
        req.end();
    });
}

async function loginPasswordGrant(account, rejectUnauthorized) {
    const body = new URLSearchParams({
        grant_type: 'password',
        client_id: 'aa-visasys-public',
        username: account.email,
        password: account.password,
        scope: 'openid profile email'
    }).toString();
    const res = await httpsJson({
        url: 'https://egyiam.almaviva-visa.it/realms/oauth2-visaSystem-realm-pkce/protocol/openid-connect/token',
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        body,
        rejectUnauthorized
    });
    if (res.status !== 200 || !res.json?.access_token) {
        const detail = (res.text || '').slice(0, 200);
        throw new Error(`فشل تسجيل الدخول (${res.status})${detail ? ': ' + detail : ''}`);
    }
    return res.json.access_token;
}

async function fetchSiteVisas(officeId, token, rejectUnauthorized) {
    const res = await httpsJson({
        url: `https://egyapi.almaviva-visa.it/configuration-manager/api/visas/v1/list/web?office=${officeId}`,
        method: 'GET',
        headers: {
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en',
            'Authorization': `Bearer ${token}`,
            'Origin': 'https://egy.almaviva-visa.it',
            'Referer': 'https://egy.almaviva-visa.it/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        rejectUnauthorized
    });
    if (res.status !== 200 || !Array.isArray(res.json)) {
        throw new Error(`فشل جلب تأشيرات المكتب ${officeId} (HTTP ${res.status})`);
    }
    return res.json.map((v) => ({
        id: Number(v.id),
        title: String(v.title || v.name || '').trim()
    })).filter((v) => v.id && v.title);
}

function compareBotVisaIds(siteVisas) {
    const siteByNorm = new Map();
    for (const v of siteVisas) {
        const key = normalizeVisaTitle(v.title);
        if (!siteByNorm.has(key)) siteByNorm.set(key, v);
    }

    const seenIds = new Set();
    const comparisons = [];
    for (const [botName, botId] of Object.entries(BOT_VISA_TYPE_TO_ID)) {
        // skip legacy alias rows in UI (e.g. "Tourism Visa (C)" when "Tourism Visa" exists)
        if (botName.endsWith(' (C)') && BOT_VISA_TYPE_TO_ID[botName.replace(/ \(C\)$/, '')] === botId) {
            continue;
        }
        const norm = normalizeVisaTitle(botName);
        let site = siteByNorm.get(norm) || null;
        if (!site) {
            // soft match: site title contains bot keywords
            for (const [k, v] of siteByNorm.entries()) {
                if (k.includes(norm) || norm.includes(k)) {
                    site = v;
                    break;
                }
            }
        }
        if (!site) {
            // match by same numeric id
            site = siteVisas.find((v) => v.id === botId) || null;
        }
        let status = 'missing_on_site';
        if (site) {
            seenIds.add(site.id);
            status = site.id === botId ? 'match' : 'mismatch';
        }
        comparisons.push({
            botName,
            botId,
            siteTitle: site?.title || null,
            siteId: site?.id ?? null,
            status
        });
    }

    const unknownOnBot = siteVisas
        .filter((v) => !seenIds.has(v.id) && !Object.values(BOT_VISA_TYPE_TO_ID).includes(v.id))
        .map((v) => ({ siteTitle: v.title, siteId: v.id, status: 'unknown_to_bot' }));

    // Also show site visas matched only by id under a different title already counted;
    // unknown list is enough for brand-new types.

    const mismatchCount = comparisons.filter((c) => c.status === 'mismatch').length;
    const missingCount = comparisons.filter((c) => c.status === 'missing_on_site').length;
    const matchCount = comparisons.filter((c) => c.status === 'match').length;

    return {
        comparisons,
        unknownOnBot,
        summary: {
            matchCount,
            mismatchCount,
            missingCount,
            unknownCount: unknownOnBot.length,
            ok: mismatchCount === 0 && missingCount === 0
        }
    };
}

async function runVisaIdCheck() {
    const config = loadConfig();
    const rejectUnauthorized = config.allowInsecureTls === false;
    const accounts = loadAccounts();
    const account = accounts.find((a) => a && a.enabled !== false && a.email && a.password);
    if (!account) {
        throw new Error('مفيش حساب مفعّل فيه إيميل وباسورد لاستخدامه في الكشف');
    }

    const token = await loginPasswordGrant(account, rejectUnauthorized);
    const byId = new Map();
    for (const officeId of [1, 2]) {
        try {
            const list = await fetchSiteVisas(officeId, token, rejectUnauthorized);
            for (const v of list) {
                if (!byId.has(v.id)) byId.set(v.id, v);
            }
        } catch (e) {
            if (officeId === 1) throw e;
            // Alexandria optional if Cairo succeeded
        }
    }
    const siteVisas = [...byId.values()].sort((a, b) => a.id - b.id);
    const compared = compareBotVisaIds(siteVisas);
    return {
        success: true,
        usedAccount: account.email,
        fetchedAt: new Date().toISOString(),
        siteVisas,
        ...compared
    };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG_FILE = path.join(__dirname, 'visa-bot-api-config.json');
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
const FAKE_ACCOUNTS_FILE = path.join(__dirname, 'accounts-fake.json');
const BOT_STATUS_FILE = path.join(__dirname, 'bot-api-status.json');
const BOT_LOGS_FILE = path.join(__dirname, 'bot-api-logs.txt');
const APPOINTMENT_FILE = path.join(__dirname, 'appointment-found.json');
const RATE_LIMITED_FILE = path.join(__dirname, 'rate-limited-accounts.json');
const HTML_FILE = path.join(__dirname, 'visa-bot-api-manager.html');
const PORT = 3004;
process.env.PUPPETEER_CACHE_DIR = path.join(__dirname, '.puppeteer');

process.on('unhandledRejection', (err) => {
    const msg = String((err && err.message) || err || '');
    if (/EBUSY|wwebjs_auth|first_party_sets|Execution context was destroyed|Protocol error/i.test(msg)) {
        console.log('⚠️ WhatsApp session file busy — ignored');
        return;
    }
    console.error('Unhandled rejection:', err);
});
process.on('uncaughtException', (err) => {
    const msg = String((err && err.message) || err || '');
    if (/EBUSY|wwebjs_auth|first_party_sets|Execution context was destroyed|Protocol error/i.test(msg)) {
        console.log('⚠️ WhatsApp session file busy — ignored');
        return;
    }
    console.error('Uncaught exception:', err);
});

// Load or create default config
function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
            // Always open with 60 min rate-limit cooldown (user preference)
            if (config.rateLimitCooldown !== 60) {
                config.rateLimitCooldown = 60;
                try {
                    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
                } catch (_) {}
            }
            return config;
        }
    } catch (e) {
        console.log('⚠️ Error loading config, using defaults');
    }
    
    // If config file doesn't exist, return defaults with empty telegram
    try {
        if (!fs.existsSync(CONFIG_FILE)) {
            return {
                office: 'Cairo',
                pricing: 'Standard',
                visaType: 'Tourism Visa (C)',
                visaId: 1,
                tripDate: '01/12/2025',
                useProxy: false,
                skipIPVerification: false,
                proxyServer: '',
                rateLimitCooldown: 60,
                requestsPerMinute: 30,
                maxAccounts: 1,
                enableScheduledCheck: false,
                scheduledCheckTime: '',
                enableLoginBeforeCheck: false,
                aggressiveMode: { enabled: false, parallelRequests: 3, intervalSeconds: 3, doubleHit: false },
                sequentialMode: { enabled: false, delayMs: 0, enableStopAtTime: false, stopAtTime: '', enableStopAfterRequests: false, stopAfterRequests: 10 },
                sequentialParallelMode9: { enabled: false, delayMs: 0, enableStopAtTime: false, stopAtTime: '', enableStopAfterRequests: false, stopAfterRequests: 10 },
                sequentialMode2: { enabled: false, delayMs: 0, enableStopAfterRequests: false, stopAfterRequests: 10, repeatCycles: false, repeatIntervalMinutes: 5, maxCycles: 0 },
                parallelRoundRobinMode: { enabled: false },
                sequentialAggressiveMode: { enabled: false },
                sequentialAggressivePlusMode: { enabled: false },
                sequentialAggressiveFakeMode: { enabled: false },
                groupByVisaOnly: false,
                logWindowLayout: { slots: 10, enabled: true },
                stopControl: { enableStopAtTime: false, stopAtTime: '', enableStopAfterRequests: false, stopAfterRequests: 0 },
                enablePerAccountStartTime: false,
                telegram: { enabled: false, botToken: '', channels: [], messageLines: ['title', 'account', 'for', 'phone', 'office', 'visa', 'date', 'requestSent', 'responseReceived', 'responseTime'] },
                whatsapp: { enabled: false, chatId: '', chatName: '', ownerNumbers: [], remoteControl: { enabled: false } }
            };
        }
    } catch (e) {}

    return {
        office: 'Cairo',
        pricing: 'Standard',
        visaType: 'Tourism Visa (C)',
        visaId: 1,
        tripDate: '01/12/2025',
        useProxy: false,
        skipIPVerification: false,
        proxyServer: 'brd.superproxy.io:33335:brd-customer-hl_0b3f5f3e-zone-isp_proxy1-country-eg:2sbm4v5s15x7',
        rateLimitCooldown: 60,
        requestsPerMinute: 30,
        maxAccounts: 1,
        enableScheduledCheck: false,
        scheduledCheckTime: '',
        enableLoginBeforeCheck: false,
        aggressiveMode: {
            enabled: false,
            parallelRequests: 3,
            intervalSeconds: 3
        },
        sequentialMode: {
            enabled: false,
            delayMs: 0,
            enableStopAtTime: false,
            stopAtTime: '',
            enableStopAfterRequests: false,
            stopAfterRequests: 10
        },
        sequentialParallelMode9: {
            enabled: false,
            delayMs: 0,
            enableStopAtTime: false,
            stopAtTime: '',
            enableStopAfterRequests: false,
            stopAfterRequests: 10
        },
        sequentialMode2: {
            enabled: false,
            delayMs: 0,
            enableStopAfterRequests: false,
            stopAfterRequests: 10,
            repeatCycles: false,
            repeatIntervalMinutes: 5,
            maxCycles: 0
        },
        parallelRoundRobinMode: {
            enabled: false,
            continueAfterFound: true,
            checkIntervalSeconds: 30,
            maxRequestsPerAccount: 50
        },
    sequentialAggressiveMode: {
        enabled: false,
        delayBetweenAccountsMs: 200,
        delayBetweenCyclesMs: 1000
    },
    sequentialAggressivePlusMode: {
        enabled: false,
        delayBetweenAccountsMs: 200,
        delayBetweenCyclesMs: 1000,
        maxCycles: 0,
        restartDelayMinutes: 0
    },
    sequentialAggressiveFakeMode: {
        enabled: false,
        delayBetweenAccountsMs: 100,
        delayBetweenCyclesMs: 10000,
        maxCycles: 3,
        restartDelayMinutes: 5,
        offices: ['Cairo'],
        visaTypes: ['Tourism Visa'],
        enableScheduledCheck: false,
        scheduledCheckTime: ''
    },
    stopControl: {
        enableStopAtTime: false,
        stopAtTime: '',
        enableStopAfterRequests: false,
        stopAfterRequests: 0
    },
    enablePerAccountStartTime: false,
    logWindowLayout: { slots: 10, enabled: true },
    telegram: {
        enabled: false,
        botToken: '',
        channels: [],
        messageLines: ['title', 'account', 'for', 'phone', 'office', 'visa', 'date', 'requestSent', 'responseReceived', 'responseTime']
    },
    };
}

// Resolve active logo file (any supported extension)
function resolveLogoFile() {
    const exts = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
    for (const e of exts) {
        const f = path.join(__dirname, `logo.${e}`);
        if (fs.existsSync(f)) return f;
    }
    return null;
}

// Save config
function saveConfig(config) {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
        return true;
    } catch (e) {
        console.error('❌ Error saving config:', e);
        return false;
    }
}

function persistBotOwner() {
    try { fs.unlinkSync(path.join(__dirname, 'bot-owner.txt')); } catch (_) {}
    let fromCfg = '';
    try { fromCfg = String(loadConfig()?.ntfy?.botName || '').trim(); } catch (_) {}
    const fromEnv = String(process.env.BOT_OWNER || '').trim();
    const name = fromCfg || fromEnv;
    if (!name) return '';
    process.env.BOT_OWNER = name;
    if (!fromCfg) {
        try {
            const cfg = loadConfig();
            cfg.ntfy = cfg.ntfy && typeof cfg.ntfy === 'object' ? cfg.ntfy : {};
            cfg.ntfy.botName = name;
            saveConfig(cfg);
        } catch (_) {}
    }
    return name;
}
persistBotOwner();
import('./telegram-notifier.js').catch((e) => {
    console.log('⚠️ Heartbeat skipped:', e?.message || e);
});

function getScreenWorkArea() {
    // AV-safe: no PowerShell probe. Fixed default; tiling is optional.
    return { left: 0, top: 0, width: 1920, height: 1040 };
}

function logWindowGrid(slots, workArea) {
    const n = Math.max(1, Math.min(40, parseInt(slots, 10) || 10));
    const W = Math.max(800, workArea?.width || 1920);
    const H = Math.max(500, workArea?.height || 1040);
    let best = { cols: 1, rows: n, score: -Infinity };
    for (let cols = 1; cols <= n; cols++) {
        const rows = Math.ceil(n / cols);
        const aspect = (W / cols) / (H / rows);
        const unused = cols * rows - n;
        let score = -Math.abs(aspect - 1.7) - unused * 0.4;
        if (aspect < 1.1) score -= 6;
        if (score > best.score) best = { cols, rows, score };
    }
    return { slots: n, cols: best.cols, rows: best.rows };
}

function runTileLogWindows(launchDir, cols, rows, cellW, cellH) {
    // AV-safe: window tiling via user32 P/Invoke disabled by default.
    // Set BOT_TILE_WINDOWS=1 to re-enable the tile-*.ps1 scripts.
    if (process.env.BOT_TILE_WINDOWS !== '1') return;
    try {
        spawnSync('powershell', [
            '-NoProfile', '-STA', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned',
            '-File', path.join(launchDir, 'tile-all-log-windows.ps1')
        ], {
            cwd: launchDir,
            windowsHide: false,
            timeout: 20000,
            env: {
                ...process.env,
                BOT_WIN_COLS: String(cols),
                BOT_WIN_ROWS: String(rows),
                BOT_CELL_W: String(cellW),
                BOT_CELL_H: String(cellH)
            }
        });
    } catch (_) {}
}

function countBotLogWindows(launchDir) {
    if (process.env.BOT_TILE_WINDOWS !== '1') return 0;
    try {
        const out = spawnSync('powershell', [
            '-NoProfile', '-STA', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned',
            '-File', path.join(launchDir, 'count-log-windows.ps1')
        ], {
            cwd: launchDir,
            windowsHide: false,
            timeout: 10000,
            encoding: 'utf8'
        });
        const lines = String(out.stdout || '').trim().split(/\r?\n/).filter(Boolean);
        const n = parseInt(lines[lines.length - 1], 10);
        return Number.isFinite(n) && n > 0 ? n : 0;
    } catch (_) {
        return 0;
    }
}

function takeWinSeq(launchDir, count) {
    const f = path.join(launchDir, 'win-seq.txt');
    let n = 0;
    try { n = parseInt(fs.readFileSync(f, 'utf8'), 10) || 0; } catch (_) {}
    if (!Number.isFinite(n) || n < 0) n = 0;
    try { fs.writeFileSync(f, String(n + count), 'utf8'); } catch (_) {}
    return n;
}

function writeTileIds(launchDir, newLines) {
    const file = path.join(launchDir, 'tile-ids.txt');
    let prev = [];
    try {
        prev = fs.readFileSync(file, 'utf8')
            .replace(/^\uFEFF/, '')
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => /WID\d{4}/.test(l));
    } catch (_) {}
    const newNeedles = new Set(newLines.map((l) => String(l).split('\t')[0]));
    const kept = prev.filter((l) => !newNeedles.has(String(l).split('\t')[0]));
    fs.writeFileSync(file, [...kept, ...newLines].join('\n'), 'utf8');
}

const TILE_MOVE_CS = [
    'using System;',
    'using System.Collections.Generic;',
    'using System.Text;',
    'using System.Runtime.InteropServices;',
    'public class BotMove {',
    '  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);',
    '  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
    '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
    '  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int W, int H, bool r);',
    '  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int X, int Y, int cx, int cy, uint flags);',
    '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);',
    '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);',
    '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rc);',
    '  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);',
    '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);',
    '  [DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int n);',
    '  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern bool SetCurrentConsoleFontEx(IntPtr h, bool max, ref CONSOLE_FONT_INFOEX info);',
    '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }',
    '  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]',
    '  public struct CONSOLE_FONT_INFOEX {',
    '    public int cbSize; public int nFont; public short dwFontSizeX; public short dwFontSizeY;',
    '    public int FontFamily; public int FontWeight;',
    '    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string FaceName;',
    '  }',
    '  public static IntPtr RootWindow(IntPtr h) {',
    '    if (h == IntPtr.Zero) return h;',
    '    var r = GetAncestor(h, 2);',
    '    return r != IntPtr.Zero ? r : h;',
    '  }',
    '  static IntPtr foundHwnd;',
    '  static string[] needles;',
    '  static bool TitleHits(string t) {',
    '    foreach (var n in needles) {',
    '      if (!string.IsNullOrEmpty(n) && t.IndexOf(n, StringComparison.OrdinalIgnoreCase) >= 0) return true;',
    '    }',
    '    return false;',
    '  }',
    '  static bool EnumCb(IntPtr h, IntPtr l) {',
    '    if (!IsWindowVisible(h)) return true;',
    '    var sb = new StringBuilder(512);',
    '    GetWindowText(h, sb, 512);',
    '    string t = sb.ToString();',
    '    if (string.IsNullOrEmpty(t) || !TitleHits(t)) return true;',
    '    foundHwnd = RootWindow(h);',
    '    return false;',
    '  }',
    '  public static IntPtr FindByTitle(string joined) {',
    '    foundHwnd = IntPtr.Zero;',
    '    needles = (joined ?? "").Split(new char[]{\'|\'}, StringSplitOptions.RemoveEmptyEntries);',
    '    EnumWindows(EnumCb, IntPtr.Zero);',
    '    return foundHwnd;',
    '  }',
    '  static HashSet<long> countedRoots;',
    '  static bool CountCb(IntPtr h, IntPtr l) {',
    '    if (!IsWindowVisible(h)) return true;',
    '    var sb = new StringBuilder(512);',
    '    GetWindowText(h, sb, 512);',
    '    string t = sb.ToString();',
    '    if (string.IsNullOrEmpty(t) || !TitleHits(t)) return true;',
    '    countedRoots.Add(RootWindow(h).ToInt64());',
    '    return true;',
    '  }',
    '  public static int CountByTitle(string joined) {',
    '    countedRoots = new HashSet<long>();',
    '    needles = (joined ?? "").Split(new char[]{\'|\'}, StringSplitOptions.RemoveEmptyEntries);',
    '    EnumWindows(CountCb, IntPtr.Zero);',
    '    return countedRoots.Count;',
    '  }',
    '  static List<string> listed;',
    '  static HashSet<long> listedRoots;',
    '  static bool ListCb(IntPtr h, IntPtr l) {',
    '    if (!IsWindowVisible(h)) return true;',
    '    var sb = new StringBuilder(512);',
    '    GetWindowText(h, sb, 512);',
    '    string t = sb.ToString();',
    '    if (string.IsNullOrEmpty(t) || !TitleHits(t)) return true;',
    '    var root = RootWindow(h);',
    '    if (!listedRoots.Add(root.ToInt64())) return true;',
    '    RECT rc; GetWindowRect(root, out rc);',
    '    listed.Add(root.ToInt64() + "\\t" + rc.Left + "\\t" + rc.Top + "\\t" + rc.Right + "\\t" + rc.Bottom + "\\t" + t.Replace("\\t", " "));',
    '    return true;',
    '  }',
    '  public static string ListMatches(string joined) {',
    '    listed = new List<string>();',
    '    listedRoots = new HashSet<long>();',
    '    needles = (joined ?? "").Split(new char[]{\'|\'}, StringSplitOptions.RemoveEmptyEntries);',
    '    EnumWindows(ListCb, IntPtr.Zero);',
    '    return string.Join("\\n", listed);',
    '  }',
    '  public static void SetEmojiFont() {',
    '    try {',
    '      var h = GetStdHandle(-11);',
    '      var info = new CONSOLE_FONT_INFOEX();',
    '      info.cbSize = Marshal.SizeOf(typeof(CONSOLE_FONT_INFOEX));',
    '      info.FaceName = "Cascadia Mono";',
    '      info.dwFontSizeY = 16;',
    '      info.FontWeight = 400;',
    '      info.FontFamily = 54;',
    '      if (!SetCurrentConsoleFontEx(h, false, ref info)) {',
    '        info.FaceName = "Consolas";',
    '        SetCurrentConsoleFontEx(h, false, ref info);',
    '      }',
    '    } catch {}',
    '  }',
    '}'
].join('\n');

const TILE_FIND_PS = [
    'function Find-BotHwnd([string[]]$Needles) {',
    '  return [BotMove]::FindByTitle(($Needles | Where-Object { $_ }) -join "|")',
    '}'
].join('\r\n');

const TILE_LOG_WINDOW_PS1 = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `Add-Type -TypeDefinition @"`,
    TILE_MOVE_CS,
    '"@',
    'try { [BotMove]::SetProcessDPIAware() } catch {}',
    'try { [BotMove]::SetEmojiFont() } catch {}',
    'Add-Type -AssemblyName System.Windows.Forms',
    TILE_FIND_PS,
    '$idx = 0 + $env:BOT_WIN_INDEX',
    '$cols = 0 + $env:BOT_WIN_COLS',
    '$rows = 0 + $env:BOT_WIN_ROWS',
    'if ($cols -lt 1) { $cols = 1 }',
    'if ($rows -lt 1) { $rows = 1 }',
    'if ($idx -lt 0) { $idx = 0 }',
    '$needles = @($env:BOT_WIN_TITLE, $env:BOT_WIN_NEEDLE) | Where-Object { $_ }',
    '$hwnd = [IntPtr]::Zero',
    'for ($i = 0; $i -lt 40; $i++) {',
    '  $hwnd = Find-BotHwnd $needles',
    '  if ($hwnd -ne [IntPtr]::Zero) { break }',
    '  Start-Sleep -Milliseconds 100',
    '}',
    'if ($hwnd -eq [IntPtr]::Zero) { exit 0 }',
    '$b = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea',
    '$cellW = [Math]::Max(220, [int][Math]::Floor($b.Width / $cols))',
    '$cellH = [Math]::Max(180, [int][Math]::Floor($b.Height / $rows))',
    '$col = $idx % $cols',
    '$row = [int][Math]::Floor($idx / $cols)',
    '$x = $b.Left + ($col * $cellW)',
    '$y = $b.Top + ($row * $cellH)',
    '[BotMove]::ShowWindow($hwnd, 9) | Out-Null',
    '[BotMove]::MoveWindow($hwnd, $x, $y, $cellW, $cellH, $true) | Out-Null'
].join('\r\n');

const COUNT_LOG_WINDOWS_PS1 = [
    `Add-Type -TypeDefinition @"`,
    TILE_MOVE_CS,
    '"@',
    '[BotMove]::SetProcessDPIAware() | Out-Null',
    '$needlesFile = Join-Path $PSScriptRoot "count-needles.txt"',
    'if (-not (Test-Path -LiteralPath $needlesFile)) { Write-Output 0; exit 0 }',
    '$lines = Get-Content -LiteralPath $needlesFile -Encoding UTF8 | Where-Object { $_.Trim() -ne "" }',
    'if (-not $lines -or @($lines).Count -eq 0) { Write-Output 0; exit 0 }',
    '$n = [BotMove]::CountByTitle((@($lines) -join "|"))',
    'Write-Output $n'
].join('\r\n');

const LIST_LOG_WINDOWS_PS1 = [
    `Add-Type -TypeDefinition @"`,
    TILE_MOVE_CS,
    '"@',
    '[BotMove]::SetProcessDPIAware() | Out-Null',
    '$needlesFile = Join-Path $PSScriptRoot "count-needles.txt"',
    'if (-not (Test-Path -LiteralPath $needlesFile)) { exit 0 }',
    '$lines = Get-Content -LiteralPath $needlesFile -Encoding UTF8 | Where-Object { $_.Trim() -ne "" }',
    'if (-not $lines -or @($lines).Count -eq 0) { exit 0 }',
    '[BotMove]::ListMatches((@($lines) -join "|"))'
].join('\r\n');

const PLACE_BESIDE_PS1 = [
    `Add-Type -TypeDefinition @"`,
    TILE_MOVE_CS,
    '"@',
    '[BotMove]::SetProcessDPIAware() | Out-Null',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$cols = 0 + $env:BOT_WIN_COLS',
    '$rows = 0 + $env:BOT_WIN_ROWS',
    'if ($cols -lt 1) { $cols = 5 }',
    'if ($rows -lt 1) { $rows = 2 }',
    '$b = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea',
    '$cellW = [Math]::Max(280, [int][Math]::Floor($b.Width / $cols))',
    '$cellH = [Math]::Max(200, [int][Math]::Floor($b.Height / $rows))',
    '$newFile = Join-Path $PSScriptRoot "new-needles.txt"',
    'if (-not (Test-Path -LiteralPath $newFile)) { exit 0 }',
    '$needles = @(Get-Content -LiteralPath $newFile -Encoding UTF8 | Where-Object { $_.Trim() -ne "" })',
    'foreach ($needle in $needles) {',
    '  $hwnd = [IntPtr]::Zero',
    '  for ($i = 0; $i -lt 25; $i++) {',
    '    $hwnd = [BotMove]::FindByTitle($needle)',
    '    if ($hwnd -ne [IntPtr]::Zero) { break }',
    '    Start-Sleep -Milliseconds 80',
    '  }',
    '  if ($hwnd -eq [IntPtr]::Zero) { continue }',
    '  $raw = [BotMove]::ListMatches((@(Get-Content -LiteralPath (Join-Path $PSScriptRoot "count-needles.txt") -Encoding UTF8 -ErrorAction SilentlyContinue | Where-Object { $_.Trim() -ne "" }) -join "|"))',
    '  $others = @()',
    '  foreach ($line in @($raw -split "`n")) {',
    '    $p = $line.Trim().Split("`t")',
    '    if ($p.Length -lt 5) { continue }',
    '    $id = 0L',
    '    [long]::TryParse($p[0], [ref]$id) | Out-Null',
    '    if ($id -eq $hwnd.ToInt64()) { continue }',
    '    $others += @{ L = [int]$p[1]; T = [int]$p[2]; R = [int]$p[3]; B = [int]$p[4] }',
    '  }',
    '  $w = $cellW; $h = $cellH; $x = $b.Left; $y = $b.Top',
    '  if ($others.Count -gt 0) {',
    '    $w = [Math]::Max(200, $others[0].R - $others[0].L)',
    '    $h = [Math]::Max(160, $others[0].B - $others[0].T)',
    '    $rowTop = ($others | ForEach-Object { $_.T } | Measure-Object -Minimum).Minimum',
    '    $row = @($others | Where-Object { $_.T -le ($rowTop + 60) })',
    '    $right = ($row | ForEach-Object { $_.R } | Measure-Object -Maximum).Maximum',
    '    $x = $right',
    '    $y = $rowTop',
    '    if (($x + $w) -gt ($b.Right + 10)) {',
    '      $x = $b.Left',
    '      $y = $rowTop + $h',
    '    }',
    '  }',
    '  [BotMove]::ShowWindow($hwnd, 9) | Out-Null',
    '  [BotMove]::MoveWindow($hwnd, [int]$x, [int]$y, [int]$w, [int]$h, $true) | Out-Null',
    '  Start-Sleep -Milliseconds 80',
    '}'
].join('\r\n');

const TILE_ALL_LOG_WINDOWS_PS1 = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `Add-Type -TypeDefinition @"`,
    TILE_MOVE_CS,
    '"@',
    'try { [BotMove]::SetProcessDPIAware() } catch {}',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$cols = 0 + $env:BOT_WIN_COLS',
    '$rows = 0 + $env:BOT_WIN_ROWS',
    'if ($cols -lt 1) { $cols = 5 }',
    'if ($rows -lt 1) { $rows = 2 }',
    '$b = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea',
    '$cellW = 0 + $env:BOT_CELL_W',
    '$cellH = 0 + $env:BOT_CELL_H',
    'if ($cellW -lt 1) { $cellW = [Math]::Max(1, [int][Math]::Floor($b.Width / $cols)) }',
    'if ($cellH -lt 1) { $cellH = [Math]::Max(1, [int][Math]::Floor($b.Height / $rows)) }',
    '$slotMap = @{}',
    '$idsFile = Join-Path $PSScriptRoot "tile-ids.txt"',
    'if (Test-Path -LiteralPath $idsFile) {',
    '  foreach ($line in @(Get-Content -LiteralPath $idsFile -Encoding UTF8 | Where-Object { $_.Trim() -ne "" })) {',
    '    $parts = @($line -split "`t")',
    '    $needle = ([string]$parts[0]).Trim().Trim([char]0xFEFF)',
    '    if ($needle -notmatch "WID\\d{4}") { continue }',
    '    $wid = [regex]::Match($needle, "WID\\d{4}").Value',
    '    $slot = 0',
    '    if ($parts.Length -gt 1) { [int]::TryParse(([string]$parts[1]).Trim(), [ref]$slot) | Out-Null }',
    '    $slotMap[$wid] = $slot',
    '  }',
    '}',
    'function Get-WidWins {',
    '  $out = @()',
    '  foreach ($line in @(([BotMove]::ListMatches("WID")) -split "`n")) {',
    '    $p = $line.Trim().Split("`t")',
    '    if ($p.Length -lt 6) { continue }',
    '    $id = 0L',
    '    [long]::TryParse($p[0], [ref]$id) | Out-Null',
    '    if ($id -eq 0) { continue }',
    '    $title = $p[5]',
    '    $m = [regex]::Match($title, "WID\\d{4}")',
    '    if (-not $m.Success) { continue }',
    '    $out += @{ Id = $id; Wid = $m.Value; Title = $title; L = [int]$p[1]; T = [int]$p[2] }',
    '  }',
    '  return $out',
    '}',
    '$found = @{}',
    'for ($r = 0; $r -lt 8; $r++) {',
    '  foreach ($w in @(Get-WidWins)) { if (-not $found.ContainsKey($w.Wid)) { $found[$w.Wid] = $w } }',
    '  $pending = @($slotMap.Keys | Where-Object { -not $found.ContainsKey($_) })',
    '  if ($pending.Count -eq 0) { break }',
    '  Start-Sleep -Milliseconds 200',
    '}',
    '$script:moved = @{}',
    '$script:usedSlots = @{}',
    '$script:placedWid = @{}',
    'function Place-Win([long]$id, [int]$slot, [string]$wid) {',
    '  if ($script:moved.ContainsKey($id)) { return }',
    '  $hwnd = [IntPtr]$id',
    '  $col = $slot % $cols',
    '  $row = [int][Math]::Floor($slot / $cols)',
    '  $x = $b.Left + ($col * $cellW)',
    '  $y = $b.Top + ($row * $cellH)',
    '  [BotMove]::ShowWindow($hwnd, 9) | Out-Null',
    '  [BotMove]::MoveWindow($hwnd, [int]$x, [int]$y, [int]$cellW, [int]$cellH, $true) | Out-Null',
    '  [BotMove]::SetWindowPos($hwnd, [IntPtr]::Zero, [int]$x, [int]$y, [int]$cellW, [int]$cellH, 0x0040) | Out-Null',
    '  $script:moved[$id] = $true',
    '  $script:usedSlots[$slot] = $true',
    '  if ($wid) { $script:placedWid[$wid] = $slot }',
    '}',
    'foreach ($wid in @($slotMap.Keys)) {',
    '  if ($found.ContainsKey($wid)) { Place-Win $found[$wid].Id ([int]$slotMap[$wid]) $wid }',
    '}',
    '$leftover = @($found.Values | Where-Object { -not $script:moved.ContainsKey($_.Id) } | Sort-Object { [int]($_.Wid.Substring(3)) })',
    '$idx = 0',
    'foreach ($w in $leftover) {',
    '  while ($script:usedSlots.ContainsKey($idx)) { $idx++ }',
    '  Place-Win $w.Id $idx $w.Wid',
    '  $idx++',
    '}',
    '$needlesFile = Join-Path $PSScriptRoot "count-needles.txt"',
    '$join = "BotLog"',
    'if (Test-Path -LiteralPath $needlesFile) {',
    '  $lines = @(Get-Content -LiteralPath $needlesFile -Encoding UTF8 | Where-Object { $_.Trim() -ne "" })',
    '  if ($lines.Count -gt 0) { $join = @($lines) -join "|" }',
    '}',
    '$oldies = @()',
    'foreach ($line in @(([BotMove]::ListMatches($join)) -split "`n")) {',
    '  $p = $line.Trim().Split("`t")',
    '  if ($p.Length -lt 6) { continue }',
    '  $id = 0L',
    '  [long]::TryParse($p[0], [ref]$id) | Out-Null',
    '  if ($id -eq 0 -or $script:moved.ContainsKey($id)) { continue }',
    '  $oldies += @{ Id = $id; L = [int]$p[1]; T = [int]$p[2] }',
    '}',
    'foreach ($w in @($oldies | Sort-Object { $_.T }, { $_.L })) {',
    '  while ($script:usedSlots.ContainsKey($idx)) { $idx++ }',
    '  Place-Win $w.Id $idx ""',
    '  $idx++',
    '}',
    '$live = @($script:placedWid.GetEnumerator() | Sort-Object { [int]($_.Key.Substring(3)) } | ForEach-Object { $_.Key + "`t" + $_.Value })',
    'Set-Content -LiteralPath $idsFile -Value $live -Encoding UTF8'
].join('\r\n');

// Load accounts
function loadAccounts() {
    try {
        if (fs.existsSync(ACCOUNTS_FILE)) {
            return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
        }
    } catch (e) {
        console.log('⚠️ Error loading accounts');
    }
    return [];
}

function loadFakeAccounts() {
    try {
        if (fs.existsSync(FAKE_ACCOUNTS_FILE)) {
            return JSON.parse(fs.readFileSync(FAKE_ACCOUNTS_FILE, 'utf8'));
        }
    } catch (e) {
        console.log('⚠️ Error loading fake accounts');
    }
    return [];
}

function saveFakeAccounts(accounts) {
    try {
        if (!Array.isArray(accounts)) return false;
        fs.writeFileSync(FAKE_ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf8');
        return true;
    } catch (e) {
        console.error('❌ Error saving fake accounts:', e);
        return false;
    }
}

function loadAppointmentRecords() {
    try {
        if (!fs.existsSync(APPOINTMENT_FILE)) return [];
        const data = JSON.parse(fs.readFileSync(APPOINTMENT_FILE, 'utf8'));
        return Array.isArray(data) ? data : (data && data.account ? [data] : []);
    } catch (_) {
        return [];
    }
}

// Copy catch info onto the account history without locking/unlocking checks.
// The main banner can then be deleted without wiping "حسابات لقطت مواعيد".
function stampCaughtHistory(appointments) {
    const list = Array.isArray(appointments) ? appointments : [];
    if (list.length === 0) return;
    const accounts = loadAccounts();
    let changed = false;
    for (const apt of list) {
        const key = accountEmailKey(apt.account);
        if (!key) continue;
        const entry = accounts.find(a => accountEmailKey(a.email) === key);
        if (!entry) continue;
        if (!entry.caughtAt) {
            entry.caughtAt = apt.foundAt || new Date().toISOString();
            changed = true;
        }
        if (!entry.foundAppointment) {
            entry.foundAppointment = {
                office: apt.office || entry.office || '',
                visaType: apt.visaType || '',
                tripDate: apt.tripDate || '',
                destination: apt.destination || ''
            };
            changed = true;
        }
    }
    if (changed) {
        try {
            fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf8');
        } catch (e) {
            console.error('❌ Error stamping caught history:', e);
        }
    }
}

function accountEmailKey(email) {
    return String(email || '').trim().toLowerCase();
}

// Save accounts — never let a generic UI save wipe a catch-lock.
// foundAt is only cleared by /api/restore-account so a new check cannot mix with caught cards.
function saveAccounts(accounts) {
    try {
        let existing = [];
        try {
            if (fs.existsSync(ACCOUNTS_FILE)) {
                existing = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
            }
        } catch (_) {}
        const prevByEmail = new Map();
        for (const prev of Array.isArray(existing) ? existing : []) {
            if (prev && prev.email) prevByEmail.set(accountEmailKey(prev.email), prev);
        }
        const merged = (Array.isArray(accounts) ? accounts : []).map((acc) => {
            if (!acc) return acc;
            const prev = prevByEmail.get(accountEmailKey(acc.email));
            if (!prev) return acc;
            const next = { ...acc };
            if (prev.foundAt && !next.foundAt) {
                next.foundAt = prev.foundAt;
                next.foundAppointment = prev.foundAppointment || next.foundAppointment;
            }
            if (prev.caughtAt && !next.caughtAt) next.caughtAt = prev.caughtAt;
            if (prev.foundAppointment && !next.foundAppointment) next.foundAppointment = prev.foundAppointment;
            return next;
        });
        fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(merged, null, 2), 'utf8');
        return true;
    } catch (e) {
        console.error('❌ Error saving accounts:', e);
        return false;
    }
}

// Load bot status
function loadBotStatus() {
    try {
        if (fs.existsSync(BOT_STATUS_FILE)) {
            return JSON.parse(fs.readFileSync(BOT_STATUS_FILE, 'utf8'));
        }
    } catch (e) {}
    return { running: false, currentAccount: null };
}

// Note: Bot file now loads config from visa-bot-api-config.json
// No need to update bot file directly
function updateBotFile(config) {
    // Config is saved to file and bot loads it automatically
    // This function is kept for compatibility but does nothing
    return true;
}

// HTTP Server
const server = http.createServer((req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    const reqPath = (req.url || '/').split('?')[0];
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    
    // Serve HTML
    if (reqPath === '/' || reqPath === '/index.html') {
        fs.readFile(HTML_FILE, 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(data);
        });
        return;
    }
    
    // Serve logo (supports /logo.png?v=... cache busters)
    if (reqPath === '/logo.png') {
        const logoPath = resolveLogoFile();
        if (!logoPath) { res.writeHead(404); res.end(); return; }
        fs.readFile(logoPath, (err, data) => {
            if (err) { res.writeHead(404); res.end(); return; }
            const ext = path.extname(logoPath).slice(1).toLowerCase();
            const contentType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
                : ext === 'webp' ? 'image/webp'
                : ext === 'gif' ? 'image/gif'
                : 'image/png';
            res.writeHead(200, {
                'Content-Type': contentType,
                'Cache-Control': 'no-cache'
            });
            res.end(data);
        });
        return;
    }

    // Serve standalone Colab runner template (placeholders filled by HTML)
    if (reqPath === '/colab-clockburst.py' && req.method === 'GET') {
        const f = path.join(__dirname, 'colab-clockburst.py');
        fs.readFile(f, 'utf8', (err, data) => {
            if (err) { res.writeHead(404); res.end(); return; }
            res.writeHead(200, {
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': 'no-cache'
            });
            res.end(data);
        });
        return;
    }

    // Upload a new logo
    if (reqPath === '/api/upload-logo' && req.method === 'POST') {
        const chunks = [];
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > 5 * 1024 * 1024) { req.destroy(); return; }
            chunks.push(chunk);
        });
        req.on('end', () => {
            try {
                const contentType = String(req.headers['content-type'] || '');
                let ext = 'png';
                if (contentType.includes('jpeg')) ext = 'jpg';
                else if (contentType.includes('webp')) ext = 'webp';
                else if (contentType.includes('gif')) ext = 'gif';
                const buf = Buffer.concat(chunks);
                if (buf.length === 0) throw new Error('Empty file');
                const current = resolveLogoFile();
                if (current && path.basename(current) === 'logo.png') {
                    fs.copyFileSync(current, path.join(__dirname, 'logo-old-backup.png'));
                }
                ['png', 'jpg', 'jpeg', 'webp', 'gif'].forEach(e => {
                    const f = path.join(__dirname, `logo.${e}`);
                    if (fs.existsSync(f) && `logo.${e}` !== `logo.${ext}`) fs.unlinkSync(f);
                });
                fs.writeFileSync(path.join(__dirname, `logo.${ext}`), buf);
                console.log(`🖼️ Logo uploaded & saved as logo.${ext}`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, message: 'Logo uploaded!', ext }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: e.message || 'Upload failed' }));
            }
        });
        return;
    }

    // NTP / accurate time (not Windows taskbar clock)
    if (req.url === '/api/ntp-time' && req.method === 'GET') {
        const localReceivedAt = Date.now();
        getAccurateUtcMs()
            .then(({ utcMs, rttMs, source }) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    utcMs: Math.round(utcMs),
                    serverLocalMs: Date.now(),
                    offsetMs: Math.round(utcMs - Date.now()),
                    rttMs,
                    source,
                    timezone: 'Africa/Cairo',
                    localReceivedAt
                }));
            })
            .catch((e) => {
                res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error: e.message || 'NTP sync failed',
                    // last resort: server clock (labeled so UI can warn)
                    utcMs: Date.now(),
                    offsetMs: 0,
                    source: 'local-fallback',
                    timezone: 'Africa/Cairo'
                }));
            });
        return;
    }

    // Console window size control — disabled for AV safety (was user32 SetWindowPos via PowerShell).
    if (reqPath === '/api/console-size' && req.method === 'POST') {
        res.writeHead(501, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'console-size disabled for AV safety' }));
        return;
    }

    // Load config
    if (req.url === '/api/config' && req.method === 'GET') {
        const config = loadConfig();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(config));
        return;
    }
    
    // Save config
    if (req.url === '/api/config' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const config = JSON.parse(body);
                const saved = saveConfig(config);
                const updated = updateBotFile(config);
                
                if (saved && updated) {
                    console.log('✅ Configuration saved and bot file updated!');
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, message: 'Configuration saved!' }));
                } else {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: 'Error saving configuration' }));
                }
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Invalid request' }));
            }
        });
        return;
    }
    
    // Get accounts
    if (req.url === '/api/accounts' && req.method === 'GET') {
        stampCaughtHistory(loadAppointmentRecords());
        const accounts = loadAccounts();
        // foundAt = locked out of checking until استرجاع.
        // caughtAt / foundAppointment = "حسابات لقطت مواعيد" history (kept if the main banner is deleted).
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(accounts));
        return;
    }
    
    // Save accounts
    if (req.url === '/api/accounts' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const accounts = JSON.parse(body);
                const saved = saveAccounts(accounts);
                
                if (saved) {
                    console.log('✅ Accounts saved!');
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                } else {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false }));
                }
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false }));
            }
        });
        return;
    }

    // Fake/test accounts (separate from production accounts.json)
    if (req.url === '/api/fake-accounts' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(loadFakeAccounts()));
        return;
    }

    if (req.url === '/api/fake-accounts' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const accounts = JSON.parse(body);
                const saved = saveFakeAccounts(accounts);
                if (saved) {
                    console.log('✅ Fake accounts saved!');
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                } else {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false }));
                }
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }
    
    // Get bot status
    if (req.url === '/api/bot-status' && req.method === 'GET') {
        const status = loadBotStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status));
        return;
    }

    // Manual visa-ID audit vs Almaviva list/web (does NOT change bot speed or maps)
    if (req.url === '/api/visa-ids/check' && req.method === 'POST') {
        (async () => {
            try {
                const result = await runVisaIdCheck();
                console.log(`🛂 Visa ID check: match=${result.summary.matchCount} mismatch=${result.summary.mismatchCount} missing=${result.summary.missingCount} unknown=${result.summary.unknownCount}`);
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify(result));
            } catch (e) {
                console.error('❌ /api/visa-ids/check failed:', e.message);
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: false, message: e.message || 'فشل الكشف' }));
            }
        })();
        return;
    }

    // Live log windows (open bot processes with heartbeat)
    if (req.url === '/api/live-windows' && req.method === 'GET') {
        try {
            const liveDir = path.join(__dirname, '.bot-launch', 'live');
            const now = Date.now();
            const staleMs = 6000;
            const windows = [];
            if (fs.existsSync(liveDir)) {
                for (const name of fs.readdirSync(liveDir)) {
                    if (!name.endsWith('.json')) continue;
                    try {
                        const raw = JSON.parse(fs.readFileSync(path.join(liveDir, name), 'utf8'));
                        const lastBeat = Number(raw.lastBeat) || 0;
                        if (now - lastBeat > staleMs) {
                            try { fs.unlinkSync(path.join(liveDir, name)); } catch (_) {}
                            continue;
                        }
                        windows.push({
                            winId: raw.winId || name.replace(/\.json$/i, ''),
                            office: raw.office || '',
                            visa: raw.visa || '',
                            scheduledCheckTime: raw.scheduledCheckTime || '',
                            enableScheduledCheck: !!raw.enableScheduledCheck,
                            mode: raw.mode || '',
                            accounts: raw.accounts || 0,
                            status: raw.status || 'running',
                            raceQuiet: !!raw.raceQuiet,
                            latency: raw.latency || null,
                            pid: raw.pid || null,
                            lastBeat
                        });
                    } catch (_) {}
                }
            }
            windows.sort((a, b) => String(a.winId).localeCompare(String(b.winId)));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, count: windows.length, windows }));
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, count: 0, windows: [], error: e.message }));
        }
        return;
    }

    // Change check time for one open log window (keeps window open → bot re-logins)
    if (req.url === '/api/live-windows/reschedule' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            try {
                const data = JSON.parse(body || '{}');
                const winId = String(data.winId || '').trim();
                const scheduledCheckTime = String(data.scheduledCheckTime || '').trim();
                const timeOk = /^([0-1]?\d|2[0-3]):([0-5]\d):([0-5]\d)(\.\d{1,3})?$/.test(scheduledCheckTime);
                if (!winId || !timeOk) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        success: false,
                        message: 'winId ووقت بصيغة HH:MM:SS أو HH:MM:SS.mmm مطلوبين'
                    }));
                    return;
                }
                const liveFile = path.join(__dirname, '.bot-launch', 'live', `${winId}.json`);
                if (!fs.existsSync(liveFile)) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: `اللوج ${winId} مش ظاهر (مقفول أو انقطع)` }));
                    return;
                }
                const cmdDir = path.join(__dirname, '.bot-launch', 'commands');
                fs.mkdirSync(cmdDir, { recursive: true });
                fs.writeFileSync(
                    path.join(cmdDir, `${winId}.json`),
                    JSON.stringify({
                        action: 'reschedule',
                        scheduledCheckTime,
                        at: Date.now()
                    }, null, 2),
                    'utf8'
                );
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    message: `تم إرسال الوقت الجديد ${scheduledCheckTime} لـ ${winId}`
                }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: e.message || 'فشل إعادة الجدولة' }));
            }
        });
        return;
    }
    
    // Get rate limited accounts
    if (req.url === '/api/rate-limited' && req.method === 'GET') {
        try {
            if (fs.existsSync(RATE_LIMITED_FILE)) {
                const data = JSON.parse(fs.readFileSync(RATE_LIMITED_FILE, 'utf8'));
                const config = loadConfig();
                const cooldownMs = (config.rateLimitCooldown || 60) * 60000;
                const now = Date.now();
                
                // Add remaining time to each account
                const accountsWithTime = Object.entries(data).map(([email, info]) => {
                    const timeSinceBan = now - info.timestamp;
                    const remainingMs = cooldownMs - timeSinceBan;
                    const remainingMinutes = Math.ceil(remainingMs / 60000);
                    
                    return {
                        email,
                        ip: info.ip,
                        timestamp: info.timestamp,
                        dateTime: info.dateTime,
                        remainingMinutes: Math.max(0, remainingMinutes),
                        expired: remainingMs <= 0
                    };
                });
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ accounts: accountsWithTime, count: accountsWithTime.length }));
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ accounts: [], count: 0 }));
            }
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ accounts: [], count: 0, error: e.message }));
        }
        return;
    }
    
    // Get bot logs
    if (req.url === '/api/logs' && req.method === 'GET') {
        try {
            if (fs.existsSync(BOT_LOGS_FILE)) {
                const logs = fs.readFileSync(BOT_LOGS_FILE, 'utf8');
                const logLines = logs.split('\n').filter(line => line.trim()).slice(-200);
                
                // Extract IPs from logs
                let realIP = null;
                let proxyIP = null;
                
                // Search from end to get most recent IPs
                for (let i = logLines.length - 1; i >= 0; i--) {
                    const line = logLines[i];
                    
                    // Look for "Current IP:" (real IP without proxy)
                    if (!realIP && line.includes('Current IP:')) {
                        const match = line.match(/Current IP:\s*([\d.]+)/);
                        if (match) realIP = match[1];
                    }
                    
                    // Look for "Proxy IP:" or "New IP:" (proxy IP)
                    if (!proxyIP && (line.includes('Proxy IP:') || line.includes('New IP:'))) {
                        const match = line.match(/(?:Proxy IP|New IP):\s*([\d.]+)/);
                        if (match) proxyIP = match[1];
                    }
                    
                    // Stop if we found both
                    if (realIP && proxyIP) break;
                }
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    logs: logLines,
                    realIP: realIP,
                    proxyIP: proxyIP
                }));
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ logs: [], realIP: null, proxyIP: null }));
            }
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ logs: [], realIP: null, proxyIP: null }));
        }
        return;
    }
    
    // Get appointment/payment status
    if (req.url === '/api/appointment-status' && req.method === 'GET') {
        try {
            if (fs.existsSync(APPOINTMENT_FILE)) {
                const data = JSON.parse(fs.readFileSync(APPOINTMENT_FILE, 'utf8'));
                // Support both formats: array or single object
                const appointments = Array.isArray(data) ? data : (data.account ? [data] : []);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ appointments, count: appointments.length }));
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ appointments: [], count: 0 }));
            }
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ appointments: [], count: 0, error: e.message }));
        }
        return;
    }
    
    // Clear appointments (for resetting when UI is reloaded)
    if (req.url === '/api/clear-appointments' && req.method === 'POST') {
        try {
            stampCaughtHistory(loadAppointmentRecords());
            if (fs.existsSync(APPOINTMENT_FILE)) {
                fs.unlinkSync(APPOINTMENT_FILE);
                log('✅ Cleared all appointments');
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Appointments cleared' }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }
    
    // Delete specific appointment by account email
    if (req.url === '/api/delete-appointment' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { account } = JSON.parse(body);
                
                if (!account) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: 'Account email required' }));
                    return;
                }
                
                if (fs.existsSync(APPOINTMENT_FILE)) {
                    const data = JSON.parse(fs.readFileSync(APPOINTMENT_FILE, 'utf8'));
                    let appointments = Array.isArray(data) ? data : (data.account ? [data] : []);
                    const removing = appointments.filter(apt => apt.account === account);
                    stampCaughtHistory(removing);

                    // Filter out the appointment
                    const filteredAppointments = appointments.filter(apt => apt.account !== account);
                    
                    if (filteredAppointments.length === appointments.length) {
                        res.writeHead(404, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, message: 'Appointment not found' }));
                        return;
                    }
                    
                    // Save updated list or delete file if empty
                    if (filteredAppointments.length > 0) {
                        fs.writeFileSync(APPOINTMENT_FILE, JSON.stringify(filteredAppointments, null, 2), 'utf8');
                    } else {
                        fs.unlinkSync(APPOINTMENT_FILE);
                    }
                    
                    log(`✅ Deleted appointment for ${account}`);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, message: 'Appointment deleted', remaining: filteredAppointments.length }));
                } else {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: 'No appointments file found' }));
                }
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    // Restore a found account (clear foundAt so it goes back to active list)
    if (req.url === '/api/restore-account' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { account } = JSON.parse(body);
                if (!account) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: 'Account email required' }));
                    return;
                }
                if (!fs.existsSync(ACCOUNTS_FILE)) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: 'No accounts file found' }));
                    return;
                }
                const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
                const entry = accounts.find(a => a.email === account);
                if (!entry) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: 'Account not found' }));
                    return;
                }
                delete entry.foundAt;
                delete entry.foundAppointment;
                delete entry.caughtAt;
                fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf8');

                // Keep appointment-found.json intact — the main banner is separate.
                // This section disappears on استرجاع because foundAt is cleared.

                console.log(`🔄 Restored account ${account} — back on active list`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, message: 'Account restored to active list' }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    // Bot windows POST Telegram here (manager process sends to Telegram API)
    if (req.url === '/api/telegram/notify' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const payload = body ? JSON.parse(body) : {};
                const { sendTelegramNotification } = await import('./telegram-notifier.js');
                const ok = await sendTelegramNotification({ ...payload, _viaNotifyApi: true });
                res.writeHead(ok ? 200 : 502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: !!ok }));
            } catch (e) {
                console.error('❌ /api/telegram/notify failed:', e.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    // Test telegram connection
    if (req.url === '/api/telegram/test' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const payload = body ? JSON.parse(body) : {};
                const savedConfig = loadConfig();
                const telegramConfig = {
                    enabled: true,
                    botToken: payload.botToken || (savedConfig.telegram && savedConfig.telegram.botToken) || '',
                    channels: Array.isArray(payload.channels)
                        ? payload.channels
                        : ((savedConfig.telegram && savedConfig.telegram.channels) || []),
                    chatId: payload.chatId || (savedConfig.telegram && savedConfig.telegram.chatId) || '',
                    messageLines: Array.isArray(payload.messageLines)
                        ? payload.messageLines
                        : ((savedConfig.telegram && savedConfig.telegram.messageLines) || []),
                    testMessage: typeof payload.testMessage === 'string'
                        ? payload.testMessage
                        : ((savedConfig.telegram && savedConfig.telegram.testMessage) || '')
                };

                if (!telegramConfig.botToken && (!telegramConfig.channels || telegramConfig.channels.length === 0) && !telegramConfig.chatId) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Bot token and at least one chat ID are required' }));
                    return;
                }

                const { testTelegramConnection } = await import('./telegram-notifier.js');
                const result = await testTelegramConnection(telegramConfig);

                if (result) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, message: 'Test message sent successfully' }));
                } else {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Failed to send test message' }));
                }
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    // Start bot — per-account windows if enablePerAccountStartTime, else one window per office+visa
    if (req.url === '/api/start' && req.method === 'POST') {
        try {
            fs.writeFileSync(BOT_LOGS_FILE, '', 'utf8');
        } catch (e) {}
        
        const config = loadConfig();
        const botFile = 'visa-bot-api-multi-account-FIXED.js';
        const isFakeProbe = config.sequentialAggressiveFakeMode?.enabled === true;
        const accounts = isFakeProbe ? loadFakeAccounts() : loadAccounts();
        const lockedFoundCount = isFakeProbe
            ? 0
            : accounts.filter(acc => acc.enabled !== false && acc.foundAt).length;
        const enabledAccounts = isFakeProbe
            ? accounts.filter(acc => acc.enabled === true)
            : accounts.filter(acc => acc.enabled !== false && !acc.foundAt);
        
        if (enabledAccounts.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                message: isFakeProbe
                    ? 'لا توجد حسابات فيك مفعّلة — أضف/فعّل من تاب تيست/فيك'
                    : (lockedFoundCount > 0
                    ? 'الحسابات اللي لقطت مواعيد متفصلة عن التشييك الجديد — اعمل استرجاع لو عايز تشيكها تاني'
                    : 'No enabled accounts found!')
            }));
            return;
        }

        if (!isFakeProbe) {
        const missingVisa = enabledAccounts.filter(acc => {
            const types = Array.isArray(acc.enabledVisaTypes) ? acc.enabledVisaTypes : [];
            return types.length === 0 || !String(types[0] || '').trim();
        });
        if (missingVisa.length > 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                message: `${missingVisa.length} حساب مفعل من غير نوع فيزا — حدّد نوع الفيزا جنب كل حساب`
            }));
            return;
        }
        }

        // Group by office + primary visa → one console/log window per group
        // مثال معطّل: ضم قاهرة / ضم إسكندرية / سياحة قاهرة / سياحة إسكندرية = 4 نوافذ
        // لو groupByVisaOnly مفعّل → نافذة لوج واحدة لكل فيزا (حسابات كل المراكز في نفس البروسس، بدون BOT_OFFICE)
        // مهم: كل حساب يفضل يفحص office بتاعه من accounts.json — مش معناه فحص كل المراكز لكل حساب
        // لو وقت البدأ لكل حساب مفعّل → نافذة لوج منفصلة لكل حساب
        const perAccountWindows = !isFakeProbe && config.enablePerAccountStartTime === true;
        const groupByVisaOnly = !isFakeProbe && config.groupByVisaOnly === true;
        const launchJobs = [];

        if (isFakeProbe) {
            // Single process — multi visa/office handled inside the runner
            launchJobs.push({
                kind: 'group',
                office: '',
                visaType: '',
                accounts: enabledAccounts,
                fakeProbe: true
            });
        } else if (perAccountWindows) {
            for (let i = 0; i < accounts.length; i++) {
                const acc = accounts[i];
                if (acc.enabled === false) continue;
                if (acc.foundAt) continue;
                const office = (acc.office === 'Alexandria') ? 'Alexandria' : 'Cairo';
                const visaType = String(acc.enabledVisaTypes[0]).trim();
                launchJobs.push({
                    kind: 'account',
                    index: i,
                    email: acc.email || `account-${i}`,
                    office,
                    visaType
                });
            }
        } else if (groupByVisaOnly) {
            const byVisa = new Map();
            for (const acc of enabledAccounts) {
                const visaType = String(acc.enabledVisaTypes[0]).trim();
                if (!byVisa.has(visaType)) byVisa.set(visaType, { visaType, office: '', accounts: [] });
                byVisa.get(visaType).accounts.push(acc);
            }
            for (const g of byVisa.values()) {
                launchJobs.push({
                    kind: 'group',
                    office: '',
                    visaType: g.visaType,
                    accounts: g.accounts
                });
            }
        } else {
            const byGroup = new Map();
            for (const acc of enabledAccounts) {
                const office = (acc.office === 'Alexandria') ? 'Alexandria' : 'Cairo';
                const visaType = String(acc.enabledVisaTypes[0]).trim();
                const groupKey = `${office}||${visaType}`;
                if (!byGroup.has(groupKey)) byGroup.set(groupKey, { office, visaType, accounts: [] });
                byGroup.get(groupKey).accounts.push(acc);
            }
            for (const g of byGroup.values()) {
                launchJobs.push({
                    kind: 'group',
                    office: g.office,
                    visaType: g.visaType,
                    accounts: g.accounts
                });
            }
        }

        const started = [];
        const launchDir = path.join(__dirname, '.bot-launch');
        const configuredSlots = Math.max(1, Math.min(40, parseInt(config.logWindowLayout?.slots, 10) || 10));
        const tilingOn = config.logWindowLayout?.enabled !== false;

        try { fs.mkdirSync(launchDir, { recursive: true }); } catch (_) {}
        // AV-safe: only drop user32 tiling scripts when explicitly opted in.
        if (process.env.BOT_TILE_WINDOWS === '1') {
            try { fs.writeFileSync(path.join(launchDir, 'tile-all-log-windows.ps1'), TILE_ALL_LOG_WINDOWS_PS1, 'utf8'); } catch (_) {}
            try { fs.writeFileSync(path.join(launchDir, 'count-log-windows.ps1'), COUNT_LOG_WINDOWS_PS1, 'utf8'); } catch (_) {}
            try { fs.writeFileSync(path.join(launchDir, 'list-log-windows.ps1'), LIST_LOG_WINDOWS_PS1, 'utf8'); } catch (_) {}
        }
        const countNeedles = [];
        const allEmails = [];
        for (const acc of accounts) {
            const email = String(acc.email || '').trim();
            if (!email) continue;
            allEmails.push(email);
            countNeedles.push(email);
            countNeedles.push(email.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 40));
            const vt = String(acc.visaType || acc.visa || '').trim();
            if (vt) countNeedles.push(vt);
            const officeName = String(acc.office || acc.officeName || '').trim();
            if (/alex|اسكندر/i.test(officeName)) countNeedles.push('الإسكندرية');
            else if (/cairo|قاهر/i.test(officeName)) countNeedles.push('القاهرة');
        }
        countNeedles.push('WID', 'BotLog', 'Aggressive', 'Seq9AM', 'SeqAgg', 'SeqPar9AM', 'RoundRobin');
        try {
            fs.writeFileSync(
                path.join(launchDir, 'count-needles.txt'),
                [...new Set(countNeedles.filter(Boolean))].join('\n'),
                'utf8'
            );
        } catch (_) {}

        // امسح launchers قديمة من جذر المشروع + مجلد .bot-launch
        try {
            for (const name of fs.readdirSync(__dirname)) {
                if (/^run_visa_.*\.cmd$/i.test(name) || /^\._run_visa_.*\.cmd$/i.test(name)) {
                    try { fs.unlinkSync(path.join(__dirname, name)); } catch (_) {}
                }
            }
            for (const name of fs.readdirSync(launchDir)) {
                if (/\.cmd$/i.test(name)) {
                    try { fs.unlinkSync(path.join(launchDir, name)); } catch (_) {}
                }
            }
        } catch (_) {}

        const modeTitleAscii = (() => {
            if (config.sequentialMode?.enabled) return 'Seq9AM';
            if (config.sequentialParallelMode9?.enabled) return 'SeqPar9AM';
            if (config.sequentialMode2?.enabled) return 'Seq';
            if (config.sequentialAggressiveFakeMode?.enabled) return 'FakeProbe';
            if (config.sequentialAggressivePlusMode?.enabled) return 'SeqAggPlus';
            if (config.sequentialAggressiveMode?.enabled) return 'SeqAgg';
            if (config.parallelRoundRobinMode?.enabled) return 'RR';
            if (config.enableRoundRobin) return 'RR';
            if (config.aggressiveMode?.enabled) return 'Aggressive';
            return 'Parallel';
        })();

        const wtPath = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'wt.exe');
        const useWt = fs.existsSync(wtPath);

        const workArea = getScreenWorkArea();
        const { cols: winCols, rows: winRows } = logWindowGrid(configuredSlots, workArea);
        const cellW = Math.max(1, Math.floor(workArea.width / winCols));
        const cellH = Math.max(1, Math.floor(workArea.height / winRows));
        const wtCharCols = Math.max(16, Math.floor(cellW / 9));
        const wtCharRows = Math.max(8, Math.floor(cellH / 20));
        const occupiedSlots = tilingOn ? countBotLogWindows(launchDir) : 0;
        const seqStart = takeWinSeq(launchDir, launchJobs.length);
        const tileIds = [];
        console.log(tilingOn
            ? `📐 Log cell grid ${winCols}x${winRows} | already open ${occupiedSlots} | new logs ${launchJobs.length}`
            : `📐 Log window tiling OFF — opening ${launchJobs.length} window(s) without grid`);

        (async () => {
            try {
                for (let jobIndex = 0; jobIndex < launchJobs.length; jobIndex++) {
                    const job = launchJobs[jobIndex];
                    const office = job.office;
                    const visaType = job.visaType;
                    const safeVisa = visaType.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '') || 'visa';
                    const safeOffice = office.replace(/[^a-zA-Z0-9]+/g, '_');
                    const officeEsc = String(office).replace(/"/g, '');
                    const visaEsc = String(visaType).replace(/"/g, '');

                    const slotIndex = occupiedSlots + jobIndex;
                    const winId = `WID${String(seqStart + jobIndex).padStart(4, '0')}`;
                    let batName;
                    let nodeCmd;

                    const cityAr = /alex|اسكندر/i.test(String(office || ''))
                        ? 'الإسكندرية'
                        : (/cairo|قاهر/i.test(String(office || '')) ? 'القاهرة' : '');
                    const visaLabel = job.fakeProbe
                        ? 'تيست-فيك'
                        : String(visaType || safeVisa || 'visa').trim();
                    const winTitle = `${winId} ${[visaLabel, cityAr].filter(Boolean).join(' - ')}`.trim().slice(0, 80);

                    if (job.kind === 'account') {
                        // بدون @ في اسم الملف — بيخلّص أوامر cmd
                        const safeEmail = String(job.email).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 40);
                        batName = `acc_${job.index}_${safeEmail}.cmd`;
                        nodeCmd = `node "%~dp0..\\${botFile}" --single-account=${job.index}`;
                    } else if (job.fakeProbe) {
                        batName = `FAKE_PROBE.cmd`;
                        nodeCmd = `node "%~dp0..\\${botFile}"`;
                    } else {
                        batName = safeOffice
                            ? `${safeOffice}_${safeVisa}.cmd`
                            : `ALL_${safeVisa}.cmd`;
                        nodeCmd = `node "%~dp0..\\${botFile}"`;
                    }

                    const batPath = path.join(launchDir, batName);

                    // مهم: مفيش مسار عربي جوّه الملف — %~dp0 بيتحل وقت التشغيل (يونيكود سليم)
                    // لو groupByVisaOnly (office فاضية) → مفيش BOT_OFFICE = نافذة واحدة تجمع حسابات كل المكاتب لنفس الفيزا
                    // (كل حساب لسه يفحص مركزه من accounts.json)
                    const officeLine = officeEsc
                        ? `set "BOT_OFFICE=${officeEsc}"`
                        : `rem BOT_OFFICE empty → one log for this visa across offices (per-account office still used)`;
                    const visaLine = job.fakeProbe
                        ? `rem FAKE_PROBE — no BOT_VISA_TYPE filter (multi visa inside runner)`
                        : `set "BOT_VISA_TYPE=${visaEsc}"`;
                    const batBody = [
                        '@echo off',
                        'chcp 65001 >nul',
                        `title ${winTitle}`,
                        'cd /d "%~dp0.."',
                        `set "BOT_WIN_ID=${winId}"`,
                        `set "BOT_OWNER=${String(process.env.BOT_OWNER || persistBotOwner() || '').replace(/"/g, '')}"`,
                        officeLine,
                        visaLine,
                        nodeCmd,
                        'echo.',
                        'echo ========================================',
                        'echo Bot finished — log window stays open',
                        'echo Press any key to close this window',
                        'echo ========================================',
                        // <con = كونسول حقيقي (stdin من spawn بيخلي pause يتعدّى والنافذة تقفل)
                        'pause <con >nul'
                    ].join('\r\n');
                    fs.writeFileSync(batPath, batBody, 'utf8');
                    tileIds.push(`${winId}\t${slotIndex}`);

                    const col = slotIndex % winCols;
                    const row = Math.floor(slotIndex / winCols);
                    const posX = workArea.left + (col * cellW);
                    const posY = workArea.top + (row * cellH);
                    let botProcess;
                    if (useWt && tilingOn) {
                        botProcess = spawn(wtPath, [
                            '--pos', `${posX},${posY}`,
                            '--size', `${wtCharCols},${wtCharRows}`,
                            '-w', 'new',
                            'nt',
                            '--title', winTitle,
                            '--suppressApplicationTitle',
                            '-d', launchDir,
                            'cmd.exe', '/k', batName
                        ], {
                            detached: true,
                            stdio: 'ignore',
                            windowsHide: false
                        });
                    } else if (useWt) {
                        botProcess = spawn(wtPath, [
                            '-w', 'new',
                            'nt',
                            '--title', winTitle,
                            '--suppressApplicationTitle',
                            '-d', launchDir,
                            'cmd.exe', '/k', batName
                        ], {
                            detached: true,
                            stdio: 'ignore',
                            windowsHide: false
                        });
                    } else {
                        botProcess = spawn(process.env.ComSpec || 'cmd.exe', [
                            '/c', 'start', winTitle, 'cmd.exe', '/k', batName
                        ], {
                            cwd: launchDir,
                            detached: true,
                            stdio: 'ignore',
                            windowsHide: false
                        });
                    }
                    botProcess.on('error', (err) => {
                        const label = job.kind === 'account' ? job.email : `${office} | ${visaType}`;
                        console.error(`❌ Failed to open window for "${label}":`, err.message);
                    });
                    botProcess.unref();

                    if (job.kind === 'account') {
                        started.push({ office, visaType, email: job.email, accounts: 1 });
                        console.log(`🚀 Started log for account "${job.email}" → .bot-launch\\${batName}`);
                    } else {
                        started.push({ office, visaType, accounts: job.accounts.length });
                        console.log(`🚀 Started log for "${office} | ${visaType}" (${job.accounts.length} account(s)) → .bot-launch\\${batName}`);
                    }

                    await new Promise((r) => setTimeout(r, 200));
                }

                try {
                    writeTileIds(launchDir, tileIds);
                    if (tilingOn) {
                        await new Promise((r) => setTimeout(r, Math.min(8000, 800 + launchJobs.length * 150)));
                        runTileLogWindows(launchDir, winCols, winRows, cellW, cellH);
                        setTimeout(() => runTileLogWindows(launchDir, winCols, winRows, cellW, cellH), 3000);
                    }
                } catch (_) {}

                const summary = started.map(x =>
                    x.email ? `${x.email}` : `${x.office}/${x.visaType} (${x.accounts})`
                ).join(' | ');
                const message = perAccountWindows
                    ? `تم التشغيل: ${started.length} نافذة لوج (حساب لكل نافذة) — ${summary}`
                    : (started.length === 1
                        ? `تم التشغيل: نافذة واحدة لـ ${summary}`
                        : `تم التشغيل: ${started.length} نوافذ لوج — ${summary}`);

                try {
                    const { publishBotStrategy } = await import('./telegram-notifier.js');
                    await publishBotStrategy({
                        config,
                        windows: started,
                        perAccountWindows,
                        groupByVisaOnly
                    });
                } catch (_) {}

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    message,
                    windows: started,
                    perAccountWindows,
                    maxAccounts: config.maxAccounts,
                    logWindowLayout: { enabled: tilingOn, slots: configuredSlots, cols: winCols, rows: winRows }
                }));
            } catch (e) {
                if (!res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: e.message || 'Failed to start bot windows' }));
                }
            }
        })();
        return;
    }
    
    // ── WhatsApp routes (lazy-loaded whatsapp-notifier) ─────────────────────
    if (req.url && req.url.startsWith('/api/whatsapp/')) {
        const respond = (status, data) => {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
        };

        import('./whatsapp-notifier.js').then(async (wa) => {
            try {
                if (req.url === '/api/whatsapp/status' && req.method === 'GET') {
                    respond(200, { success: true, ...wa.getWhatsAppStatus() });
                    return;
                }

                if (req.url === '/api/whatsapp/connect' && req.method === 'POST') {
                    const result = await wa.startWhatsAppClient();
                    respond(200, { success: true, ...result });
                    return;
                }

                if (req.url === '/api/whatsapp/disconnect' && req.method === 'POST') {
                    const result = await wa.disconnectWhatsAppClient();
                    respond(200, { success: true, ...result });
                    return;
                }

                if (req.url === '/api/whatsapp/groups' && req.method === 'GET') {
                    const groups = await wa.listWhatsAppGroups();
                    respond(200, { success: true, groups });
                    return;
                }

                if (req.url === '/api/whatsapp/group' && req.method === 'POST') {
                    let body = '';
                    req.on('data', chunk => body += chunk);
                    req.on('end', async () => {
                        try {
                            const payload = body ? JSON.parse(body) : {};
                            if (!payload.chatId) {
                                respond(400, { success: false, error: 'chatId مطلوب' });
                                return;
                            }
                            const saved = wa.setWhatsAppGroup(payload.chatId, payload.chatName || '');
                            respond(200, { success: true, whatsapp: saved });
                        } catch (e) {
                            respond(500, { success: false, error: e.message });
                        }
                    });
                    return;
                }

                if (req.url === '/api/whatsapp/notify' && req.method === 'POST') {
                    let body = '';
                    req.on('data', chunk => body += chunk);
                    req.on('end', async () => {
                        try {
                            const payload = body ? JSON.parse(body) : {};
                            let status = wa.getWhatsAppStatus();
                            if (status.status !== 'ready') {
                                await wa.startWhatsAppClient();
                                const ready = await wa.waitForWhatsAppReady(25000);
                                status = wa.getWhatsAppStatus();
                                if (!ready) {
                                    const why = status.status === 'qr'
                                        ? 'امسح الـ QR من الواجهة الأول'
                                        : 'واتساب مش متصل — اضغط الاتصال في الواجهة واستنى علامة متصل';
                                    respond(500, { success: false, error: why });
                                    return;
                                }
                            }
                            payload._viaNotifyApi = true;
                            const sent = await wa.sendWhatsAppNotification(payload);
                            respond(sent ? 200 : 500, sent
                                ? { success: true }
                                : { success: false, error: 'فشل الإرسال — تأكد إن رقم Phone صحيح ومسجل واتساب' });
                        } catch (e) {
                            respond(500, { success: false, error: e.message });
                        }
                    });
                    return;
                }

                if (req.url === '/api/whatsapp/test' && req.method === 'POST') {
                    const sent = await wa.sendWhatsAppTestMessage();
                    respond(sent ? 200 : 500, sent
                        ? { success: true, message: 'تم إرسال رسالة الاختبار للجروب' }
                        : { success: false, error: 'فشل إرسال رسالة الاختبار — تأكد إن الواتساب متصل والجروب محدد' });
                    return;
                }

                if (req.url === '/api/whatsapp/owner' && req.method === 'POST') {
                    let body = '';
                    req.on('data', chunk => body += chunk);
                    req.on('end', () => {
                        try {
                            const cfg = loadConfig();
                            const payload = body ? JSON.parse(body) : {};
                            const waCfg = cfg.whatsapp = cfg.whatsapp || {};
                            if (payload.ownerNumbers !== undefined) {
                                waCfg.ownerNumbers = (Array.isArray(payload.ownerNumbers) ? payload.ownerNumbers : [])
                                    .map(n => String(n).replace(/\D/g, '')).filter(n => n.length > 5);
                            }
                            if (payload.remoteControlEnabled !== undefined) {
                                waCfg.remoteControl = waCfg.remoteControl || {};
                                waCfg.remoteControl.enabled = !!payload.remoteControlEnabled;
                            }
                            saveConfig(cfg);
                            respond(200, { success: true, whatsapp: waCfg });
                        } catch (e) {
                            respond(500, { success: false, error: e.message });
                        }
                    });
                    return;
                }

                respond(404, { success: false, error: 'Not found' });
            } catch (e) {
                respond(500, { success: false, error: e.message });
            }
        }).catch((e) => {
            respond(500, { success: false, error: 'فشل تحميل وحدات واتساب: ' + e.message });
        });
        return;
    }

    // Clear log file
    if (req.url === '/api/logs/clear' && req.method === 'POST') {
        try {
            fs.writeFileSync(BOT_LOGS_FILE, '', 'utf8');
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ success: true }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // SSE endpoint for live bot logs
    if (req.url === '/api/logs/stream' && req.method === 'GET') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });

        // Send last 200 lines first
        try {
            if (fs.existsSync(BOT_LOGS_FILE)) {
                const content = fs.readFileSync(BOT_LOGS_FILE, 'utf8');
                const lines = content.trim().split('\n').filter(Boolean).slice(-200);
                for (const line of lines) {
                    res.write(`data: ${JSON.stringify(line)}\n\n`);
                }
            }
        } catch (e) {}

        // Watch log file and send new lines
        let lastSize = 0;
        let cleared = false;
        try {
            if (fs.existsSync(BOT_LOGS_FILE)) {
                lastSize = fs.statSync(BOT_LOGS_FILE).size;
            }
        } catch (e) {}

        const interval = setInterval(() => {
            try {
                if (!fs.existsSync(BOT_LOGS_FILE)) return;
                const stat = fs.statSync(BOT_LOGS_FILE);
                // Detect if file was cleared (size smaller than last known)
                if (stat.size < lastSize) {
                    lastSize = 0;
                    cleared = true;
                }
                if (stat.size > lastSize) {
                    const fd = fs.openSync(BOT_LOGS_FILE, 'r');
                    const buf = Buffer.alloc(stat.size - lastSize);
                    fs.readSync(fd, buf, 0, buf.length, lastSize);
                    fs.closeSync(fd);
                    lastSize = stat.size;
                    const newLines = buf.toString('utf8').trim().split('\n').filter(Boolean);
                    for (const line of newLines) {
                        res.write(`data: ${JSON.stringify(line)}\n\n`);
                    }
                }
            } catch (e) {}
        }, 500);

        req.on('close', () => {
            clearInterval(interval);
        });
        return;
    }

    // 404
    res.writeHead(404);
    res.end('Not found');
});

server.listen(PORT, () => {
    console.log(`
========================================
🚀 Visa Bot API Manager

✅ Server running on: http://localhost:${PORT}

========================================
`);
    const sessionPath = path.join(__dirname, '.wwebjs_auth');
    if (fs.existsSync(sessionPath)) {
        setTimeout(() => {
            import('./whatsapp-notifier.js').then((wa) => {
                console.log('💬 Restoring WhatsApp session...');
                return wa.startWhatsAppClient();
            }).catch((e) => {
                console.log('⚠️ WhatsApp auto-connect skipped:', e?.message || e);
            });
        }, 2000);
    }
});

// المنفذ ثابت على 3004 — لو نسخة تانية شغالة، رسالة واضحة وخلاص
server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
        console.error(`
❌ المنفذ 3004 مشغول — في نسخة تانية شغالة بالفعل
   اقفل النسخة التانية الأول أو افتح واجهتها من المتصفح: http://localhost:3004
`);
        process.exit(1);
    }
    console.error(`❌ Server error: ${err && err.code ? err.code : err}`);
    process.exit(1);
});
