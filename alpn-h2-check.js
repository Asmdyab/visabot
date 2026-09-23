import tls from 'tls';
import http2 from 'http2';

const host = 'egyapi.almaviva-visa.it';

function logLine(s) {
  process.stdout.write(s + '\n');
}

async function tlsAlpnCheck() {
  return new Promise((resolve) => {
    const s = tls.connect({
      host,
      port: 443,
      servername: host,
      ALPNProtocols: ['h2', 'http/1.1'],
      rejectUnauthorized: false,
    }, () => {
      resolve({
        alpn: s.alpnProtocol || null,
        tls: s.getProtocol?.() || null,
        cipher: s.getCipher?.()?.name || null,
      });
      s.end();
    });

    s.setTimeout(8000, () => {
      resolve({ error: 'tls timeout' });
      s.destroy();
    });

    s.on('error', (err) => {
      resolve({ error: 'tls error: ' + err.message });
    });
  });
}

async function h2Request(path) {
  return new Promise((resolve) => {
    const client = http2.connect(`https://${host}`, { rejectUnauthorized: false });
    const startedAt = Date.now();

    const done = (obj) => {
      try { client.close(); } catch {}
      resolve({ ms: Date.now() - startedAt, ...obj });
    };

    client.setTimeout(8000, () => done({ error: 'session timeout', alpn: client.socket?.alpnProtocol || null }));
    client.on('error', (err) => done({ error: 'session error: ' + err.message, alpn: client.socket?.alpnProtocol || null }));

    client.on('connect', () => {
      const alpn = client.socket?.alpnProtocol || null;
      const req = client.request({ ':method': 'GET', ':path': path });

      let gotHeaders = false;
      req.setEncoding('utf8');

      req.setTimeout(8000, () => {
        try { req.close(); } catch {}
        done({ error: 'stream timeout', alpn, gotHeaders });
      });

      req.on('response', (headers) => {
        gotHeaders = true;
        done({ ok: true, status: headers[':status'], alpn });
      });

      req.on('error', (err) => done({ error: 'stream error: ' + err.message, alpn, gotHeaders }));
      req.end();
    });
  });
}

(async () => {
  logLine('=== TLS ALPN check ===');
  const tlsRes = await tlsAlpnCheck();
  logLine(JSON.stringify(tlsRes, null, 2));

  logLine('\n=== HTTP/2 request / ===');
  const rootRes = await h2Request('/');
  logLine(JSON.stringify(rootRes, null, 2));

  logLine('\n=== HTTP/2 request API endpoint (no auth) ===');
  const apiRes = await h2Request('/configuration-manager/api/visas/v1/list/web?office=1');
  logLine(JSON.stringify(apiRes, null, 2));
})();
