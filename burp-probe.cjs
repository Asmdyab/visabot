// Burp-routed rate-limit probe (node:https + HttpsProxyAgent so Burp MITM CA is accepted)
// Usage: node burp-probe.cjs <email> <intervalMs> <count>
// TEST-ONLY: Burp re-signs TLS with its own CA, so verification is off for this probe.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const fs = require('fs');
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');

const agent = new HttpsProxyAgent('http://127.0.0.1:8080', { rejectUnauthorized: false, timeout: 30000 });
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const VISA_IDS = { 'Study Visa (C)': 9, 'Study Visa (D)': 8, 'Tourism Visa': 1, 'Business Visa': 5 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

(async () => {
  const [email, intervalMsRaw, countRaw] = process.argv.slice(2);
  const intervalMs = Math.max(500, parseInt(intervalMsRaw, 10) || 3000);
  const count = Math.min(45, Math.max(1, parseInt(countRaw, 10) || 20));
  const accs = JSON.parse(fs.readFileSync('accounts.json', 'utf8'));
  const acc = accs.find((a) => String(a.email).toLowerCase() === String(email).toLowerCase());
  if (!acc) { console.log(JSON.stringify({ error: 'account not found' })); process.exit(2); }
  const visaType = (acc.enabledVisaTypes && acc.enabledVisaTypes[0]) || 'Study Visa (C)';
  const visaId = VISA_IDS[visaType] || 9;
  const officeId = acc.office === 'Alexandria' ? 2 : 1;

  const loginBody = new URLSearchParams({
    grant_type: 'password', client_id: 'aa-visasys-public',
    username: acc.email, password: acc.password, scope: 'openid profile email',
  }).toString();
  const t0 = Date.now();
  const login = await req(
    'https://egyiam.almaviva-visa.it/realms/oauth2-visaSystem-realm-pkce/protocol/openid-connect/token',
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, Accept: 'application/json', 'Content-Length': Buffer.byteLength(loginBody) }, body: loginBody }
  );
  if (login.status !== 200) {
    console.log(JSON.stringify({ loginStatus: login.status, loginMs: login.ms, loginBody: login.body.slice(0, 200) }));
    process.exit(3);
  }
  const tok = JSON.parse(login.body);
  console.log(JSON.stringify({ login: 'ok', loginMs: Date.now() - t0, visaType, visaId, intervalMs, count }));

  const url = `https://egyapi.almaviva-visa.it/reservation-manager/api/planning/v1/checks?officeId=${officeId}&visaId=${visaId}&serviceLevelId=1`;
  let ok200 = 0, r429 = 0, other = 0;
  const start = Date.now();
  for (let i = 1; i <= count; i++) {
    const wait = start + (i - 1) * intervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    let status = -1, ms = 0, body = '';
    try {
      const res = await req(url, {
        headers: {
          Authorization: 'Bearer ' + tok.access_token,
          Accept: 'application/json, text/plain, */*', 'User-Agent': UA,
          'Accept-Language': 'en', Origin: 'https://egy.almaviva-visa.it',
          Referer: 'https://egy.almaviva-visa.it/',
        },
      });
      status = res.status; ms = res.ms; body = res.body.slice(0, 120);
    } catch (e) { body = 'ERR:' + String(e.message).slice(0, 80); }
    if (status === 200) ok200++; else if (status === 429) r429++; else other++;
    console.log(JSON.stringify({ n: i, status, ms, body, at: Math.round((Date.now() - start) / 100) / 10 + 's' }));
    if (r429 > 0) break;
  }
  console.log(JSON.stringify({ summary: true, ok200, r429, other, elapsedS: Math.round((Date.now() - start) / 100) / 10 }));
})().catch((e) => { console.log(JSON.stringify({ fatal: String((e && e.message) || e) })); process.exit(1); });
