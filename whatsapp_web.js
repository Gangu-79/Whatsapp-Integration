/**
 * WhatsApp Web Automation Engine (Baileys)
 * 100% Free-of-cost sending via WhatsApp Web Multi-Device Socket.
 * Requires NO Meta Token, NO WABA ID, NO Meta Credit Card, and NO Template Approvals.
 */

const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const pino = require('pino');

let baileys = null;
try {
  baileys = require('@whiskeysockets/baileys');
} catch (e) {
  console.warn('[WhatsApp Web] Baileys module not loaded:', e.message);
}

const makeWASocket = baileys?.default || baileys?.makeWASocket;
const { useMultiFileAuthState, DisconnectReason } = baileys || {};

const AUTH_DIR = path.join(__dirname, 'data', 'baileys_auth');

let sock = null;
let connectionStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'qr_ready' | 'code_ready' | 'connected'
let currentQrCodeDataUrl = null;
let currentQrRaw = null;
let currentPairingCode = null;
let currentPairingPhone = null;
let connectedUser = null;
let lastError = null;
let reconnectTimer = null;
let onIncomingMessageCallback = null;

// Ensure auth directory exists
if (!fs.existsSync(AUTH_DIR)) {
  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  } catch (e) {}
}

/**
 * Format phone to international digits without special characters
 */
function cleanPhoneNumber(phone) {
  if (!phone) return '';
  let digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10) digits = '91' + digits; // Default India prefix
  return digits;
}

/**
 * Normalize phone number to WhatsApp JID format (e.g. 919876543210@s.whatsapp.net)
 */
function toJid(phone) {
  const clean = cleanPhoneNumber(phone);
  if (!clean) return null;
  return `${clean}@s.whatsapp.net`;
}

/**
 * Register callback for incoming messages received via WhatsApp Web
 */
function onIncomingMessage(cb) {
  onIncomingMessageCallback = cb;
}

/**
 * Initialize WhatsApp Web Socket Connection
 */
async function initWhatsAppWeb(forceNew = false) {
  if (!makeWASocket || !useMultiFileAuthState) {
    throw new Error('Baileys library is not installed or available.');
  }

  if (sock && connectionStatus === 'connected' && !forceNew) {
    return { status: 'connected', user: connectedUser };
  }

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  connectionStatus = 'connecting';
  lastError = null;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['WhatsApp Engine', 'Chrome', '120.0.6099.109'],
      connectTimeoutMs: 30000,
      keepAliveIntervalMs: 25000,
      syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQrRaw = qr;
        try {
          currentQrCodeDataUrl = await QRCode.toDataURL(qr, {
            margin: 2,
            width: 320,
            color: { dark: '#000000', light: '#ffffff' }
          });
          connectionStatus = 'qr_ready';
          console.log('[WhatsApp Web] New QR Code generated. Ready for scanning in UI.');
        } catch (qrErr) {
          console.error('[WhatsApp Web] QR Generation Error:', qrErr.message);
        }
      }

      if (connection === 'open') {
        connectionStatus = 'connected';
        currentQrCodeDataUrl = null;
        currentQrRaw = null;
        currentPairingCode = null;
        currentPairingPhone = null;

        const rawId = sock?.user?.id || '';
        const cleanPhone = rawId.split(':')[0].split('@')[0];
        const name = sock?.user?.name || sock?.user?.verifiedName || 'WhatsApp User';

        connectedUser = {
          id: rawId,
          phone: cleanPhone,
          name: name
        };

        console.log(`[WhatsApp Web] Successfully connected! User: ${name} (+${cleanPhone})`);
      } else if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason = lastDisconnect?.error?.message || 'Connection closed';
        lastError = reason;

        console.log(`[WhatsApp Web] Connection closed (code: ${statusCode}, reason: ${reason})`);

        const isLoggedOut = statusCode === DisconnectReason?.loggedOut || statusCode === 401;

        if (isLoggedOut) {
          connectionStatus = 'disconnected';
          connectedUser = null;
          currentQrCodeDataUrl = null;
          currentPairingCode = null;
          currentPairingPhone = null;
          try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            fs.mkdirSync(AUTH_DIR, { recursive: true });
          } catch (e) {}
          console.log('[WhatsApp Web] Device logged out. Session credentials cleared.');
          reconnectTimer = setTimeout(() => {
            initWhatsAppWeb().catch((e) => console.warn('[WhatsApp Web Re-init Error]:', e.message));
          }, 2000);
        } else {
          connectionStatus = 'connecting';
          console.log('[WhatsApp Web] Reconnecting in 4 seconds...');
          reconnectTimer = setTimeout(() => {
            initWhatsAppWeb().catch((e) => console.warn('[WhatsApp Web Reconnect Error]:', e.message));
          }, 4000);
        }
      }
    });

    // Listen for incoming messages
    sock.ev.on('messages.upsert', async (m) => {
      if (!m.messages || m.messages.length === 0) return;
      for (const msg of m.messages) {
        if (!msg.key.fromMe && onIncomingMessageCallback) {
          try {
            const senderJid = msg.key.remoteJid;
            const phone = senderJid ? senderJid.split('@')[0] : '';
            const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
            const pushName = msg.pushName || '';
            onIncomingMessageCallback({
              phone,
              text,
              name: pushName,
              timestamp: new Date((msg.messageTimestamp || Date.now() / 1000) * 1000).toISOString(),
              messageId: msg.key.id
            });
          } catch (e) {}
        }
      }
    });

    return { status: connectionStatus, user: connectedUser };
  } catch (err) {
    connectionStatus = 'disconnected';
    lastError = err.message;
    console.error('[WhatsApp Web Init Error]:', err.message);
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        initWhatsAppWeb().catch((e) => console.warn('[WhatsApp Web Retry Error]:', e.message));
      }, 5000);
    }
    throw err;
  }
}

/**
 * Get current status of WhatsApp Web engine
 */
function getWhatsAppWebStatus() {
  if (connectionStatus === 'disconnected' && !sock && !reconnectTimer) {
    initWhatsAppWeb().catch(() => {});
  }
  return {
    status: connectionStatus,
    connected: connectionStatus === 'connected',
    qrCode: currentQrCodeDataUrl,
    pairingCode: currentPairingCode,
    pairingPhone: currentPairingPhone,
    user: connectedUser,
    error: lastError
  };
}

/**
 * Request an 8-character Pairing Code for Linking with Phone Number
 * WhatsApp allows users to link devices without scanning QR by entering this code in their phone.
 */
async function requestPairingCode(phone) {
  if (!phone) {
    throw new Error('Phone number is required to generate pairing code.');
  }

  const cleanPhone = cleanPhoneNumber(phone);
  if (!cleanPhone || cleanPhone.length < 10) {
    throw new Error('Invalid phone number. Please enter a valid 10-digit number with country code (e.g. 919876543210).');
  }

  if (sock && connectionStatus === 'connected') {
    return { status: 'already_connected', user: connectedUser };
  }

  // Ensure socket is initialized
  if (!sock || connectionStatus === 'disconnected') {
    await initWhatsAppWeb(false);
  }

  // Wait for the WebSocket connection to open (up to 8-10 seconds)
  let waitAttempts = 0;
  while ((!sock?.ws || !sock.ws.isOpen) && waitAttempts < 25) {
    await new Promise(res => setTimeout(res, 250));
    waitAttempts++;
  }

  if (!sock?.ws || !sock.ws.isOpen) {
    throw new Error('Connecting to WhatsApp servers timed out. Please try again.');
  }

  try {
    const rawCode = await sock.requestPairingCode(cleanPhone);
    const formattedCode = rawCode?.length === 8 ? `${rawCode.slice(0, 4)}-${rawCode.slice(4)}` : (rawCode || '');
    currentPairingCode = formattedCode;
    currentPairingPhone = cleanPhone;
    connectionStatus = 'code_ready';

    console.log(`[WhatsApp Web] Generated pairing code for +${cleanPhone}: ${formattedCode}`);

    return {
      success: true,
      status: 'code_ready',
      pairingCode: formattedCode,
      phone: cleanPhone
    };
  } catch (err) {
    console.error(`[WhatsApp Web Pairing Code Error for ${cleanPhone}]:`, err.message);
    throw new Error('WhatsApp pairing code error: ' + err.message);
  }
}

/**
 * Disconnect and logout WhatsApp Web
 */
async function disconnectWhatsAppWeb() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (sock) {
    try {
      await sock.logout().catch(() => {});
      sock.end();
    } catch (e) {}
    sock = null;
  }

  connectionStatus = 'disconnected';
  connectedUser = null;
  currentQrCodeDataUrl = null;
  currentQrRaw = null;
  currentPairingCode = null;
  currentPairingPhone = null;

  try {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  } catch (e) {}

  return { success: true, message: 'WhatsApp Web disconnected and session cleared.' };
}

/**
 * Send WhatsApp Message via Connected WhatsApp Web Socket
 * Handles text, image, video, and document (PDF) attachments.
 */
async function sendWhatsAppWebMessage({
  to,
  text = '',
  mediaPath = null,
  mediaType = 'image',
  filename = 'attachment.pdf'
}) {
  if (!sock || connectionStatus !== 'connected') {
    return {
      success: false,
      code: 'NOT_CONNECTED',
      error: 'WhatsApp Web is not connected. Please scan the QR code to link your phone.'
    };
  }

  const jid = toJid(to);
  if (!jid) {
    return {
      success: false,
      code: 'INVALID_PHONE',
      error: `Invalid phone number: '${to}'.`
    };
  }

  try {
    let result = null;

    if (mediaPath && fs.existsSync(mediaPath)) {
      const buffer = fs.readFileSync(mediaPath);
      const ext = path.extname(mediaPath).toLowerCase();

      if (mediaType === 'document' || ext === '.pdf') {
        result = await sock.sendMessage(jid, {
          document: buffer,
          mimetype: 'application/pdf',
          fileName: filename || path.basename(mediaPath),
          caption: text || ''
        });
      } else if (mediaType === 'video' || ext === '.mp4' || ext === '.3gp' || ext === '.3gpp') {
        result = await sock.sendMessage(jid, {
          video: buffer,
          mimetype: ext === '.mp4' ? 'video/mp4' : 'video/3gpp',
          caption: text || ''
        });
      } else {
        result = await sock.sendMessage(jid, {
          image: buffer,
          mimetype: ext === '.png' ? 'image/png' : 'image/jpeg',
          caption: text || ''
        });
      }
    } else {
      result = await sock.sendMessage(jid, {
        text: text || ''
      });
    }

    const messageId = result?.key?.id || `wweb_${Date.now()}`;
    return {
      success: true,
      messageId,
      recipient: cleanPhoneNumber(to),
      engine: 'whatsapp_web'
    };
  } catch (err) {
    console.error(`[WhatsApp Web Send Error to ${to}]:`, err.message);
    return {
      success: false,
      error: err.message,
      recipient: cleanPhoneNumber(to),
      engine: 'whatsapp_web'
    };
  }
}

module.exports = {
  initWhatsAppWeb,
  getWhatsAppWebStatus,
  requestPairingCode,
  disconnectWhatsAppWeb,
  sendWhatsAppWebMessage,
  onIncomingMessage,
  cleanPhoneNumber
};
