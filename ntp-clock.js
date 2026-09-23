// ntp-clock.js — wall clock helpers
// Request firing uses Windows system clock (Date.now), not site/NTP offset.
import dgram from 'dgram';
import https from 'https';

const CAIRO_TZ = 'Africa/Cairo';
const NTP_HOSTS = ['time.google.com', 'time.cloudflare.com', 'time.windows.com', 'pool.ntp.org'];
const SITE_TIME_URLS = [
  'https://egyapi.almaviva-visa.it/',
  'https://egy.almaviva-visa.it/assets/config/config.json'
];

/** Firing / waits follow the Windows taskbar clock. */
const USE_WINDOWS_CLOCK = true;

let ntpOffsetMs = 0;
let ntpSynced = false;
let ntpSource = 'local';
let lastSyncAtMs = 0;
let syncInFlight = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fetchNtpTime(host = 'pool.ntp.org', timeoutMs = 3500) {
  return new Promise((resolve, reject) => {
    const client = dgram.createSocket('udp4');
    const packet = Buffer.alloc(48);
    packet[0] = 0x1B; // LI=0, VN=3, Mode=3 (client)
    const t0 = Date.now();
    let done = false;

    const finish = (err, result) => {
      if (done) return;
      done = true;
      try { client.close(); } catch (_) {}
      if (err) reject(err);
      else resolve(result);
    };

    const timer = setTimeout(() => finish(new Error(`NTP timeout: ${host}`)), timeoutMs);

    client.once('error', (err) => {
      clearTimeout(timer);
      finish(err);
    });

    client.once('message', (msg) => {
      clearTimeout(timer);
      const t3 = Date.now();
      if (!msg || msg.length < 48) {
        finish(new Error('Invalid NTP response'));
        return;
      }
      const seconds = msg.readUInt32BE(40);
      const fraction = msg.readUInt32BE(44);
      const utcMs = (seconds - 2208988800) * 1000 + (fraction / 0x100000000) * 1000;
      const rttMs = t3 - t0;
      // Apply half-RTT so returned time ≈ "now" at receive
      finish(null, { utcMs: utcMs + rttMs / 2, rttMs, source: `ntp://${host}` });
    });

    client.send(packet, 0, 48, 123, host, (err) => {
      if (err) {
        clearTimeout(timer);
        finish(err);
      }
    });
  });
}

function fetchHttpTimeFromUrl(url, parseUtcMs, sourceLabel, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          if (res.statusCode && res.statusCode >= 400) {
            throw new Error(`HTTP ${res.statusCode}`);
          }
          const utcMs = parseUtcMs(body, res);
          if (!Number.isFinite(utcMs)) throw new Error('Bad time payload');
          resolve({ utcMs, rttMs: null, source: sourceLabel });
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('HTTP time timeout'));
    });
  });
}

async function fetchHttpTimeFallback() {
  const sources = [
    () => fetchHttpTimeFromUrl(
      'https://timeapi.io/api/Time/current/zone?timeZone=UTC',
      (body) => {
        const data = JSON.parse(body);
        if (data.dateTime) {
          return Date.parse(data.dateTime.endsWith('Z') ? data.dateTime : `${data.dateTime}Z`);
        }
        return Date.UTC(
          data.year, data.month - 1, data.day,
          data.hour, data.minute, data.seconds, data.milliSeconds || 0
        );
      },
      'https://timeapi.io'
    ),
    () => fetchHttpTimeFromUrl(
      'https://worldtimeapi.org/api/timezone/Etc/UTC',
      (body) => {
        const data = JSON.parse(body);
        return Date.parse(data.utc_datetime || data.datetime);
      },
      'https://worldtimeapi.org'
    ),
    () => fetchHttpTimeFromUrl(
      'https://www.google.com',
      (_body, res) => Date.parse(res.headers.date || ''),
      'https://www.google.com (Date header)'
    )
  ];

  let lastErr;
  for (const trySource of sources) {
    try {
      return await trySource();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('All HTTP time fallbacks failed');
}

function fetchSiteHttpDate(url, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const req = https.get(url, {
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36'
      }
    }, (res) => {
      const t1 = Date.now();
      res.resume();
      const headerMs = Date.parse(res.headers.date || '');
      if (!Number.isFinite(headerMs)) {
        reject(new Error(`No Date header: ${url}`));
        return;
      }
      const rttMs = t1 - t0;
      let host = url;
      try { host = new URL(url).host; } catch (_) {}
      resolve({
        utcMs: headerMs + 500 + rttMs / 2,
        rttMs,
        source: `site://${host}`
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`site time timeout: ${url}`));
    });
  });
}

/** One-shot UTC ms from Almaviva first, then NTP. Does not update module offset. */
export async function getAccurateUtcMs() {
  for (const url of SITE_TIME_URLS) {
    try {
      return await fetchSiteHttpDate(url);
    } catch (_) {}
  }
  for (const host of NTP_HOSTS) {
    try {
      return await fetchNtpTime(host, 3500);
    } catch (_) {}
  }
  return await fetchHttpTimeFallback();
}

/** Sync clock offset from Almaviva Date header (Windows clock ignored). */
export async function syncNtpClock() {
  if (USE_WINDOWS_CLOCK) {
    ntpOffsetMs = 0;
    ntpSynced = true;
    ntpSource = 'windows-local';
    lastSyncAtMs = Date.now();
    return getNtpStatus();
  }

  if (syncInFlight) return syncInFlight;

  syncInFlight = (async () => {
    const before = Date.now();
    const { utcMs, rttMs, source } = await getAccurateUtcMs();
    const after = Date.now();
    // utcMs already includes server-side RTT/2; compensate client processing mid-point
    const mid = before + (after - before) / 2;
    ntpOffsetMs = Math.round(utcMs - mid);
    ntpSynced = source !== 'local-fallback';
    ntpSource = source;
    lastSyncAtMs = after;
    return getNtpStatus();
  })();

  try {
    return await syncInFlight;
  } finally {
    syncInFlight = null;
  }
}

export function ntpNow() {
  if (USE_WINDOWS_CLOCK) return Date.now();
  return Date.now() + ntpOffsetMs;
}

export function getNtpStatus() {
  return {
    offsetMs: ntpOffsetMs,
    synced: ntpSynced,
    source: ntpSource,
    lastSyncAtMs
  };
}

export function parseTimeOfDay(scheduledTime) {
  const timeParts = String(scheduledTime || '').split(':');
  const hour = parseInt(timeParts[0], 10) || 0;
  const minute = parseInt(timeParts[1], 10) || 0;
  let second = 0;
  let millisecond = 0;
  if (timeParts[2]) {
    const secParts = timeParts[2].split('.');
    second = parseInt(secParts[0], 10) || 0;
    if (secParts[1]) {
      millisecond = parseInt(secParts[1].padEnd(3, '0').slice(0, 3), 10) || 0;
    }
  }
  return { hour, minute, second, millisecond };
}

function getCairoParts(epochMs) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: CAIRO_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  const parts = {};
  for (const p of formatter.formatToParts(new Date(epochMs))) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  return {
    year: parseInt(parts.year, 10),
    month: parseInt(parts.month, 10),
    day: parseInt(parts.day, 10),
    hour: parseInt(parts.hour, 10),
    minute: parseInt(parts.minute, 10),
    second: parseInt(parts.second, 10),
    millisecond: epochMs % 1000
  };
}

/** Milliseconds since midnight in Africa/Cairo for an NTP epoch. */
export function cairoTimeOfDayMs(epochMs = ntpNow()) {
  const p = getCairoParts(epochMs);
  return ((p.hour * 3600 + p.minute * 60 + p.second) * 1000) + p.millisecond;
}

export function formatCairoHms(epochMs = ntpNow(), withMs = false) {
  const p = getCairoParts(epochMs);
  const base = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}:${String(p.second).padStart(2, '0')}`;
  if (!withMs) return base;
  return `${base}.${String(p.millisecond).padStart(3, '0')}`;
}

/** Next UTC epoch (NTP) when Cairo clock hits HH:MM:SS.mmm */
export function nextCairoWallTimeEpochMs(hour, minute, second = 0, millisecond = 0, fromEpochMs = ntpNow()) {
  const targetTod = ((hour * 3600 + minute * 60 + second) * 1000) + millisecond;
  const nowTod = cairoTimeOfDayMs(fromEpochMs);
  let wait = targetTod - nowTod;
  if (wait <= 0) wait += 24 * 60 * 60 * 1000;
  return fromEpochMs + wait;
}

/**
 * High-precision wait until a wall-clock epoch (NTP Cairo unless USE_WINDOWS_CLOCK).
 * Busy-spins near the target (Windows timers ~15ms).
 *
 * options.cairoWall = { hour, minute, second, millisecond }
 *   → re-anchor target to that Cairo wall time near fire (avoids drift).
 */
export async function waitUntilNtpEpoch(targetEpochMs, options = {}) {
  const {
    resyncBeforeMs = 20000,
    spinBeforeMs = 50, // enter busy-wait this many ms early (avoid setTimeout jitter)
    onTick = null,
    tickEveryMs = 60000,
    label = '',
    cairoWall = null,
    shouldStop = null
  } = options;

  let lastTickAt = 0;
  let didResync = false;
  let target = targetEpochMs;

  while (true) {
    const now = ntpNow();
    const remaining = target - now;
    if (remaining <= 0) break;

    // Early abort — e.g. appointment already found, no point waiting the full interval
    if (typeof shouldStop === 'function' && shouldStop(target)) {
      break;
    }

    // NTP re-sync disabled in Windows clock mode
    if (!USE_WINDOWS_CLOCK && !didResync && remaining <= resyncBeforeMs) {
      didResync = true;
      try {
        await syncNtpClock();
      } catch (_) {}
      // Re-compute absolute target from Cairo wall so resync can't shift fire time
      if (cairoWall) {
        const recomputed = nextCairoWallTimeEpochMs(
          cairoWall.hour,
          cairoWall.minute,
          cairoWall.second || 0,
          cairoWall.millisecond || 0,
          ntpNow()
        );
        // If recomputed jumped to "tomorrow" because we're within the same second, keep nearer target
        if (recomputed - ntpNow() < 12 * 60 * 60 * 1000) {
          target = recomputed;
        }
      }
      continue;
    }

    if (typeof onTick === 'function' && (now - lastTickAt >= tickEveryMs)) {
      lastTickAt = now;
      try { onTick(target - ntpNow()); } catch (_) {}
    }

    const rem = target - ntpNow();
    if (rem <= 0) break;

    if (rem > 500) {
      // Stay awake well before spin window (Windows setTimeout granularity ~15ms)
      await sleep(Math.min(rem - spinBeforeMs, 200));
    } else if (rem > spinBeforeMs) {
      await sleep(Math.max(1, rem - spinBeforeMs));
    } else {
      // Final window: busy-spin — only way to hit .000 on Windows
      while (ntpNow() < target) {
        // busy-wait
      }
      break;
    }
  }

  return { label, firedAt: ntpNow(), targetEpochMs: target, deltaMs: ntpNow() - target };
}

export async function waitUntilCairoWallTime(hour, minute, second = 0, millisecond = 0, options = {}) {
  const target = nextCairoWallTimeEpochMs(hour, minute, second, millisecond);
  return waitUntilNtpEpoch(target, options);
}

/** Start periodic background NTP re-sync (no-op if USE_WINDOWS_CLOCK). */
export function startNtpAutoSync(intervalMs = 2 * 60 * 1000) {
  if (USE_WINDOWS_CLOCK) {
    return null;
  }
  const timer = setInterval(() => {
    syncNtpClock().catch(() => {});
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}
