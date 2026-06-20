const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const pino = require('pino');

const app = express();
app.use(cors({
  origin: 'https://lightslategrey-cod-160946.hostingersite.com',
  methods: ['GET', 'POST']
}));
app.use(express.json());
// ── State ──────────────────────────────────────────────────────────────────
let sock = null;
let currentQR = null;
let connectionStatus = 'disconnected'; // disconnected | connecting | connected
let campaign = {
  running: false,
  total: 0,
  sent: 0,
  failed: 0,
  pending: 0,
  log: [],          // [{ number, name, status, time }]
  startedAt: null,
  aborted: false,
};

const AUTH_FOLDER = path.join(__dirname, 'auth_info');
const logger = pino({ level: 'silent' });

// ── Helpers ────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDelay(min = 5000, max = 15000) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function formatNumber(num) {
  // Remove spaces, dashes, +
  let n = num.toString().replace(/[\s\-\+]/g, '');
  // If Indian number without country code
  if (n.length === 10 && n.startsWith('9') || n.length === 10 && n.startsWith('8') || n.length === 10 && n.startsWith('7') || n.length === 10 && n.startsWith('6')) {
    n = '91' + n;
  }
  return n + '@s.whatsapp.net';
}

function personalizeMessage(template, contact) {
  let msg = template;
  Object.keys(contact).forEach(key => {
    const regex = new RegExp(`\\{${key}\\}`, 'gi');
    msg = msg.replace(regex, contact[key] || '');
  });
  return msg;
}

// ── WhatsApp Connection ────────────────────────────────────────────────────
async function connectToWhatsApp() {
  if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger,
    browser: ['AutomateMinds Bulk', 'Chrome', '1.0.0'],
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = await qrcode.toDataURL(qr);
      connectionStatus = 'connecting';
      console.log('QR generated');
    }

    if (connection === 'close') {
      currentQR = null;
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
        : true;

      connectionStatus = 'disconnected';
      console.log('Connection closed. Reconnecting:', shouldReconnect);

      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 3000);
      }
    } else if (connection === 'open') {
      currentQR = null;
      connectionStatus = 'connected';
      console.log('WhatsApp connected!');
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

// ── Bulk Send Logic ────────────────────────────────────────────────────────
async function runCampaign(contacts, messageTemplate, delayMin, delayMax) {
  campaign.running = true;
  campaign.aborted = false;
  campaign.total = contacts.length;
  campaign.sent = 0;
  campaign.failed = 0;
  campaign.pending = contacts.length;
  campaign.log = [];
  campaign.startedAt = new Date().toISOString();

  for (let i = 0; i < contacts.length; i++) {
    if (campaign.aborted) {
      console.log('Campaign aborted by user');
      break;
    }

    const contact = contacts[i];
    const number = contact.phone || contact.mobile || contact.number || contact.Phone || contact.Mobile;
    const name = contact.name || contact.Name || 'Friend';

    if (!number) {
      campaign.failed++;
      campaign.pending--;
      campaign.log.push({ number: 'unknown', name, status: 'failed', reason: 'No phone number', time: new Date().toISOString() });
      continue;
    }

    try {
      const jid = formatNumber(number);
      const message = personalizeMessage(messageTemplate, { ...contact, name });

      await sock.sendMessage(jid, { text: message });

      campaign.sent++;
      campaign.pending--;
      campaign.log.push({ number, name, status: 'sent', time: new Date().toISOString() });
      console.log(`✓ Sent to ${name} (${number})`);
    } catch (err) {
      campaign.failed++;
      campaign.pending--;
      campaign.log.push({ number, name, status: 'failed', reason: err.message, time: new Date().toISOString() });
      console.log(`✗ Failed for ${name} (${number}):`, err.message);
    }

    // Delay between messages (skip delay after last message)
    if (i < contacts.length - 1 && !campaign.aborted) {
      const delay = randomDelay(delayMin, delayMax);
      console.log(`Waiting ${delay}ms before next message...`);
      await sleep(delay);
    }
  }

  campaign.running = false;
  console.log(`Campaign done. Sent: ${campaign.sent}, Failed: ${campaign.failed}`);
}

// ── API Routes ─────────────────────────────────────────────────────────────

// GET /status → connection status + phone info
app.get('/status', (req, res) => {
  res.json({
    status: connectionStatus,
    hasQR: !!currentQR,
    phone: sock?.user ? { name: sock.user.name, id: sock.user.id } : null,
  });
});

// GET /qr → base64 QR image
app.get('/qr', (req, res) => {
  if (!currentQR) {
    return res.json({ qr: null, message: connectionStatus === 'connected' ? 'Already connected' : 'QR not ready yet' });
  }
  res.json({ qr: currentQR });
});

// POST /disconnect → logout and clear session
app.post('/disconnect', async (req, res) => {
  try {
    if (sock) await sock.logout();
    // Clear auth files
    if (fs.existsSync(AUTH_FOLDER)) {
      fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
    }
    connectionStatus = 'disconnected';
    currentQR = null;
    sock = null;
    res.json({ success: true, message: 'Disconnected and session cleared' });
    // Restart fresh connection
    setTimeout(connectToWhatsApp, 1000);
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// POST /bulk-send → start campaign
app.post('/bulk-send', (req, res) => {
  if (connectionStatus !== 'connected') {
    return res.status(400).json({ error: 'WhatsApp not connected. Scan QR first.' });
  }
  if (campaign.running) {
    return res.status(400).json({ error: 'A campaign is already running.' });
  }

  const { contacts, message, delayMin = 5000, delayMax = 15000 } = req.body;

  if (!contacts || !contacts.length) {
    return res.status(400).json({ error: 'No contacts provided.' });
  }
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message is required.' });
  }

  // Start async — don't await
  runCampaign(contacts, message, delayMin, delayMax);

  res.json({ success: true, message: `Campaign started for ${contacts.length} contacts.` });
});

// GET /campaign-status → live progress
app.get('/campaign-status', (req, res) => {
  res.json(campaign);
});

// POST /abort → stop running campaign
app.post('/abort', (req, res) => {
  if (!campaign.running) {
    return res.json({ success: false, message: 'No campaign running.' });
  }
  campaign.aborted = true;
  res.json({ success: true, message: 'Abort signal sent. Will stop after current message.' });
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => { console.log(`Baileys service running on port ${PORT}`); connectToWhatsApp();
});
