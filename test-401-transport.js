// test-401-transport.js — is the "Missing dot delimiter(s)" 401 transport-specific?
// At one mark instant, fires the same /checks with the SAME valid token over 4 stacks:
//   A: impit fresh (H2, Chrome TLS)  = the bot's exact stack
//   B: impit fresh (H2), no spoof headers
//   C: undici direct (Node TLS, H1-capable)
//   D: node:https via Burp (H1) + raw capture in Burp history
// then A2 = same client as A, 800ms later. Watch which stack gets a delimiter-401.
// Usage: node test-401-transport.js <msUntilShots> [email]
import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';
import { Impit } from 'impit';
import { HttpsProxyAgent } from 'https-proxy-agent';
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
function h(token, spoof = true) {
  return {
    'Host': 'egyapi.almaviva-visa.it', 'Authorization': `Bearer ${token}`,
    'Accept': 'application/json, text/plain, */*', 'User-Agent': UA, 'Accept-Language': 'en',
    'Origin': 'https://egy.almaviva-visa.it', 'Sec-Fetch-Site': 'same-site',
    'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', 'Referer': 'https://egy.almaviva-visa.it/',
    'Accept-Encoding': 'gzip, deflate, br', 'Priority': 'u=1, i',
    'Sec-Ch-Ua': '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
    'Sec-Ch-Ua-Platform': '"Windows"', 'Sec-Ch-Ua-Mobile': '?0',
    ...(spoof ? { 'X-Forwarded-For': SPOOF, 'X-Real-IP': SPOOF, 'CF-Connecting-IP': SPOOF } : {})
  };
}
const out = (o) => console.log(JSON.stringify(o));
async function impitShot(client, label, token, spoof = true) {
  const t0 = Date.now();
  try {
    const r = await client.fetch(CHECKS, { method: 'GET', headers: h(token, spoof) });
    let b = ''; try { b = ((await r.text()) || '').slice(0, 60); } catch (_) {}
    out({ shot: label, via: 'impit-H2', status: r.status, ms: Date.now() - t0, www: r.headers.get('www-authenticate') || null, body: b || '<empty>' });
    return r.status;
  } catch (e) { out({ shot: label, via: 'impit-H2', error: String(e.message).slice(0, 60) }); return 0; }
}
async function undiciShot(label, token) {
  const t0 = Date.now();
  try {
    const disp = new UAgent({ headersTimeout: 25000, bodyTimeout: 25000, connect: { rejectUnauthorized: false } });
    const r = await ufetch(CHECKS, { method: 'GET', headers: h(token), dispatcher: disp });
    const b = (await r.text()).slice(0, 60);
    out({ shot: label, via: 'undici', status: r.status, ms: Date.now() - t0, www: r.headers.get('www-authenticate') || null, body: b || '<empty>' });
    return r.status;
  } catch (e) { out({ shot: label, via: 'undici', error: String(e.message).slice(0, 60) }); return 0; }
}
function h1Shot(label, token) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const agent = new HttpsProxyAgent('http://127.0.0.1:8080', { rejectUnauthorized: false, timeout: 25000 });
    const r = https.request(CHECKS, { method: 'GET', agent, headers: h(token), timeout: 25000 }, (res) => {
      const ch = [];
      res.on('data', (c) => ch.push(c));
      res.on('end', () => {
        out({ shot: label, via: 'H1-burp', status: res.statusCode, ms: Date.now() - t0, www: res.headers['www-authenticate'] || null, body: Buffer.concat(ch).toString('utf8').slice(0, 60) || '<empty>' });
        resolve(res.statusCode);
      });
    });
    r.on('timeout', () => { r.destroy(); out({ shot: label, error: 'timeout' }); resolve(0); });
    r.on('error', (e) => { out({ shot: label, error: String(e.message).slice(0, 60) }); resolve(0); });
    r.end();
  });
}
(async () => {
  const fireAt = Date.now() + FIRE_IN_MS;
  const lb = new URLSearchParams({ grant_type: 'password', client_id: 'aa-visasys-public', username: account.email, password: account.password, scope: 'openid profile email' }).toString();
  const lr = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, Accept: 'application/json' }, body: lb });
  if (lr.status !== 200) { console.error('login failed', lr.status); process.exit(3); }
  const token = (await lr.json()).access_token;
  out({ login: 'ok', fireAt: new Date(fireAt).toTimeString().slice(0, 8) });
  const cA = new Impit({ browser: 'chrome', ignoreTlsErrors: true, timeout: 30000, followRedirects: true });
  const cB = new Impit({ browser: 'chrome', ignoreTlsErrors: true, timeout: 30000, followRedirects: true });
  const w = fireAt - Date.now();
  if (w > 0) await sleep(w);
  await Promise.all([impitShot(cA, 'A-impit', token), impitShot(cB, 'B-impit-nospoof', token, false), undiciShot('C-undici', token), h1Shot('D-H1burp', token)]);
  await sleep(800);
  await impitShot(cA, 'A2-impit-again', token);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
