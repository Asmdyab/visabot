// test-prearm-token-expiry.js — regression test for the pre-arm session freshness rule
// (root cause #1 of the 401 spam): the clock-burst pre-arm used to judge a session by
// `acquiredAt` age alone, so a session holding an already-dead token still counted as "fresh".
//
// Real incident (2026-09-17): the 09:43:55 pre-arm refreshed via refresh_token and the IAM
// returned expires_in=601s (a full login gives 900s). At the 09:53:55 pre-arm the session was
// 600s old (< 13 min → "fresh"), the token had 1s left, so the whole 09:55:00 burst fired with
// expired tokens: 8 × 401 + a re-login inside the drop window.
//
// The function under test is extracted from the bot file, so this pins shipped behaviour.
// Run: node test-prearm-token-expiry.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const BOT_FILE = path.join(DIR, 'visa-bot-api-multi-account-FIXED.js');
const CFG_FILE = path.join(DIR, 'visa-bot-api-config.json');
const src = fs.readFileSync(BOT_FILE, 'utf8');
const cfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));

const fnStart = src.indexOf('function modeSessionFreshForBurst(');
if (fnStart < 0) throw new Error('FAIL: modeSessionFreshForBurst not found in the bot file');
const fnEnd = src.indexOf('\n}', fnStart) + 2;
const FN_SRC = src.slice(fnStart, fnEnd);

const MARGIN = Math.max(30, parseInt(cfg.tokenRefresh && cfg.tokenRefresh.preArmMinTokenSeconds, 10) || 180);
// Same expression the bot uses; kept in sync by asserting the number is present in the file.
if (!src.includes('preArmMinTokenSeconds')) throw new Error('FAIL: config key preArmMinTokenSeconds not read by the bot');

const make = new Function('ntpNow', 'getTokenSecondsRemaining', 'PREARM_MIN_TOKEN_SECONDS', `
  ${FN_SRC}
  return modeSessionFreshForBurst;
`);
const fresh = make(() => 1_000_000, () => null, MARGIN);

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) { console.log(`  PASS  ${name}`); return; }
  failures++;
  console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ''}`);
}

const session = (ageSec) => ({ token: 'tok', account: { email: 'a@b.c' }, acquiredAt: 1_000_000 - ageSec * 1000 });
const withRem = (ageSec, remSec) => make(() => 1_000_000, () => remSec, MARGIN)(session(ageSec));

console.log(`pre-arm margin: ${MARGIN}s (tokenRefresh.preArmMinTokenSeconds)\n`);

console.log('the 09:55 incident: 600s-old session, 1s of token left');
check('1s left → NOT fresh (must refresh at pre-arm)', withRem(600, 1) === false);
check('0s/-77s left → NOT fresh', withRem(600, -77) === false && withRem(600, 0) === false);

console.log('\nmargin boundary (fresh means: strictly more than the margin)');
check(`${MARGIN}s left → NOT fresh (refreshed at pre-arm)`, withRem(600, MARGIN) === false);
check(`${MARGIN + 1}s left → fresh`, withRem(600, MARGIN + 1) === true);

console.log('\nage still caps the session');
check('age 900s (15 min) → NOT fresh even with 600s left', withRem(900, 600) === false);
check('age 600s with 600s left → fresh', withRem(600, 600) === true);

console.log('\nedge cases');
check('expiry unknown → keep age rule (fresh)', withRem(300, null) === true);
check('expiry unknown but aged out → NOT fresh', withRem(900, null) === false);
check('no token → NOT fresh', make(() => 1_000_000, () => 900, MARGIN)({ account: { email: 'a@b.c' }, acquiredAt: 1_000_000 }) === false);
check('null session → NOT fresh', make(() => 1_000_000, () => 900, MARGIN)(null) === false);

console.log(failures === 0 ? '\n✅ all pre-arm expiry checks passed' : `\n❌ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
