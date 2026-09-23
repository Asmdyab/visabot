// test-401-h1replication.js — replicate the transport result at the next mark.
// Round 1 (at mark-5s, all fresh, parallel): 2× impit-H2 + 2× undici-H1 (same valid token).
// Round 2 (+1s): the same warm H2 clients again + 1 fresh H1.
// If H2 → 401 and H1 → 200 again, the shed is transport-specific and the burst fix is
// to fire /checks over HTTP/1.1.
// Usage: node test-401-h1replication.js <msUntilRound1> [email]
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Impit } from 'impit';
import { fetch as ufetch, Agent as UAgent } from 'undici';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FIRE_IN_MS = Math.max(2000, parseInt(process.argv[2], 10) || 10000);
const EMAIL = (process.argv[3] || 'mahmoud.0505p@gmail.com').toLowerCase();
const CHECKS = 'https://egyapi.almaviva-visa.it/reservation-manager/api/planning/v1/checks?officeId=1&visaId=19&serviceLevelId=1';
const TOKEN_URL = 'https://egyiam.almaviva-visa.it/realms/oauth2-visaSystem-realm-pkce/protocol/openid-connect/token';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const SPOOF = '41.32.55.10';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const accs = JSON.parse(fs.readFileSync(path.join(DIR, 'accounts.json'), 'utf8'));
const account = accs.find((a) => String(a.email).toLowerCase() === EMAIL);
if (!account) { console.error('account not found'); process.exit(2); }
function h(token) {
  return {
    'Host': 'egyapi.almaviva-visa.it', 'Authorization': `Bearer ${token}`,
    'Accept': 'application/json, text/plain, */*', 'User-Agent': UA, 'Accept-Language': 'en',
    'Origin': 'https://egy.almaviva-visa.it', 'Sec-Fetch-Site': 'same-site',
    'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', 'Referer': 'https://egy.almaviva-visa.it/',
    'Accept-Encoding': 'gzip, deflate, br', 'Priority': 'u=1, i',
    'Sec-Ch-Ua': '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
    'Sec-Ch-Ua-Platform': '"Windows"', 'Sec-Ch-Ua-Mobile': '?0',
    'X-Forwarded-For': SPOOF, 'X-Real-IP': SPOOF, 'CF-Connecting-IP': SPOOF
  };
}
const out = (o) => console.log(JSON.stringify(o));
async function impitShot(client, label, token) {
  const t0 = Date.now();
  try {
    const r = await client.fetch(CHECKS, { method: 'GET', headers: h(token) });
    out({ shot: label, via: 'impit-H2', status: r.status, ms: Date.now() - t0, www: r.headers.get('www-authenticate') || null });
    return r.status;
  } catch (e) { out({ shot: label, via: 'impit-H2', error: String(e.message).slice(0, 60) }); return 0; }
}
async function undiciShot(label, token) {
  const t0 = Date.now();
  try {
    const disp = new UAgent({ headersTimeout: 25000, bodyTimeout: 25000, connect: { rejectUnauthorized: false } });
    const r = await ufetch(CHECKS, { method: 'GET', headers: h(token), dispatcher: disp });
    out({ shot: label, via: 'undici-H1', status: r.status, ms: Date.now() - t0, www: r.headers.get('www-authenticate') || null });
    return r.status;
  } catch (e) { out({ shot: label, via: 'undici', error: String(e.message).slice(0, 60) }); return 0; }
}
(async () => {
  const fireAt = Date.now() + FIRE_IN_MS;
  const lb = new URLSearchParams({ grant_type: 'password', client_id: 'aa-visasys-public', username: account.email, password: account.password, scope: 'openid profile email' }).toString();
  const lr = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, Accept: 'application/json' }, body: lb });
  if (lr.status !== 200) { console.error('login failed', lr.status); process.exit(3); }
  const token = (await lr.json()).access_token;
  out({ login: 'ok', fireAt: new Date(fireAt).toTimeString().slice(0, 8) });
  const h2a = new Impit({ browser: 'chrome', ignoreTlsErrors: true, timeout: 30000, followRedirects: true });
  const h2b = new Impit({ browser: 'chrome', ignoreTlsErrors: true, timeout: 30000, followRedirects: true });
  const w = fireAt - Date.now();
  if (w > 0) await sleep(w);
  console.log('--- round 1 (fresh, parallel) ---');
  await Promise.all([impitShot(h2a, 'R1-H2a', token), impitShot(h2b, 'R1-H2b', token), undiciShot('R1-H1a', token), undiciShot('R1-H1b', token)]);
  await sleep(1000);
  console.log('--- round 2 (+1s) ---');
  await Promise.all([impitShot(h2a, 'R2-H2a-warm', token), impitShot(h2b, 'R2-H2b-warm', token), undiciShot('R2-H1c', token)]);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
