// test-api-401-probe.js — DIAGNOSTIC ONLY (no account, no login, bogus bearer token).
//
// Why: the clock-burst log shows the FIRST /checks of every burst answering
// 401 Unauthorized with an EMPTY body after 7-9s (soft401), while the very next
// request with the SAME token answers 200 in 100-400ms.
//
// This probe measures, off the drop peak:
//   A) cold /checks on a brand-new impit (Chrome-TLS) client vs warm on the same client
//   B) does the current pre-arm warmup (HEAD https://egy.almaviva-visa.it/) warm the
//      connection the /checks call actually uses (egyapi.almaviva-visa.it)?
//   C) does warming the API origin itself (GET https://egyapi.almaviva-visa.it/) help?
// and records the exact status/latency/body/Set-Cookie of each hop.
//
// Run:  node test-api-401-probe.js
import { Impit } from 'impit';

const CHECKS_URL = 'https://egyapi.almaviva-visa.it/reservation-manager/api/planning/v1/checks?officeId=1&visaId=1&serviceLevelId=1';
const HOME_URL = 'https://egy.almaviva-visa.it/';
const API_ROOT = 'https://egyapi.almaviva-visa.it/';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

// Same shape as buildCheckHeaders() in visa-bot-api-multi-account-FIXED.js
const CHECK_HEADERS = {
  'Host': 'egyapi.almaviva-visa.it',
  'Authorization': 'Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.probe-signature-not-valid',
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
  'Sec-Ch-Ua-Mobile': '?0'
};

const HOME_HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br'
};

function newClient() {
  return new Impit({ browser: 'chrome', ignoreTlsErrors: true, timeout: 30000, followRedirects: true });
}

async function hop(client, label, url, options = {}) {
  const t0 = Date.now();
  try {
    const res = await client.fetch(url, options);
    const ms = Date.now() - t0;
    let body = '';
    try { body = ((await res.text()) || '').replace(/\s+/g, ' ').trim().slice(0, 180); } catch (_) {}
    let setCookie = '';
    try { setCookie = String(res.headers.get('set-cookie') || ''); } catch (_) {}
    const cookie1 = /cookiesession1=([A-Za-z0-9]+)/i.exec(setCookie);
    console.log(
      `${label.padEnd(38)} ${String(res.status).padEnd(4)} ${String(ms).padStart(6)}ms` +
      `  cookie1=${cookie1 ? '...' + cookie1[1].slice(-6) : '-'}` +
      `  www-auth=${res.headers.get('www-authenticate') || '-'}` +
      (body ? `\n    body: ${body}` : '\n    body: <empty>')
    );
    return { status: res.status, ms };
  } catch (e) {
    console.log(`${label.padEnd(38)} ERR  ${String(Date.now() - t0).padStart(6)}ms  ${e.message}`);
    return { status: 0, ms: Date.now() - t0 };
  }
}

console.log('=== A) brand-new client: cold /checks then warm /checks ===');
{
  const c = newClient();
  await hop(c, 'A1 cold  GET /checks', CHECKS_URL, { headers: CHECK_HEADERS });
  await hop(c, 'A2 warm  GET /checks', CHECKS_URL, { headers: CHECK_HEADERS });
  await hop(c, 'A3 warm  GET /checks', CHECKS_URL, { headers: CHECK_HEADERS });
}

console.log('\n=== B) warmup as the bot does it: HEAD homepage, then /checks ===');
{
  const c = newClient();
  await hop(c, 'B1 HEAD egy.almaviva-visa.it', HOME_URL, { method: 'HEAD', headers: HOME_HEADERS });
  await hop(c, 'B2 cold  GET /checks', CHECKS_URL, { headers: CHECK_HEADERS });
  await hop(c, 'B3 warm  GET /checks', CHECKS_URL, { headers: CHECK_HEADERS });
}

console.log('\n=== C) warmup on the API origin itself, then /checks ===');
{
  const c = newClient();
  await hop(c, 'C1 HEAD egyapi.almaviva-visa.it', API_ROOT, { method: 'HEAD', headers: { 'User-Agent': UA } });
  await hop(c, 'C2 GET /checks (after api warm)', CHECKS_URL, { headers: CHECK_HEADERS });
  await hop(c, 'C3 warm  GET /checks', CHECKS_URL, { headers: CHECK_HEADERS });
}

console.log('\n=== D) exactly what the burst does (shared client, warmup then /checks) ===');
{
  const shared = newClient(); // simulates chromeImpitPool 'direct' shared client
  await hop(shared, 'D1 HEAD homepage (pre-arm)', HOME_URL, { method: 'HEAD', headers: HOME_HEADERS });
  await hop(shared, 'D2 first burst GET /checks', CHECKS_URL, { headers: CHECK_HEADERS });
  await hop(shared, 'D3 second burst GET /checks', CHECKS_URL, { headers: CHECK_HEADERS });
}

// E) IAM availability across the drop mark. A token resource server validates JWTs against the
// IAM's JWKS (egyiam). If the IAM is saturated at :00 (every bot in the country hits it at the
// same second), the API's key lookup can fail for a moment → it answers 401 for a token that is
// perfectly valid (and accepts it again seconds later, once the keys are back). Measure it.
// Run this section a few seconds BEFORE a :00/:05 mark to catch the peak.
const JWKS_URL = 'https://egyiam.almaviva-visa.it/realms/oauth2-visaSystem-realm-pkce/protocol/openid-connect/certs';
const START_DELAY_MS = Math.max(0, parseInt(process.argv[2], 10) || 0);
(async () => {
  if (START_DELAY_MS > 0) {
    console.log(`\n=== E) IAM JWKS + /checks across the mark (starting in ${START_DELAY_MS}ms) ===`);
    await new Promise((r) => setTimeout(r, START_DELAY_MS));
  } else {
    console.log('\n=== E) IAM JWKS latency samples ===');
  }
  const c = newClient();
  for (let i = 0; i < 6; i++) {
    await hop(c, `E${i + 1} GET IAM /certs`, JWKS_URL, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
    await hop(c, `E${i + 1} GET /checks   `, CHECKS_URL, { headers: CHECK_HEADERS });
    await new Promise((r) => setTimeout(r, 1500));
  }
})();
