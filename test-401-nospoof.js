// test-401-nospoof.js — one cold /checks WITHOUT spoofed IP headers, fired at a given instant.
// Run in parallel with test-401-matrix.js so the results are comparable second-for-second.
// Usage: node test-401-nospoof.js <msUntilShot> [email]
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Impit } from 'impit';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FIRE_IN_MS = Math.max(2000, parseInt(process.argv[2], 10) || 10000);
const EMAIL = (process.argv[3] || 'mahmoud.0505p@gmail.com').toLowerCase();
const CHECKS = 'https://egyapi.almaviva-visa.it/reservation-manager/api/planning/v1/checks?officeId=1&visaId=19&serviceLevelId=1';
const TOKEN_URL = 'https://egyiam.almaviva-visa.it/realms/oauth2-visaSystem-realm-pkce/protocol/openid-connect/token';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const accs = JSON.parse(fs.readFileSync(path.join(DIR, 'accounts.json'), 'utf8'));
const account = accs.find((a) => String(a.email).toLowerCase() === EMAIL);
if (!account) { console.error('account not found'); process.exit(2); }

(async () => {
  const fireAt = Date.now() + FIRE_IN_MS;
  const lb = new URLSearchParams({ grant_type: 'password', client_id: 'aa-visasys-public', username: account.email, password: account.password, scope: 'openid profile email' }).toString();
  const lr = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, Accept: 'application/json' }, body: lb });
  if (lr.status !== 200) { console.error('login failed', lr.status); process.exit(3); }
  const token = (await lr.json()).access_token;
  const wait = fireAt - Date.now();
  if (wait > 0) await sleep(wait);
  const t0 = Date.now();
  try {
    const c = new Impit({ browser: 'chrome', ignoreTlsErrors: true, timeout: 30000, followRedirects: true });
    const res = await c.fetch(CHECKS, {
      method: 'GET',
      headers: {
        'Host': 'egyapi.almaviva-visa.it', 'Authorization': `Bearer ${token}`,
        'Accept': 'application/json, text/plain, */*', 'User-Agent': UA,
        'Accept-Language': 'en', 'Origin': 'https://egy.almaviva-visa.it',
        'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty',
        'Referer': 'https://egy.almaviva-visa.it/', 'Accept-Encoding': 'gzip, deflate, br',
        'Priority': 'u=1, i', 'Sec-Ch-Ua': '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
        'Sec-Ch-Ua-Platform': '"Windows"', 'Sec-Ch-Ua-Mobile': '?0'
      }
    });
    console.log(JSON.stringify({ shot: 'cold-NOSPOOF', status: res.status, ms: Date.now() - t0, www: res.headers.get('www-authenticate') || null }));
  } catch (e) { console.log(JSON.stringify({ shot: 'cold-NOSPOOF', error: String(e.message).slice(0, 80) })); }
})();