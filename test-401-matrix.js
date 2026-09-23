// test-401-matrix.js — decisive transport test at the surge mark.
// Fires parallel /checks shots with the SAME valid token, at the same instant:
//   H2cold : fresh impit client (Chrome TLS/H2)      = exact copy of the bot's first slot
//   H2warm : impit client whose API connection was opened 2s earlier (HEAD API root)
//   H1     : node:https through Burp (HTTP/1.1) — lands in Burp proxy history for raw inspection
//   H2cold2: second request on the H2cold client 800ms later (same-connection recovery)
// If H2cold=401 while H2warm=200 at the same instant → new connections are shed → fix = open
// the API connection seconds before the burst. If H1=200 while H2*=401 → the shed is H2-specific
// → fix = fire over HTTP/1.1.
// Usage: node test-401-matrix.js <msUntilShots> [email]
import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';
import { Impit } from 'impit';
import { HttpsProxyAgent } from 'https-proxy-agent';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FIRE_IN_MS = Math.max(2000, parseInt(process.argv[2], 10) || 10000);
const EMAIL = (process.argv[3] || 'mahmoud.0505p@gmail.com').toLowerCase();
const CHECKS = 'https://egyapi.almaviva-visa.it/reservation-manager/api/planning/v1/checks?officeId=1&visaId=19&serviceLevelId=1';
const API_ROOT = 'https://egyapi.almaviva-visa.it/';
const TOKEN_URL = 'https://egyiam.almaviva-visa.it/realms/oauth2-visaSystem-realm-pkce/protocol/openid-connect/token';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const SPOOF = '41.32.55.10';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newImpit = () => new Impit({ browser: 'chrome', ignoreTlsErrors: true, timeout: 30000, followRedirects: true });
const accs = JSON.parse(fs.readFileSync(path.join(DIR, 'accounts.json'), 'utf8'));
const account = accs.find((a) => String(a.email).toLowerCase() === EMAIL);
if (!account) { console.error('account not found'); process.exit(2); }

function headers(token) {
  return {
    'Host': 'egyapi.almaviva-visa.it', 'Authorization': `Bearer ${token}`,
    'Accept': 'application/json, text/plain, */*', 'User-Agent': UA,
    'Accept-Language': 'en', 'Origin': 'https://egy.almaviva-visa.it',
    'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty',
    'Referer': 'https://egy.almaviva-visa.it/', 'Accept-Encoding': 'gzip, deflate, br',
    'Priority': 'u=1, i', 'Sec-Ch-Ua': '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
    'Sec-Ch-Ua-Platform': '"Windows"', 'Sec-Ch-Ua-Mobile': '?0',
    'X-Forwarded-For': SPOOF, 'X-Real-IP': SPOOF, 'CF-Connecting-IP': SPOOF
  };
}

async function impitShot(client, label, token) {
  const t0 = Date.now();
  try {
    const res = await client.fetch(CHECKS, { method: 'GET', headers: headers(token) });
    let body = '';
    try { body = ((await res.text()) || '').replace(/\s+/g, ' ').trim().slice(0, 80); } catch (_) {}
    console.log(JSON.stringify({ shot: label, via: 'H2-impit', status: res.status, ms: Date.now() - t0, www: res.headers.get('www-authenticate') || null, srv: res.headers.get('server') || null, body: body || '<empty>' }));
    return res.status;
  } catch (e) { console.log(JSON.stringify({ shot: label, error: String(e.message).slice(0, 80) })); return 0; }
}

function h1Shot(label, token) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const agent = new HttpsProxyAgent('http://127.0.0.1:8080', { rejectUnauthorized: false, timeout: 30000 });
    const r = https.request(CHECKS, { method: 'GET', agent, headers: headers(token), timeout: 30000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        console.log(JSON.stringify({ shot: label, via: 'H1-burp', status: res.statusCode, ms: Date.now() - t0, www: res.headers['www-authenticate'] || null, srv: res.headers['server'] || null, body: body.slice(0, 80) || '<empty>' }));
        resolve(res.statusCode);
      });
    });
    r.on('timeout', () => { r.destroy(); console.log(JSON.stringify({ shot: label, error: 'timeout' })); resolve(0); });
    r.on('error', (e) => { console.log(JSON.stringify({ shot: label, error: String(e.message).slice(0, 80) })); resolve(0); });
    r.end();
  });
}

(async () => {
  const fireAt = Date.now() + FIRE_IN_MS;
  const lb = new URLSearchParams({ grant_type: 'password', client_id: 'aa-visasys-public', username: account.email, password: account.password, scope: 'openid profile email' }).toString();
  const lr = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, Accept: 'application/json' }, body: lb });
  if (lr.status !== 200) { console.error('login failed', lr.status, (await lr.text()).slice(0, 120)); process.exit(3); }
  const token = (await lr.json()).access_token;
  console.log(JSON.stringify({ login: 'ok', expin: 900, tokLen: token.length, fireAt: new Date(fireAt).toTimeString().slice(0, 8) }));

  const h2cold = newImpit();
  const h2warm = newImpit();
  const waitWarm = fireAt - 2200 - Date.now();
  if (waitWarm > 0) await sleep(waitWarm);
  const tW = Date.now();
  await h2warm.fetch(API_ROOT, { method: 'HEAD', headers: { 'User-Agent': UA } });
  console.log(JSON.stringify({ warmHeadMs: Date.now() - tW }));
  const waitFire = fireAt - Date.now();
  if (waitFire > 0) await sleep(waitFire);
  await Promise.all([
    impitShot(h2cold, 'A-H2cold', token),
    impitShot(h2warm, 'B-H2warm(2s)', token),
    h1Shot('C-H1burp', token)
  ]);
  await sleep(800);
  await impitShot(h2cold, 'D-H2cold-again');
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
