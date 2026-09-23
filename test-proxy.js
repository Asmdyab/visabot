// Test proxy connectivity
import { HttpsProxyAgent } from 'https-proxy-agent';
import fetch from 'node-fetch';

const proxyString = 'gate-us.ipfoxy.io:58688:customer-bnTWcAsr6c-cc-EG-sessid-1769496815_10000:6xbzXbGTM4lMB4B';

console.log('🔍 Testing proxy:', proxyString);
console.log('');

// Parse proxy
const parts = proxyString.split(':');
const host = parts[0];
const port = parts[1];
const username = parts.slice(2, -1).join(':');
const password = parts[parts.length - 1];

console.log('📋 Parsed proxy:');
console.log('   Host:', host);
console.log('   Port:', port);
console.log('   Username:', username);
console.log('   Password:', password.substring(0, 4) + '...');
console.log('');

const proxyUrl = `http://${username}:${password}@${host}:${port}`;
console.log('🔗 Proxy URL:', proxyUrl.replace(password, '****'));
console.log('');

const agent = new HttpsProxyAgent(proxyUrl, {
  rejectUnauthorized: false,
  keepAlive: false,
  timeout: 30000
});

console.log('🌐 Testing connection to https://api.ipify.org ...');
console.log('⏳ Timeout: 30 seconds');
console.log('');

const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), 30000);

try {
  const startTime = Date.now();
  
  const response = await fetch('https://api.ipify.org', {
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    },
    agent: agent,
    signal: controller.signal
  });
  
  clearTimeout(timeoutId);
  
  const duration = Date.now() - startTime;
  const ip = await response.text();
  
  console.log(`✅ SUCCESS (${duration}ms)`);
  console.log('📍 Your IP:', ip);
  console.log('');
  console.log('✅ Proxy is working correctly!');
  
} catch (error) {
  clearTimeout(timeoutId);
  
  console.log('❌ FAILED:', error.message);
  console.log('');
  
  if (error.name === 'AbortError') {
    console.log('⚠️  Proxy timeout - Check:');
  } else {
    console.log('⚠️  Connection error - Check:');
  }
  
  console.log('   1. Proxy credentials are correct');
  console.log('   2. Proxy server is online');
  console.log('   3. Your IP is whitelisted (if required)');
  console.log('   4. Port 58688 is not blocked by firewall');
}
