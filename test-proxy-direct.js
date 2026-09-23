// Test proxy with EXACT same method as bot uses
import { HttpsProxyAgent } from 'https-proxy-agent';
import fetch from 'node-fetch';

const proxyString = 'gate-us.ipfoxy.io:58688:customer-bnTWcAsr6c-cc-EG-sessid-1769496815_10000:6xbzXbGTM4lMB4B';

console.log('🔍 Testing proxy with EXACT same method as bot...\n');

// Parse EXACTLY like buildProxyAgentFromString
const parts = proxyString.split(':');
const host = parts[0];
const port = parts[1];
const username = parts.slice(2, -1).join(':');
const password = parts[parts.length - 1];

console.log('📋 Parsed:');
console.log('   Host:', host);
console.log('   Port:', port);
console.log('   Username:', username);
console.log('   Password:', password.substring(0, 4) + '...');

const proxyUrl = `http://${username}:${password}@${host}:${port}`;
console.log('   Proxy URL:', proxyUrl.replace(password, '****'));
console.log('');

// Create agent with EXACT same options as bot
const agentOptions = {
  rejectUnauthorized: false,
  keepAlive: false,
  maxSockets: Infinity,
  maxFreeSockets: 0,
  timeout: 30000,
  scheduling: 'lifo'
};

console.log('🔧 Agent options:', JSON.stringify(agentOptions, null, 2));
console.log('');

const agent = new HttpsProxyAgent(proxyUrl, agentOptions);

console.log('🌐 Testing connection...\n');

// Test with AbortController like bot does
const controller = new AbortController();
const timeoutId = setTimeout(() => {
  console.log('⏰ Timeout triggered after 30 seconds');
  controller.abort();
}, 30000);

try {
  const startTime = Date.now();
  
  const response = await fetch('https://api.ipify.org', {
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    },
    agent: agent,
    signal: controller.signal
  });
  
  clearTimeout(timeoutId);
  
  const duration = Date.now() - startTime;
  const ip = await response.text();
  
  console.log(`✅ SUCCESS (${duration}ms)`);
  console.log('📍 Your IP:', ip);
  
} catch (error) {
  clearTimeout(timeoutId);
  console.log('❌ FAILED:', error.message);
  console.log('Error name:', error.name);
}
