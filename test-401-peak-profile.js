// test-401-peak-profile.js — is the peak 401 caused by NEW CONNECTIONS or by the clock?
//
// Already proven with a REAL, valid token (test-401-rootcause.js, 10:00 mark):
//   sent mark-5.0s → 401 (8.2s)   sent mark+3.5s → 401 (3.2s)
//   sent mark+6.7s → 200 (6.1s)   sent mark+27s  → 200 (0.3s)
// → a bare 401 (no WWW-Authenticate, no Server header, empty body, seconds of latency) is
//   issued at the edge while the mark surge lasts. The token is valid and the same client
//   succeeds moments later, so nothing about the token/headers is wrong.
//
// This run tests the one client-side factor left: whether the request rides a connection that
// was already established before the surge. Each tick fires a WARM shot (HEAD to the API root
// 1.5s earlier, same client) and a COLD shot (brand-new client) at the same instant.
//
// Usage: node test-401-peak-profile.js <msUntilFirstShot> [email]
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Impit } from 'impit';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FIRE_IN_MS = Math.max(2000, parseInt(process.argv[2], 10) || 30000);
const EMAIL = (process.argv[3] || 'mahmoud.0505p@gmail.com').toLowerCase();
const CHECKS_URL = 'https://egyapi.almaviva-visa.it/reservation-manager/api/planning/v1/checks?officeId=1&visaId=19&serviceLevelId=1';
const API_ROOT = 'https://egyapi.almaviva-visa.it/';
const HOME_URL = 'https://egy.almaviva-visa.it/';
const TOKEN_URL = 'https://egyiam.almaviva-visa.it/realms/oauth2-visaSystem-realm-pkce/protocol/openid-connect/token';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newClient = () => new Impit({ browser: 'chrome', ignoreTlsErrors: true, timeout: 30000, followRedirects: true });
const accounts = JSON.parse(fs.readFileSync(path.join(DIR, 'accounts.json'), 'utf8'));
const account = accounts.find((a) => String(a.email).toLowerCase() === EMAIL);
if (!account) { console.error(`account ${EMAIL} not found`); process.exit(2); }
let cookie = null;

function headers(token) {
  return {
    'Host': 'egyapi.almaviva-visa.it',
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json, text/plain, */*',
    'User-Agent': UA,
    'Accept-Language': 'en',
    'Origin': 'https://egy.almaviva-visa.it',
    'Sec-Fetch-Site': 'same-site',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    'Referer': 'https://egy.almaviva-visa.it/',
    'Accept-Encoding': 'gzip, deflate, br',
    'Priority': 'u=1, i',
    'Sec-Ch-Ua': '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Ch-Ua-Mobile': '?0',
    ...(cookie ? { 'Cookie': `cookiesession1=${cookie}` } : {})
  };
}

async function req(client, url, token, label) {
  const t0 = Date.now();
  let status = 0, note = '';
  try {
    const isHead = url === API_ROOT;
    const res = await client.fetch(url, { method: isHead ? 'HEAD' : 'GET', headers: isHead ? { 'User-Agent': UA } : headers(token) });
    status = res.status;
    note = String(res.headers.get('www-authenticate') || '') || String(res.headers.get('server') || '');
    const m = /cookiesession1=([A-Za-z0-9]+)/i.exec(String(res.headers.get('set-cookie') || ''));
    if (m) cookie = m[1];
  } catch (e) { note = 'ERR ' + String(e.message || e); }
  return { label, status, ms: Date.now() - t0, note };
}

const results = [];
async function pair(token, tag) {
  const w = newClient();   // WARM client: connection pre-exists
  const c = newClient();   // COLD client: brand-new connection
  await req(w, API_ROOT, token, 'warm-head');
  await sleep(1500);
  const [r1, r2] = await Promise.all([
    req(w, CHECKS_URL, token, `${tag} WARM`),
    req(c, CHECKS_URL, token, `${tag} COLD`)
  ]);
  results.push(r1, r2);
  for (const r of [r1, r2]) console.log(`  ${r.label.padEnd(14)} ${r.status} ${String(r.ms).padStart(5)}ms ${r.note ? '| ' + r.note : ''}`);
  return [r1, r2];
}
(async () => {
  const fireAt = Date.now() + FIRE_IN_MS;
  const body = new URLSearchParams({
    grant_type: 'password', client_id: 'aa-visasys-public',
    username: account.email, password: account.password, scope: 'openid profile email'
  }).toString();
  const lr = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, Accept: 'application/json' },
    body
  });
  if (lr.status !== 200) { console.error('login failed', lr.status, (await lr.text()).slice(0, 160)); process.exit(3); }
  const token = (await lr.json()).access_token;
  console.log(`login ok (${token.length} chars) | first tick at ${new Date(fireAt).toTimeString().slice(0, 8)}`);

  const warmAt = fireAt - 60000;
  if (warmAt > Date.now()) await sleep(warmAt - Date.now());
  await req(newClient(), HOME_URL, token, 'cookie');
  console.log(`cookie: ${cookie ? '...' + cookie.slice(-6) : 'NONE'}`);

  if (fireAt - 1600 > Date.now()) await sleep(fireAt - 1600 - Date.now());
  console.log('\n--- tick 1 (mark-5s: warm vs cold, same instant) ---');
  await pair(token, 'T1');

  await sleep(2000);
  console.log('\n--- tick 2 (mark-3s) ---');
  await pair(token, 'T2');

  await sleep(4000);
  console.log('\n--- tick 3 (mark+1s) ---');
  await pair(token, 'T3');

  await sleep(20000);
  console.log('\n--- tick 4 (off-peak control) ---');
  await pair(token, 'T4');

  const warm = results.filter((r) => r.label.includes('WARM'));
  const cold = results.filter((r) => r.label.includes('COLD'));
  const n401 = (a) => a.filter((r) => r.status === 401).length;
  console.log(`\n================ WARM ${n401(warm)}/${warm.length} 401 | COLD ${n401(cold)}/${cold.length} 401 ================`);
  if (n401(cold) > n401(warm)) {
    console.log('CONCLUSION: new connections are shed at the surge -> the fix is to fire /checks on a');
    console.log('connection opened just before the burst (warm the API origin seconds, not minutes, ahead).');
  } else if (n401(warm) === 0 && n401(cold) === 0) {
    console.log('CONCLUSION: no 401 this run - the surge was mild; re-run on a busier mark.');
  } else {
    console.log('CONCLUSION: warm and cold are shed alike -> it is the surge itself (platform capacity),');
    console.log('not the connection; keep the same-token retry as the safety net.');
  }
})();