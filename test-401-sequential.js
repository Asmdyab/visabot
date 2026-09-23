// test-401-sequential.js — can a SEQUENTIAL series on one reused H2 client trigger the
// "Missing dot delimiter(s)" 401 the matrix test saw once (D shot)?
// The bot fires strictly sequentially (await per slot), so this is the bot's exact pattern.
// 5 sequential /checks on ONE client + 3 on fresh clients, valid token, off-peak.
// Expect: all 200s. Any delimiter-error 401 = transport bug the bot can also hit.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Impit } from 'impit';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const EMAIL = (process.argv[2] || 'mahmoud.0505p@gmail.com').toLowerCase();
const CHECKS = 'https://egyapi.almaviva-visa.it/reservation-manager/api/planning/v1/checks?officeId=1&visaId=19&serviceLevelId=1';
const TOKEN_URL = 'https://egyiam.almaviva-visa.it/realms/oauth2-visaSystem-realm-pkce/protocol/openid-connect/token';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const SPOOF = '41.32.55.10';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

async function one(client, label, token) {
  const t0 = Date.now();
  try {
    const res = await client.fetch(CHECKS, { method: 'GET', headers: headers(token) });
    console.log(JSON.stringify({ shot: label, status: res.status, ms: Date.now() - t0, www: res.headers.get('www-authenticate') || null }));
    return res.status;
  } catch (e) { console.log(JSON.stringify({ shot: label, error: String(e.message).slice(0, 60) })); return 0; }
}

(async () => {
  const lb = new URLSearchParams({ grant_type: 'password', client_id: 'aa-visasys-public', username: account.email, password: account.password, scope: 'openid profile email' }).toString();
  const lr = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, Accept: 'application/json' }, body: lb });
  if (lr.status !== 200) { console.error('login failed', lr.status); process.exit(3); }
  const token = (await lr.json()).access_token;
  console.log(JSON.stringify({ login: 'ok' }));
  const shared = new Impit({ browser: 'chrome', ignoreTlsErrors: true, timeout: 30000, followRedirects: true });
  for (let i = 1; i <= 5; i++) {
    await one(shared, `SAME-CLIENT #${i}`, token);
    await sleep(1000);
  }
  for (let i = 1; i <= 3; i++) {
    const c = new Impit({ browser: 'chrome', ignoreTlsErrors: true, timeout: 30000, followRedirects: true });
    await one(c, `FRESH-CLIENT #${i}`, token);
    await sleep(1000);
  }
})();
