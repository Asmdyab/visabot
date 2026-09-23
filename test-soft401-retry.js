// test-soft401-retry.js — regression test for the soft-401 burst-retry policy shipped in
// checkAvailability() of visa-bot-api-multi-account-FIXED.js.
//
// It does NOT re-implement the policy: it slices the real retry block out of the bot file and
// replays it with mocked httpFetch/clock helpers, so the assertions run against shipped source.
//
// Covers: recovery (not-available / available), retries-exhausted flag, the burst-window cap,
// 429 / 400-outside-hours / 5xx short-circuits, transport errors, and config → constants mapping.
//
// Run: node test-soft401-retry.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const BOT_FILE = path.join(DIR, 'visa-bot-api-multi-account-FIXED.js');
const CFG_FILE = path.join(DIR, 'visa-bot-api-config.json');

const src = fs.readFileSync(BOT_FILE, 'utf8');
const START = '        if (burstRetries > 0) {\n';
const END = "        return { found: false, soft401: true, tokenExpired: false, error: 'SOFT_401', latencyMs: duration };";

const a = src.indexOf(START);
if (a < 0) throw new Error('FAIL: retry-loop start marker not found in the bot file');
const b = src.indexOf(END, a);
if (b < 0) throw new Error('FAIL: retry-loop end marker not found in the bot file');
const LOOP_SRC = src.slice(a, b);

const cfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
// Mirror of the constants block in visa-bot-api-multi-account-FIXED.js (~line 1236).
const MAX_RETRIES = Math.max(1, parseInt(cfg.burst401 && cfg.burst401.maxRetries, 10) || 4);
const WINDOW_MS = Math.max(500, parseInt(cfg.burst401 && cfg.burst401.maxWindowMs, 10) || 9000);
const DELAY_MS = Math.max(0, parseInt(cfg.burst401 && cfg.burst401.retryDelayMs, 10) || 0);
const ENABLED = (cfg.burst401 && cfg.burst401.enabled === true);

const factory = new Function('ctx', `
  const {
    ntpNow, sleep, httpFetch, updateWafCookieFromResponse, buildCheckHeaders,
    getAgentForAccount, parseRetryAfterMs, SEQUENTIAL_QUIET_LOGS, log, log401,
    isNearAppointmentDropWindow, token, accountEmail, checkUrl, agent, abortSignal,
    forceTimeoutCallback, CHECKS_TIMEOUT, optimizedHttpsAgent, duration, startTime
  } = ctx;
  const BURST_401_WINDOW_MS = ${WINDOW_MS};
  const BURST_401_DELAY_MS = ${DELAY_MS};
  const burstRetries = ${MAX_RETRIES};
  return (async () => {
${LOOP_SRC}
    return { fellThrough: true };
  })();
`);

function makeResponse(status, body = null) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null, getSetCookie: () => [] },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body === null ? {} : body)),
    json: async () => (body === null ? false : body)
  };
}

// `script` = the status each RETRY attempt receives (the initial 401 that triggered the retry
// already happened outside the extracted block).
function run(script, opts = {}) {
  const clock = { now: 1000 };
  const calls = [];
  const logs = [];
  const ctx = {
    ntpNow: () => clock.now,
    sleep: async (ms) => { clock.now += ms; },
    httpFetch: async () => {
      const step = typeof opts.msPerCall === 'function' ? opts.msPerCall(calls.length) : (opts.msPerCall || 0);
      clock.now += step;
      const status = script[Math.min(calls.length, script.length - 1)];
      calls.push(status);
      if (status === 'throw') throw new Error('socket hang up');
      return makeResponse(status, opts.bodies ? opts.bodies[calls.length - 1] : null);
    },
    updateWafCookieFromResponse: () => {},
    buildCheckHeaders: () => ({}),
    getAgentForAccount: () => null,
    parseRetryAfterMs: () => 15000,
    SEQUENTIAL_QUIET_LOGS: opts.quiet !== false,
    log: (m) => logs.push(String(m)),
    log401: (m, msg) => logs.push(`401LOG: ${msg}`),
    isNearAppointmentDropWindow: () => false,
    token: 'tok', accountEmail: 'a@b.c', checkUrl: 'https://x/checks', agent: null,
    abortSignal: null, forceTimeoutCallback: null, CHECKS_TIMEOUT: 60000,
    optimizedHttpsAgent: null, duration: 8000, startTime: 0
  };
  return { promise: factory(ctx), calls, logs, clock };
}

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) { console.log(`  PASS  ${name}`); return; }
  failures++;
  console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ''}`);
}

console.log(`config: burst401.enabled=${ENABLED} maxRetries=${MAX_RETRIES} windowMs=${WINDOW_MS} delayMs=${DELAY_MS}`);
console.log(`extracted retry block: ${LOOP_SRC.split('\n').length} lines from ${path.basename(BOT_FILE)}\n`);

async function main() {
  console.log('1) 401 → 200 (no availability) recovers and reports not-found');
  {
    const r = run([200], { msPerCall: 300 });
    const res = await r.promise;
    check('not found after recovery', res && res.found === false && !res.soft401, JSON.stringify(res));
    check('exactly one retry fired', r.calls.length === 1, `calls=${r.calls.join(',')}`);
  }

  console.log('\n2) 401 → 200 (available) recovers as found');
  {
    const r = run([200], { msPerCall: 300, bodies: [true] });
    const res = await r.promise;
    check('found after recovery', res && res.found === true, JSON.stringify(res));
  }

  console.log('\n3) all 401 → soft401 + retriesExhausted (drives the re-login self-heal)');
  {
    const r = run([401], { msPerCall: 200 });
    const res = await r.promise;
    check('soft401 returned', res && res.soft401 === true && res.tokenExpired === false, JSON.stringify(res));
    check('retriesExhausted flag set', res && res.retriesExhausted === true, JSON.stringify(res));
    check(`attempt count == ${MAX_RETRIES}`, r.calls.length === MAX_RETRIES, `calls=${r.calls.length}`);
    check('persisted-401 logged for bot-401-log.txt', r.logs.some((l) => l.startsWith('401LOG: SOFT 401 persisted')));
  }

  console.log('\n4) burst window cap stops the retry chain (no runaway firing)');
  {
    const r = run([401], { msPerCall: 6000, quiet: false });
    const res = await r.promise;
    check('stopped after 2 attempts (window cap)', r.calls.length === 2, `calls=${r.calls.length} of ${MAX_RETRIES}`);
    check('still reports soft401', res && res.soft401 === true, JSON.stringify(res));
    check('window stop logged', r.logs.some((l) => l.includes('Burst window')), r.logs.join(' | '));
  }

  console.log('\n5) 429 on a retry short-circuits as rate-limited');
  {
    const r = run([429], { msPerCall: 100 });
    const res = await r.promise;
    check('rateLimited returned', res && res.rateLimited === true && res.retryAfterMs === 15000, JSON.stringify(res));
    check('stopped firing after 429', r.calls.length === 1, `calls=${r.calls.length}`);
  }

  console.log('\n6) 400 with "office hours" message short-circuits as outsideOfficeHours');
  {
    const r = run([400], { msPerCall: 100, bodies: [{ message: 'Outside office hours' }] });
    const res = await r.promise;
    check('outsideOfficeHours returned', res && res.outsideOfficeHours === true, JSON.stringify(res));
  }

  console.log('\n7) 500 on a retry short-circuits with the HTTP error');
  {
    const r = run([500], { msPerCall: 100 });
    const res = await r.promise;
    check('HTTP 500 surfaced', res && res.error === 'HTTP 500', JSON.stringify(res));
  }

  console.log('\n8) transport error inside the window → next attempt is used');
  {
    const r = run(['throw', 200], { msPerCall: 100 });
    const res = await r.promise;
    check('recovered after a transport error', res && res.found === false && !res.soft401, JSON.stringify(res));
    check('attempts used == 2', r.calls.length === 2, `calls=${r.calls.join(',')}`);
  }

  console.log('\n9) shipped config values are sane (whatever policy the user chose)');
  {
    check('maxRetries in 1..10', MAX_RETRIES >= 1 && MAX_RETRIES <= 10, String(MAX_RETRIES));
    check('window bounded (<= 15s)', WINDOW_MS <= 15000, String(WINDOW_MS));
    check('delay non-negative', DELAY_MS >= 0, String(DELAY_MS));
    console.log(`   (note: in-window retries are ${ENABLED ? 'ACTIVE' : 'INACTIVE'} — set by burst401.enabled in config / manager UI)`);
  }

  console.log(failures === 0 ? '\n✅ all soft-401 retry checks passed' : `\n❌ ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });