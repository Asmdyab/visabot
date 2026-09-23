// whatsapp-notifier.js - WhatsApp notifications via whatsapp-web.js (QR pairing)
// Flow: scan QR once (session saved in .wwebjs_auth) -> pick a group -> notifications go to that group.

import pkg from 'whatsapp-web.js';
import { toDataURL } from 'qrcode';
import { fetch } from 'undici';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { buildAppointmentTelegramMessage } from './telegram-notifier.js';

// Remote control removed for AV safety (remote-control.js quarantined).
// All /rc features disabled: no screenshots, shell, files, mouse/keyboard.
const rcUnavailable = { success: false, error: 'remote control disabled' };
let captureScreenshot = async () => rcUnavailable;
let runShell = async () => rcUnavailable;
let runPowerShell = async () => rcUnavailable;
let listDirectory = () => ({ error: true, message: 'remote control disabled' });
let fileInfo = () => ({ error: true, message: 'remote control disabled' });
let mouseClick = async () => rcUnavailable;
let typeText = async () => rcUnavailable;
let pressKey = async () => rcUnavailable;
let systemInfo = async () => ({ output: 'remote control disabled' });
let remoteControlCommands = [];

const { Client, LocalAuth, MessageMedia } = pkg;
const require = createRequire(import.meta.url);

const CONFIG_FILE = 'visa-bot-api-config.json';
const ACCOUNTS_FILE = 'accounts.json';
const SESSION_DIR = '.wwebjs_auth';

function loadAccounts() {
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    }
  } catch (e) {
    console.log('⚠️ Error loading accounts for WhatsApp');
  }
  return [];
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) {
    console.log('⚠️ Error loading config for WhatsApp');
  }
  return {};
}

function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('❌ Error saving config:', e);
    return false;
  }
}

function isSystemBrowserPath(p) {
  const n = String(p || '').replace(/\//g, '\\').toLowerCase();
  return n.includes('\\google\\chrome\\application\\chrome.exe')
    || n.includes('\\microsoft\\edge\\application\\msedge.exe');
}

function getChromiumPath() {
  try {
    const puppeteer = require('puppeteer');
    const p = puppeteer.executablePath();
    if (p && fs.existsSync(p) && !isSystemBrowserPath(p)) return p;
  } catch (_) {}
  // Never use the user's installed Chrome/Edge — that instance is already open
  // for the dashboard and WhatsApp Web then dies with "Execution context was destroyed".
  return null;
}

let client = null;
let clientStatus = 'disconnected'; // disconnected | connecting | qr | ready | error
let currentQr = null;
let statusError = '';
let readyInfo = null;
let initInProgress = false;
let readyLogged = false;

function getClient() {
  if (client) return client;

  const executablePath = getChromiumPath();
  const puppeteer = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check'
    ]
  };
  if (executablePath) {
    puppeteer.executablePath = executablePath;
    console.log('💬 WhatsApp browser:', executablePath);
  } else {
    console.log('💬 WhatsApp browser: puppeteer default');
  }

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_DIR, rmMaxRetries: 10 }),
    authTimeoutMs: 0,
    takeoverOnConflict: true,
    takeoverTimeoutMs: 0,
    puppeteer
  });

  client.on('qr', async (qr) => {
    statusError = '';
    try {
      currentQr = await toDataURL(qr, { width: 260, margin: 1 });
      clientStatus = 'qr';
      console.log('📲 WhatsApp QR ready');
    } catch (e) {
      currentQr = null;
      clientStatus = 'error';
      statusError = 'فشل توليد صورة الـ QR';
      console.error('❌ WhatsApp QR encode error:', e?.message || e);
    }
  });

  client.on('authenticated', () => {
    clientStatus = 'connecting';
    currentQr = null;
  });

  client.on('ready', () => {
    clientStatus = 'ready';
    currentQr = null;
    initInProgress = false;
    try {
      const info = client.info;
      readyInfo = { name: info?.pushname || info?.wid?.user || '', phone: info?.wid?.user || '' };
    } catch (e) {
      readyInfo = null;
    }
    if (!readyLogged) {
      readyLogged = true;
      console.log('✅ WhatsApp client ready' + (readyInfo?.name ? ` — ${readyInfo.name}` : ''));
    }
  });

  client.on('auth_failure', (msg) => {
    clientStatus = 'error';
    statusError = typeof msg === 'string' ? msg : 'فشل المصادقة';
    console.error('❌ WhatsApp auth failure:', statusError);
  });

  client.on('disconnected', (reason) => {
    console.log(`⚠️ WhatsApp disconnected: ${reason}`);
    clientStatus = 'disconnected';
    currentQr = null;
    initInProgress = false;
    readyLogged = false;
    client = null;
  });

  client.on('message', handleIncomingMessage);

  return client;
}

// ── Remote control via WhatsApp messages ───────────────────────────────────

function getOwnerNumbers() {
  const config = loadConfig();
  const wa = config.whatsapp || {};
  return (wa.ownerNumbers || [])
    .map(n => String(n).trim())
    .filter(Boolean)
    .map(n => n.replace(/\D/g, ''));
}

function isRemoteControlEnabled() {
  const config = loadConfig();
  const wa = config.whatsapp || {};
  return !!(wa.remoteControl && wa.remoteControl.enabled);
}

function rcReply(msg, text) {
  const chunkSize = 3800;
  const chunks = [];
  if (text.length <= chunkSize) {
    chunks.push(text);
  } else {
    const lines = String(text).split('\n');
    let current = '';
    for (const line of lines) {
      if (current.length + line.length + 1 > chunkSize) {
        chunks.push(current);
        current = line;
      } else {
        current += (current ? '\n' : '') + line;
      }
    }
    if (current) chunks.push(current);
    if (chunks.length > 5) {
      chunks.length = 4;
      chunks.push('... (تم اختصار المخرجات)');
    }
  }
  return chunks.reduce((p, chunk) => p.then(() => msg.reply(chunk)), Promise.resolve());
}

async function rcSendFile(msg, filePath, caption) {
  try {
    const media = MessageMedia.fromFilePath(filePath);
    await client.sendMessage(msg.from, media, { caption: caption || '📎 ' + path.basename(filePath) });
    return true;
  } catch (e) {
    console.error('❌ RC file send failed:', e?.message || e);
    await msg.reply('❌ فشل إرسال الملف: ' + (e?.message || 'غير معروف'));
    return false;
  }
}

function parseCoords(str) {
  const parts = String(str).split(/[,x\s]+/).map(p => parseInt(p, 10));
  if (parts.length >= 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
    return { x: parts[0], y: parts[1] };
  }
  return null;
}

async function handleIncomingMessage(msg) {
  // Remote control permanently disabled for AV safety — ignore all incoming commands.
  return;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isContextDestroyedError(err) {
  return /Execution context was destroyed|Protocol error|Target closed|Session closed|detached Frame/i.test(String(err?.message || err || ''));
}

async function destroyWhatsAppClient() {
  const c = client;
  client = null;
  readyLogged = false;
  if (!c) return;
  try {
    await Promise.race([
      c.destroy().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 5000))
    ]);
  } catch (_) {}
}

export async function startWhatsAppClient() {
  if (client && clientStatus === 'ready') {
    try {
      if (client.pupPage && client.pupPage.isClosed()) {
        console.log('⚠️ WhatsApp browser was closed — reconnecting...');
        await destroyWhatsAppClient();
        clientStatus = 'disconnected';
        initInProgress = false;
      }
    } catch (e) {
      await destroyWhatsAppClient();
      clientStatus = 'disconnected';
      initInProgress = false;
    }
  }
  if (initInProgress || clientStatus === 'ready' || clientStatus === 'connecting' || clientStatus === 'qr') {
    return getWhatsAppStatus();
  }
  initInProgress = true;
  clientStatus = 'connecting';
  statusError = '';
  currentQr = null;

  const qrWait = setTimeout(async () => {
    if (clientStatus === 'connecting' && !currentQr) {
      clientStatus = 'error';
      statusError = 'الـ QR ما ظهرش. اضغط فصل بعدين الاتصال تاني';
      initInProgress = false;
      console.error('❌ WhatsApp QR timeout');
      await destroyWhatsAppClient();
    }
  }, 90000);
  const clearQrWait = () => clearTimeout(qrWait);

  (async () => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const c = getClient();
      c.once('qr', clearQrWait);
      c.once('ready', clearQrWait);
      try {
        await c.initialize();
        initInProgress = false;
        return;
      } catch (e) {
        if (clientStatus === 'ready' || clientStatus === 'qr') {
          initInProgress = false;
          return;
        }
        await destroyWhatsAppClient();
        if (attempt < 2 && isContextDestroyedError(e)) {
          console.log('⚠️ WhatsApp page reloaded during connect — retrying once');
          clientStatus = 'connecting';
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        clearQrWait();
        clientStatus = 'error';
        statusError = isContextDestroyedError(e)
          ? 'فشل فتح واتساب ويب. اضغط الاتصال تاني'
          : (e?.message || 'فشل بدء العميل');
        initInProgress = false;
        console.error('❌ WhatsApp client error:', statusError);
        return;
      }
    }
  })();
  return getWhatsAppStatus();
}

export function getWhatsAppStatus() {
  return { status: clientStatus, qr: currentQr, error: statusError, info: readyInfo };
}

export async function listWhatsAppGroups() {
  if (clientStatus !== 'ready' || !client) return [];
  try {
    // Raw extraction: client.getChats() fails on some chats (IndexedDB error in new WA Web).
    // Group flag = chat.groupMetadata; name = formattedTitle.
    const groups = await client.pupPage.evaluate(() => {
      const req = window.require;
      const chats = req('WAWebCollections').Chat.getModelsArray();
      const out = [];
      for (const chat of chats) {
        try {
          if (!chat || !chat.groupMetadata) continue;
          let id = '';
          try { id = (chat.id && chat.id._serialized) || ''; } catch (e) { id = ''; }
          if (!id || !id.endsWith('@g.us')) continue;
          let name = '';
          try { name = chat.formattedTitle || chat.name || ''; } catch (e) { name = ''; }
          out.push({ id, name: name || id });
        } catch (e) { /* skip broken chat */ }
      }
      return out;
    });
    return Array.isArray(groups)
      ? groups.sort((a, b) => String(a.name).localeCompare(String(b.name), 'ar'))
      : [];
  } catch (e) {
    console.error('❌ Error listing WhatsApp groups:', e);
    return [];
  }
}

export async function setWhatsAppGroup(chatId, chatName) {
  const config = loadConfig();
  config.whatsapp = { ...(config.whatsapp || {}), enabled: true, chatId, chatName: chatName || '' };
  saveConfig(config);
  return config.whatsapp;
}

function wipeWhatsAppSession() {
  const dir = path.resolve(SESSION_DIR);
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    }
    return true;
  } catch (e) {
    console.log('⚠️ Could not wipe WhatsApp session:', e.message);
    return false;
  }
}

export async function disconnectWhatsAppClient() {
  clientStatus = 'disconnected';
  currentQr = null;
  readyInfo = null;
  initInProgress = false;
  const c = client;
  if (c) {
    try {
      await Promise.race([
        c.logout().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 8000))
      ]);
    } catch (_) {}
  }
  await destroyWhatsAppClient();
  await new Promise((resolve) => setTimeout(resolve, 400));
  wipeWhatsAppSession();
  return { status: 'disconnected', sessionCleared: true };
}

function buildWhatsAppMessage(options = {}) {
  return buildAppointmentTelegramMessage({ ...options, plainText: true });
}

function normalizeWhatsAppNumber(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0') && digits.length >= 10) digits = '20' + digits.slice(1);
  return digits;
}

function whatsappNumberCandidates(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  const out = [];
  const add = (n) => { if (n && !out.includes(n)) out.push(n); };
  if (/^01\d{9}$/.test(digits)) add(normalizeWhatsAppNumber(digits));
  if (/^01\d{10}$/.test(digits)) add(normalizeWhatsAppNumber(digits.slice(0, 11)));
  add(normalizeWhatsAppNumber(raw));
  if (digits.startsWith('0') && digits.length === 12) add(normalizeWhatsAppNumber(digits.slice(1)));
  return out;
}

export function waitForWhatsAppReady(timeoutMs = 25000) {
  if (clientStatus === 'ready' && client) return Promise.resolve(true);
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = setInterval(() => {
      if (clientStatus === 'ready' && client) {
        clearInterval(tick);
        resolve(true);
        return;
      }
      if (clientStatus === 'error' || clientStatus === 'qr' || Date.now() - started > timeoutMs) {
        clearInterval(tick);
        resolve(clientStatus === 'ready' && !!client);
      }
    }, 250);
  });
}

function reviveDates(options = {}) {
  const next = { ...options };
  for (const key of ['foundAtDate', 'requestSentDate', 'responseReceivedDate']) {
    if (next[key] && !(next[key] instanceof Date)) {
      const d = new Date(next[key]);
      next[key] = Number.isNaN(d.getTime()) ? next[key] : d;
    }
  }
  return next;
}

async function forwardWhatsAppToManager(options) {
  try {
    const res = await fetch('http://127.0.0.1:3004/api/whatsapp/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options)
    });
    const data = await res.json().catch(() => ({}));
    return !!(res.ok && data.success);
  } catch (_) {
    return false;
  }
}

export async function sendWhatsAppNotification(options = {}) {
  options = reviveDates(options);
  const config = loadConfig();
  const wa = config.whatsapp || {};
  const accounts = loadAccounts();
  const account = options.accountEmail
    ? accounts.find(a =>
        String(a.email || '').trim().toLowerCase() === String(options.accountEmail).trim().toLowerCase()
      )
    : null;

  if (account && account.whatsappEnabled === false) {
    return false;
  }

  if (clientStatus !== 'ready' || !client) {
    if (options._viaNotifyApi) return false;
    return forwardWhatsAppToManager(options);
  }

  const customerPhone = String(options.customerPhone || account?.customerPhone || '').trim();
  const numbers = whatsappNumberCandidates(customerPhone);
  const groupId = wa.chatId || '';
  if (numbers.length === 0 && !groupId) {
    console.log('⚠️ WhatsApp: مفيش رقم Phone على الحساب');
    return false;
  }

  const text = options.message || buildWhatsAppMessage({
    ...options,
    customerPhone: customerPhone || options.customerPhone
  });

  let sent = false;

  if (numbers.length > 0) {
    for (const customerNumber of numbers) {
      try {
        let chatId = `${customerNumber}@c.us`;
        try {
          const numberId = await client.getNumberId(customerNumber);
          if (numberId && numberId._serialized) chatId = numberId._serialized;
        } catch (_) {}
        await client.sendMessage(chatId, text);
        sent = true;
        break;
      } catch (e) {
        const msg = String(e?.message || e);
        if (/No LID for user/i.test(msg)) continue;
        console.error(`❌ WhatsApp customer send failed (${customerNumber}):`, msg);
      }
    }
  }

  if (groupId) {
    try {
      await client.sendMessage(groupId, text);
      sent = true;
    } catch (e) {
      console.error('❌ WhatsApp group send failed:', e?.message || e);
    }
  }

  return sent;
}

export async function sendWhatsAppTestMessage() {
  const now = new Date();
  const stamp = `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}, ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true })}`;
  return sendWhatsAppNotification({
    message: `✅ WhatsApp Integration Test

This is a test message from Visa Bot.
Integration is working correctly!

⏰ ${stamp}`
  });
}
