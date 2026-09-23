// Test proxy with different SSL settings
import { HttpsProxyAgent } from 'https-proxy-agent';
import fetch from 'node-fetch';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const proxyString = 'gate-us.ipfoxy.io:58688:customer-bnTWcAsr6c-cc-EG-sessid-1769496815_10000:6xbzXbGTM4lMB4B';

console.log('🔍 Testing proxy with NODE_TLS_REJECT_UNAUTHORIZED=0\n');

const parts = proxyString.split(':');
const host = parts[0];
const port = parts[1];
const username = parts.slice(2, -1).join(':');
const password = parts[parts.length - 1];

const proxyUrl = `http://${username}:${password}@${host}:${port}`;
console.log('🔗 Proxy URL:', proxyUrl.replace(password, '****'));
console.log('');

// Test 1: rejectUnauthorized false (like bot)
console.log('Test 1: rejectUnauthorized: false');
const agent1 = new HttpsProxyAgent(proxyUrl, {
  rejectUnauthorized: false,
  keepAlive: false,
  maxSockets: Infinity,
  maxFreeSockets: 0,
  timeout: 30000,
  scheduling: 'lifo'
});

const controller1 = new AbortController();
const timeoutId1 = setTimeout(() => controller1.abort(), 30000);

try {
  const startTime = Date.now();
  const response = await fetch('https://api.ipify.org', {
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    },
    agent: agent1,
    signal: controller1.signal
  });
  
  clearTimeout(timeoutId1);
  
  const duration = Date.now() - startTime;
  const ip = await response.text();
  
  console.log(`✅ SUCCESS (${duration}ms)`);
  console.log('📍 Your IP:', ip);
  console.log('');
  
} catch (error) {
  clearTimeout(timeoutId1);
  console.log('❌ FAILED:', error.message);
  console.log('');
}

// Test 2: Without agent timeout (simpler)
console.log('Test 2: Without timeout in agent options');
const agent2 = new HttpsProxyAgent(proxyUrl, {
  rejectUnauthorized: false,
  keepAlive: false
});

const controller2 = new AbortController();
const timeoutId2 = setTimeout(() => controller2.abort(), 30000);

try {
  const startTime = Date.now();
  const response = await fetch('https://api.ipify.org', {
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    },
    agent: agent2,
    signal: controller2.signal
  });
  
  clearTimeout(timeoutId2);
  
  const duration = Date.now() - startTime;
  const ip = await response.text();
  
  console.log(`✅ SUCCESS (${duration}ms)`);
  console.log('📍 Your IP:', ip);
  console.log('');
  
} catch (error) {
  clearTimeout(timeoutId2);
  console.log('❌ FAILED:', error.message);
  console.log('');
}

// Test 3: Test without proxy to verify network is working
console.log('Test 3: Without proxy (direct connection)');
const controller3 = new AbortController();
const timeoutId3 = setTimeout(() => controller3.abort(), 10000);

try {
  const startTime = Date.now();
  const response = await fetch('https://api.ipify.org', {
    method: 'GET',
    signal: controller3.signal
  });
  
  clearTimeout(timeoutId3);
  
  const duration = Date.now() - startTime;
  const ip = await response.text();
  
  console.log(`✅ SUCCESS (${duration}ms)`);
  console.log('📍 Your IP:', ip);
  console.log('');
  
} catch (error) {
  clearTimeout(timeoutId3);
  console.log('❌ FAILED:', error.message);
}
