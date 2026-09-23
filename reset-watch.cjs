// Reset-window watcher: 1 probe per 10 min on a dead account until first 200 (max 6 tries = 60 min)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const fs = require('fs');
const { execSync } = require('child_process');
const LOG = 'D:\\botbot\\WATCH DOGS TEAM\\bot-session-logs\\reset-watch.txt';
const EMAIL = 'lorenabdelshahid@outlook.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  fs.appendFileSync(LOG, `=== reset watch started ${new Date().toISOString()} (death was 12:36:33) ===\n`);
  for (let tryN = 1; tryN <= 6; tryN++) {
    if (tryN > 1) await sleep(10 * 60 * 1000);
    let out = '';
    try {
      out = execSync(`node burp-probe.cjs ${EMAIL} 3000 1`, { cwd: 'D:\\botbot\\WATCH DOGS TEAM', timeout: 60000, encoding: 'utf8' });
    } catch (e) { out = 'EXEC_FAIL ' + String((e && e.message) || e).slice(0, 120); }
    const lines = out.split('\n').filter((l) => l.trim().startsWith('{'));
    let status = 'unknown';
    for (const l of lines) { try { const j = JSON.parse(l); if (j.status) status = j.status; } catch (_) {} }
    const elapsedMin = Math.round((Date.now() - Date.parse('2026-09-16T09:36:33Z')) / 60000);
    fs.appendFileSync(LOG, `[${new Date().toTimeString().slice(0, 8)}] try#${tryN} ~${elapsedMin}min post-death status=${status}\n`);
    if (String(status) === '200') {
      fs.appendFileSync(LOG, `*** RECOVERED at ~${elapsedMin} min post-death ***\n`);
      break;
    }
  }
  fs.appendFileSync(LOG, `=== watch ended ${new Date().toISOString()} ===\n`);
})();
