// test-burp-capture.cjs — fire /checks through Burp (127.0.0.1:8080) so the raw exchange
// (full request + response headers) lands in Burp's proxy history, then read via Burp MCP.
// Pattern mirrors the repo's burp-probe.cjs (node:https + HttpsProxyAgent, MITM CA accepted).
// Usage: node test-burp-capture.cjs [email] [count]     (Burp must listen on 127.0.0.1:8080)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const fs = require('fs');
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');

const EMAIL = (process.argv[2] || 'mahmoud.0505p@gmail.com').toLowerCase();
const COUNT = Math.min(10, Math.max(1, parseInt(process.argv[3], 10) || 3));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const CHECKS = 'https://egyapi.almaviva-visa.it/reservation-manager/api/planning/v1/checks?officeId=1&visaId=19&serviceLevelId=1';
const TOKEN_URL = 'https://egyiam.almaviva-visa.it/realms/oauth2-visaSystem-realm-pkce/protocol/openid-connect/token';
const SPOOF = '41.32.55.10';

const viaBurp = new HttpsProxyAgent('http://127.0.0.1:8080', { rejectUnauthorized: false, timeout: 30000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(url, { method = 'GET', headers = {}, body = null, agent = null } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const r = https.request(url, { method, agent, headers, timeout: 30000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode, ms: Date.now() - t0,
        headers: res.headers, body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

(async () => {
  const accs = JSON.parse(fs.readFileSync('accounts.json', 'utf8'));
  const acc = accs.find((a) => String(a.email).toLowerCase() === EMAIL);
  if (!acc) { console.log(JSON.stringify({ error: 'account not found' })); process.exit(2); }
  const loginBody = new URLSearchParams({
    grant_type: 'password', client_id: 'aa-visasys-public',
    username: acc.email, password: acc.password, scope: 'openid profile email'
  }).toString();
  const login = await req(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, Accept: 'application/json', 'Content-Length': Buffer.byteLength(loginBody) }
  });
  if (login.status !== 200) { console.log(JSON.stringify({ loginStatus: login.status, body: login.body.slice(0, 200) })); process.exit(3); }
  const tok = JSON.parse(login.body);
  console.log(JSON.stringify({ login: 'ok', ms: login.ms, exp: tok.expires_in, dots: tok.access_token.split('.').length - 1 }));

  const h = {
    Authorization: 'Bearer ' + tok.access_token,
    Accept: 'application/json, text/plain, */*', 'User-Agent': UA,
    'Accept-Language': 'en', Origin: 'https://egy.almaviva-visa.it',
    'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty',
    Referer: 'https://egy.almaviva-visa.it/',
    'X-Forwarded-For': SPOOF, 'X-Real-IP': SPOOF, 'CF-Connecting-IP': SPOOF
  };
  for (let i = 1; i <= COUNT; i++) {
    const t0 = Date.now();
    try {
      const res = await req(CHECKS, { headers: h, agent: viaBurp });
      console.log(JSON.stringify({
        n: i, status: res.status, ms: res.ms, at: new Date(t0).toTimeString().slice(0, 8),
        'www-authenticate': res.headers['www-authenticate'] || null,
        server: res.headers['server'] || null,
        'set-cookie': res.headers['set-cookie'] || null,
        body: res.body.slice(0, 120) || '<empty>'
      }));
    } catch (e) { console.log(JSON.stringify({ n: i, error: String(e.message).slice(0, 100) })); }
    if (i < COUNT) await sleep(1200);
  }
})().catch((e) => { console.log(JSON.stringify({ fatal: String((e && e.message) || e) })); process.exit(1); });
