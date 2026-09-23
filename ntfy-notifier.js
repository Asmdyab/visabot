// ntfy-notifier.js - Desktop push notifications via ntfy.sh (free, no account)
// The bot publishes to a private topic when an appointment is found.
// The desktop listener (appointment-notifier.js) shows a popup on YOUR PC.
//
// NOTE: The bot itself calls sendTelegramNotification() (telegram-notifier.js),
// which also triggers the desktop push via its embedded sender. This file is
// kept as a standalone utility in case you want to trigger a push directly.

import { fetch } from 'undici';
import fs from 'fs';

const CONFIG_FILE = 'visa-bot-api-config.json';

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) {
    console.log('⚠️ Error loading config for ntfy');
  }
  return {};
}

/**
 * Get effective ntfy config or null when disabled/invalid
 */
export function getNtfyConfig() {
  const config = loadConfig();
  const ntfy = config.ntfy;
  if (!ntfy || ntfy.enabled !== true) return null;
  const topic = String(ntfy.topic || '').trim();
  if (!topic) return null;
  return {
    server: String(ntfy.server || 'https://ntfy.sh').replace(/\/+$/, ''),
    topic,
    title: ntfy.title || 'APPOINTMENT FOUND!',
    botName: String(ntfy.botName || '').trim()
  };
}

/**
 * Send a desktop push notification via ntfy.sh
 * @returns {Promise<boolean>} true if published successfully
 */
export async function sendNtfyNotification(options = {}) {
  const cfg = getNtfyConfig();
  if (!cfg) return false;

  const lines = [
    '🎉 APPOINTMENT FOUND! 🎉',
    '',
    `Bot: ${cfg.botName || 'البوت'}`,
    `📧 ${options.accountEmail || 'N/A'}`,
    `👱 ${options.customerFor || '-'}`,
    `📱 ${options.customerPhone || '-'}`,
    `🏢 ${options.office || 'N/A'}`,
    `🛂 ${options.visaType || 'N/A'}`,
    `📅 ${options.foundAt || new Date().toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'medium', hour12: true })}`
  ];
  const body = lines.join('\n');
  const encoder = new TextEncoder();
  const bodyBytes = encoder.encode(body);

  try {
    const response = await fetch(`${cfg.server}/${encodeURIComponent(cfg.topic)}`, {
      method: 'POST',
      headers: {
        'Title': /^[\x20-\x7E]+$/.test(String(cfg.title || '')) ? cfg.title : 'APPOINTMENT FOUND!',
        'Priority': 'max',
        'Tags': 'rotating_light'
      },
      body: bodyBytes
    });

    return response.ok;
  } catch (e) {
    console.log(`❌ Error sending desktop push notification: ${e.message}`);
    return false;
  }
}