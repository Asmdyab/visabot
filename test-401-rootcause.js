// test-401-rootcause.js — find WHY the first /checks of every burst answers 401.
//
// Measured bot behaviour (2026-09-17): every burst's FIRST shot (sent at windowStart, on a
// connection freshly opened to egyapi after the 5-min gap) gets `401 Unauthorized` with an
// EMPTY body, while the SAME token gets 200 a few seconds later on the warm connection:
//   09:49:55.000 → 401 @09:50:00.384 (issabotros)   |   09:50:09.651 → 200 (issabotros, same token)
//
// This script reproduces that shot with a REAL token and dumps the response headers, so the
// 401 can be attributed to a layer:
//   - WWW-Authenticate error_description  → which validation failed (delimiters / expired / key)
//   - Server / Set-Cookie                 → WAF/edge vs API
//
// Shots (all with the bot's exact /checks headers incl. cosmetics + WAF cookie + spoofed IP):
//   SHOT1  pre-warmed API connection, fired at the mark-window   (does warming the API origin fix it?)
//   SHOT2  COLD fresh connection, fired right after SHOT1        (bot replication)
//   SHOT3  SHOT2's connection again, ~1s later                   (warm control)
//   SHOT4  COLD fresh connection, ~15s after the mark            (cold but off-peak)
//
// Usage:  node test-401-rootcause.js <msUntilShot1> [email]
// Example: fire SHOT1 at 09:59:55 → node test-401-rootcause.js 60000
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Impit } from 'impit';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FIRE_IN_MS = Math.max(2000, parseInt(process.argv[2], 10) || 20000);
const EMAIL = (process.argv[3] || 'mahmoud.0505p@gmail.com').toLowerCase();

const CHECKS_URL = 'https://egyapi.almaviva-visa.it/reservation-manager/api/planning/v1/checks?officeId=1&visaId=19&serviceLevelId=1';
const API_ROOT = 'https://egyapi.almaviva-visa.it/';
const HOME_URL = 'https://egy.almaviva-visa.it/';
const TOKEN_URL = 'https://egyiam.almaviva-visa.it/realms/oauth2-visaSystem-realm-pkce/protocol/openid-connect/token';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const SPOOF_IP = '41.32.55.10'; // what ipHeaderMode:'same' puts in every header (per-account, stable)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function newClient() {
  return new Impit({ browser: 'chrome', ignoreTlsErrors: true, timeout: 30000, followRedirects: true });
}

const accounts = JSON.parse(fs.readFileSync(path.join(DIR, 'accounts.json'), 'utf8'));
const account = accounts.find((a) => String(a.email).toLowerCase() === EMAIL);
if (!account) { console.error(`account ${EMAIL} not in accounts.json`); process.exit(2); }

let cookiesession1 = null;

function botHeaders(token) {
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
    ...(cookiesession1 ? { 'Cookie': `cookiesession1=${cookiesession1}` } : {}),
    'X-Forwarded-For': SPOOF_IP,
    'X-Real-IP': SPOOF_IP,
    'Client-IP': SPOOF_IP,
    'True-Client-IP': SPOOF_IP,
    'CF-Connecting-IP': SPOOF_IP,
    'Forwarded': `for=${SPOOF_IP};proto=https`
  };
}

function hhmmss(ms) {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0') + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

async function shot(client, label, token, url = CHECKS_URL, headers = null) {
  const h = headers || botHeaders(token);
  const auth = String(h.Authorization || '');
  const tok = auth.replace(/^Bearer /, '');
  const t0 = Date.now();
  let res = null, err = '';
  try {
    res = await client.fetch(url, { method: 'GET', headers: h });
  } catch (e) { err = String(e.message || e); }
  const ms = Date.now() - t0;
  console.log(`\n--- ${label} @${hhmmss(t0)} (${ms}ms) sent ${tok.split('.').length - 1} dots / ${tok.length} chars ---`);
  if (err) { console.log(`    ERROR: ${err}`); return { status: 0, ms, err }; }
  const get = (n) => { try { return res.headers.get(n) || ''; } catch (_) { return ''; } };
  console.log(`    status            : ${res.status} ${res.statusText || ''}`);
  console.log(`    www-authenticate  : ${get('www-authenticate') || '-'}`);
  console.log(`    server            : ${get('server') || '-'}`);
  console.log(`    x-azure-ref       : ${get('x-azure-ref') || '-'}`);
  const sc = get('set-cookie');
  console.log(`    set-cookie        : ${sc || '-'}`);
  let body = '';
  try { body = ((await res.text()) || '').replace(/\s+/g, ' ').trim().slice(0, 120); } catch (_) { }
  console.log(`    body              : ${body || '<empty>'}`);
  const m = /cookiesession1=([A-Za-z0-9]+)/i.exec(sc);
  if (m) cookiesession1 = m[1];
  return { status: res.status, ms };
}

(async () => {
  console.log(`=== 401 root-cause probe | account ${EMAIL} | SHOT1 in ${FIRE_IN_MS}ms ===`);
  const startAt = Date.now();
  const fireAt = startAt + FIRE_IN_MS;

  // ---- login (same password grant the bot uses; undici/Node stack, as the bot's login does)
  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: 'aa-visasys-public',
    username: account.email,
    password: account.password,
    scope: 'openid profile email'
  }).toString();
  const lr = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, 'Accept': 'application/json' },
    body
  });
  const lt = await lr.text();
  if (lr.status !== 200) { console.log(`login failed ${lr.status}: ${lt.slice(0, 200)}`); process.exit(3); }
  const tok = JSON.parse(lt);
  const token = tok.access_token;
  let jwtHead = {};
  try { jwtHead = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')); } catch (_) { }
  let jwtBody = {};
  try { jwtBody = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); } catch (_) { }
  console.log(`login ok: expires_in=${tok.expires_in}s dots=${token.split('.').length - 1} len=${token.length}`);
  console.log(`  header : ${JSON.stringify(jwtHead)}`);
  console.log(`  claims : exp=${jwtBody.exp} iat=${jwtBody.iat} azp=${jwtBody.azp} typ=${jwtBody.typ} sid=${String(jwtBody.sid).slice(0, 8)}... iss=${jwtBody.iss}`);
  console.log(`  server now: ${new Date().toISOString()} (token exp: ${new Date(jwtBody.exp * 1000).toISOString()} → ${Math.round(jwtBody.exp - Date.now() / 1000)}s left)`);

  // ---- pre-arm warmup in the bot's order: 60s before windowStart, homepage cookie (fresh client
  //      like acquireWafCookie chromeFresh:true), then the shared client that fires the burst.
  const sharedA = newClient();
  const tWarm = fireAt - 60000;
  if (tWarm > Date.now()) await sleep(tWarm - Date.now());
  console.log(`\n[${hhmmss(Date.now())}] cookie warmup on a throwaway client (as acquireWafCookie does)`);
  const fresh = newClient();
  await shot(fresh, 'WARMUP GET egy. (cookie)', token, HOME_URL, {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br'
  });
  console.log(`    harvested cookiesession1 = ${cookiesession1 ? '...' + cookiesession1.slice(-6) : 'NONE'}`);

  const tApiWarm = fireAt - 55000;
  if (tApiWarm > Date.now()) await sleep(tApiWarm - Date.now());
  console.log(`\n[${hhmmss(Date.now())}] API-origin warmup on the BURST client (the proposed fix)`);
  await shot(sharedA, 'WARMUP HEAD egyapi (burst client)', token, API_ROOT, { 'User-Agent': UA, 'Accept': '*' });

  // ---- fire
  if (fireAt > Date.now()) await sleep(fireAt - Date.now());
  console.log(`\n[${hhmmss(Date.now())}] ======== FIRING (windowStart) ========`);
  const results = {};
  results.shot1 = await shot(sharedA, 'SHOT1 warm-API connection', token);

  const cold = newClient();
  results.shot2 = await shot(cold, 'SHOT2 COLD connection (bot replication)', token);

  await sleep(900);
  results.shot3 = await shot(cold, 'SHOT3 same cold client now warm', token);

  await sleep(Math.max(0, 15000 - 900));
  const cold2 = newClient();
  results.shot4 = await shot(cold2, 'SHOT4 COLD off-peak (+15s)', token);

  console.log('\n================ SUMMARY ================');
  for (const k of ['shot1', 'shot2', 'shot3', 'shot4']) {
    console.log(`  ${k}: status=${results[k].status} (${results[k].ms}ms)`);
  }
  const warm200 = results.shot1.status === 200;
  const cold401 = results.shot2.status === 401;
  console.log('\nVERDICT:');
  if (cold401 && warm200) {
    console.log('  ROOT CAUSE = the first request on a freshly opened connection to egyapi.');
    console.log('    A connection warmed 55s earlier (SHOT1) passed, the cold one (SHOT2) was rejected,');
    console.log('    and the same token then passed on that very connection (SHOT3).');
    console.log('    -> fix = warm the API origin that /checks actually uses before the window.');
  } else if (!cold401 && warm200) {
    console.log('  NOT REPRODUCED: the cold shot passed too. The bot 401 needs another factor');
    console.log('    (check the set-cookie/www-authenticate lines above, or run again on a busier mark).');
  } else {
    console.log('  BOTH shots failed -> compare their www-authenticate lines:');
    console.log('    "Missing part delimiters" = header arrived empty/stripped (edge/WAF problem);');
    console.log('    "no matching key(s)"/"decode the Jwt" = token rejected by the resource server;');
    console.log('    "expired" = expiry handling.');
  }
})();