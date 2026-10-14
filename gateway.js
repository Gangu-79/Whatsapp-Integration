/**
 * WhatsApp Campaign Engine - Official Meta Cloud API Gateway
 * Policy-Compliant, Official Meta WhatsApp Business Platform Integration
 */

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const multer = require('multer');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Base Sessions Directory for user privacy and multi-user isolation
const sessionsBaseDir = path.join(__dirname, 'sessions');
if (!fs.existsSync(sessionsBaseDir)) fs.mkdirSync(sessionsBaseDir, { recursive: true });

function getSessionId(req) {
  const h = req.headers['x-session-id'] || req.query.sessionId || req.body?.sessionId;
  if (h && typeof h === 'string') {
    const cleaned = h.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    if (cleaned && cleaned.length >= 8) return cleaned;
  }
  // If invalid or missing, generate an isolated ephemeral guest ID
  return 'sess_anon_' + Date.now().toString(36);
}

function getSessionDir(req) {
  const sid = getSessionId(req);
  const dir = path.join(sessionsBaseDir, sid);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getSessionConfig(req) {
  const sid = getSessionId(req);
  if (sid.startsWith('sess_anon_')) return null; // Fresh unauthenticated visitor
  const dir = getSessionDir(req);
  const cfgPath = path.join(dir, 'config.json');
  if (fs.existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (cfg && cfg.token && cfg.phoneNumberId) return cfg;
    } catch (e) {}
  }
  return null;
}

function saveSessionConfig(req, data) {
  const dir = getSessionDir(req);
  const cfgPath = path.join(dir, 'config.json');
  let current = {};
  if (fs.existsSync(cfgPath)) {
    try { current = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) {}
  }
  const updated = { ...current, ...data };
  fs.writeFileSync(cfgPath, JSON.stringify(updated, null, 2), 'utf8');
  return updated;
}

function clearSessionConfig(req) {
  const sid = getSessionId(req);
  if (!sid || sid.startsWith('sess_anon_')) return;
  const dir = path.join(sessionsBaseDir, sid);
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (e) {
    console.error('[Session Reset Error]:', e.message);
  }
}


// Multer storage: Saves files directly inside the caller's private session folder
const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, getSessionDir(req)),
  filename: (req, file, cb) => {
    if (req.path.includes('excel')) cb(null, 'recipients.xlsx');
    else if (req.path.includes('image')) cb(null, 'campaign.jpg');
    else cb(null, file.originalname);
  }
});
const upload = multer({ storage: uploadStorage });

const optOutFilePath = path.join(__dirname, 'optouts.json');
const inboxFilePath = path.join(__dirname, 'inbox.json');

// Ensure optouts.json exists
if (!fs.existsSync(optOutFilePath)) {
  fs.writeFileSync(optOutFilePath, JSON.stringify({ opted_out_numbers: [], updated_at: new Date().toISOString() }, null, 2), 'utf8');
}

// Ensure global inbox.json exists
if (!fs.existsSync(inboxFilePath)) {
  fs.writeFileSync(inboxFilePath, JSON.stringify({ messages: [] }, null, 2), 'utf8');
}

// Serve Frontend UI
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================================
// OFFICIAL META WHATSAPP CLOUD API ENDPOINTS
// ============================================================================

// API: Get Meta Cloud API Connection & Business Profile Status (Session Isolated)
app.get('/api/status', async (req, res) => {
  const cfg = getSessionConfig(req);

  if (!cfg || !cfg.token || !cfg.phoneNumberId) {
    return res.json({
      connected: false,
      configured: false,
      state: 'unconfigured',
      provider: 'Meta WhatsApp Cloud API',
      phone: '',
      verifiedName: '',
      qualityRating: 'UNKNOWN',
      message: 'Meta Cloud API credentials not configured.'
    });
  }

  const { token, phoneNumberId, wabaId, templateName } = cfg;

  try {
    // Query Meta Graph API for the registered phone number status
    const graphUrl = `https://graph.facebook.com/v21.0/${phoneNumberId}?fields=verified_name,display_phone_number,quality_rating,code_verification_status,status`;
    const response = await axios.get(graphUrl, {
      headers: {
        Authorization: `Bearer ${token}`
      },
      timeout: 8000
    });

    const data = response.data;
    const phone = (data.display_phone_number || '').replace(/[^\d]/g, '');

    res.json({
      connected: true,
      configured: true,
      state: 'open',
      provider: 'Meta WhatsApp Cloud API',
      phone: phone || data.display_phone_number || phoneNumberId,
      verifiedName: data.verified_name || 'Verified WhatsApp Business',
      qualityRating: data.quality_rating || 'GREEN',
      codeStatus: data.code_verification_status || 'VERIFIED',
      phoneNumberId: phoneNumberId,
      wabaId: wabaId || '',
      templateName: templateName || 'campaign_update'
    });
  } catch (err) {
    const errorMsg = err.response?.data?.error?.message || err.message;
    console.error('[Meta API Status Error]:', errorMsg);
    res.json({
      connected: false,
      configured: true,
      state: 'error',
      provider: 'Meta WhatsApp Cloud API',
      phone: '',
      error: errorMsg,
      message: 'Failed to verify Meta Cloud API token or Phone Number ID.'
    });
  }
});

// API: Save/Update Meta Cloud API credentials in private session
app.post('/api/config', async (req, res) => {
  const { token, phoneNumberId, wabaId, templateName } = req.body;
  const toSave = {};

  if (token && typeof token === 'string' && token.trim()) {
    toSave.token = token.trim();
  }
  if (phoneNumberId && typeof phoneNumberId === 'string' && phoneNumberId.trim()) {
    toSave.phoneNumberId = phoneNumberId.trim();
  }
  if (wabaId && typeof wabaId === 'string') {
    toSave.wabaId = wabaId.trim();
  }
  if (templateName && typeof templateName === 'string') {
    toSave.templateName = templateName.trim();
  }

  saveSessionConfig(req, toSave);
  res.json({ success: true, message: 'Configuration saved to your private session.' });
});

// API: Disconnect / Clear Meta Credentials for current user
app.post('/api/logout', (req, res) => {
  try {
    clearSessionConfig(req);
    res.json({
      success: true,
      message: 'Disconnected successfully! Your private session has been reset.'
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================================
// META WEBHOOKS (Delivery Receipts & Opt-Out Handling)
// ============================================================================

// Webhook Verification (Meta Hub Challenge)
app.get('/api/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const expectedToken = getEnv('WEBHOOK_VERIFY_TOKEN') || 'whatsapp_campaign_verify_token_123';

  if (mode === 'subscribe' && token === expectedToken) {
    console.log('[Meta Webhook] Successfully verified webhook subscription challenge.');
    return res.status(200).send(challenge);
  }
  res.status(403).send('Forbidden');
});

// Webhook Listener (Delivery Status & STOP/UNSUBSCRIBE Messages)
app.post('/api/webhook', (req, res) => {
  const body = req.body;

  if (body.object === 'whatsapp_business_account') {
    const entries = body.entry || [];
    for (const entry of entries) {
      const changes = entry.changes || [];
      for (const change of changes) {
        const value = change.value || {};

        // 1. Process delivery statuses (sent, delivered, read, failed)
        if (value.statuses) {
          for (const status of value.statuses) {
            console.log(`[Meta Webhook] Status: ${status.status} | Recipient: ${status.recipient_id} | Msg ID: ${status.id}`);
          }
        }

        // 2. Process incoming messages (Save to Session Inbox & Handle Opt-Out)
        if (value.messages) {
          const contacts = value.contacts || [];
          const contactName = contacts[0]?.profile?.name || '';
          const targetPhoneId = value.metadata?.phone_number_id || '';

          for (const msg of value.messages) {
            const from = msg.from;
            const rawText = msg.text?.body || msg.button?.text || msg.interactive?.button_reply?.title || '';
            const textUpper = rawText.trim().toUpperCase();
            const timestamp = msg.timestamp ? new Date(parseInt(msg.timestamp) * 1000).toISOString() : new Date().toISOString();
            const msgObj = {
              id: msg.id || 'msg_' + Date.now(),
              from,
              name: contactName,
              text: rawText,
              timestamp,
              type: msg.type || 'text',
              targetPhoneId
            };

            // Save to global inbox
            try {
              let inboxData = { messages: [] };
              if (fs.existsSync(inboxFilePath)) {
                inboxData = JSON.parse(fs.readFileSync(inboxFilePath, 'utf8'));
              }
              inboxData.messages.unshift(msgObj);
              if (inboxData.messages.length > 200) inboxData.messages = inboxData.messages.slice(0, 200);
              fs.writeFileSync(inboxFilePath, JSON.stringify(inboxData, null, 2), 'utf8');
            } catch (e) {}

            // Save to matching session inboxes
            try {
              if (fs.existsSync(sessionsBaseDir)) {
                const sessionIds = fs.readdirSync(sessionsBaseDir);
                for (const sid of sessionIds) {
                  const sCfgPath = path.join(sessionsBaseDir, sid, 'config.json');
                  if (fs.existsSync(sCfgPath)) {
                    try {
                      const scfg = JSON.parse(fs.readFileSync(sCfgPath, 'utf8'));
                      if (!targetPhoneId || scfg.phoneNumberId === targetPhoneId) {
                        const sInboxPath = path.join(sessionsBaseDir, sid, 'inbox.json');
                        let sInbox = { messages: [] };
                        if (fs.existsSync(sInboxPath)) sInbox = JSON.parse(fs.readFileSync(sInboxPath, 'utf8'));
                        sInbox.messages.unshift(msgObj);
                        if (sInbox.messages.length > 200) sInbox.messages = sInbox.messages.slice(0, 200);
                        fs.writeFileSync(sInboxPath, JSON.stringify(sInbox, null, 2), 'utf8');
                      }
                    } catch (e) {}
                  }
                }
              }
            } catch (e) {
              console.error('[Session Inbox Error]:', e.message);
            }

            // Check Opt-Out Keywords (STOP, UNSUBSCRIBE, CANCEL)
            if (['STOP', 'UNSUBSCRIBE', 'CANCEL', 'OPTOUT'].includes(textUpper)) {
              console.log(`[Meta Webhook] Received Opt-Out keyword from +${from}. Adding to permanent exclusion list.`);
              try {
                let optData = { opted_out_numbers: [] };
                if (fs.existsSync(optOutFilePath)) {
                  optData = JSON.parse(fs.readFileSync(optOutFilePath, 'utf8'));
                }
                if (!optData.opted_out_numbers.includes(from)) {
                  optData.opted_out_numbers.push(from);
                  optData.updated_at = new Date().toISOString();
                  fs.writeFileSync(optOutFilePath, JSON.stringify(optData, null, 2), 'utf8');
                }
              } catch (e) {
                console.error('[Opt-Out Error]:', e.message);
              }
            }
          }
        }
      }
    }
    return res.status(200).send('EVENT_RECEIVED');
  }
  res.sendStatus(404);
});

// API: Get Inbox Messages for caller's private session (Strictly isolated)
app.get('/api/inbox', (req, res) => {
  try {
    const cfg = getSessionConfig(req);
    if (!cfg) {
      return res.json({ success: true, count: 0, messages: [], unconfigured: true });
    }
    const sInboxPath = path.join(getSessionDir(req), 'inbox.json');
    let inboxData = { messages: [] };
    if (fs.existsSync(sInboxPath)) {
      try {
        inboxData = JSON.parse(fs.readFileSync(sInboxPath, 'utf8'));
      } catch (err) {}
    }
    res.json({ success: true, count: (inboxData.messages || []).length, messages: inboxData.messages || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Quick Reply to Candidate via Meta Cloud API using caller's private credentials
app.post('/api/inbox/reply', async (req, res) => {
  const { to, message } = req.body;
  const cfg = getSessionConfig(req);

  if (!cfg || !cfg.token || !cfg.phoneNumberId) {
    return res.status(401).json({ error: 'Meta Cloud API not configured in this session. Please connect your credentials.' });
  }
  if (!to || !message || !message.trim()) {
    return res.status(400).json({ error: 'Recipient phone number and reply message are required.' });
  }

  try {
    const cleanPhone = to.replace(/\D/g, '');
    const metaUrl = `https://graph.facebook.com/v21.0/${cfg.phoneNumberId}/messages`;
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanPhone,
      type: 'text',
      text: { preview_url: false, body: message.trim() }
    };

    const response = await axios.post(metaUrl, payload, {
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });

    const sentMsgId = response.data.messages?.[0]?.id || 'reply_' + Date.now();

    // Persist outgoing reply into caller's private session inbox for full conversation history
    try {
      const sInboxPath = path.join(getSessionDir(req), 'inbox.json');
      let sInbox = { messages: [] };
      if (fs.existsSync(sInboxPath)) {
        try { sInbox = JSON.parse(fs.readFileSync(sInboxPath, 'utf8')); } catch (e) {}
      }
      sInbox.messages = sInbox.messages || [];
      sInbox.messages.unshift({
        id: sentMsgId,
        from: cfg.phoneNumberId,
        to: cleanPhone,
        direction: 'outgoing',
        name: 'You',
        text: message.trim(),
        timestamp: new Date().toISOString(),
        type: 'text',
        targetPhoneId: cfg.phoneNumberId
      });
      if (sInbox.messages.length > 250) sInbox.messages = sInbox.messages.slice(0, 250);
      fs.writeFileSync(sInboxPath, JSON.stringify(sInbox, null, 2), 'utf8');
    } catch (saveErr) {
      console.error('[Save Outgoing Reply Warning]:', saveErr.message);
    }

    res.json({ success: true, messageId: sentMsgId });
  } catch (e) {
    const errText = e.response?.data?.error?.message || e.message;
    console.error('[Meta Reply API Error]:', errText);
    res.status(500).json({ error: errText });
  }
});

// ============================================================================
// EXCEL & CAMPAIGN DISPATCH ENDPOINTS (Private Per-Session Isolation)
// ============================================================================

// API: Upload Excel recipients file for current session
app.post('/api/upload/excel', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  res.json({ success: true, filename: req.file.originalname, saved: 'recipients.xlsx' });
});

// API: Delete Excel recipients file for current session
app.delete('/api/delete-excel', (req, res) => {
  try {
    const exPath = path.join(getSessionDir(req), 'recipients.xlsx');
    if (fs.existsSync(exPath)) fs.unlinkSync(exPath);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Upload campaign image for current session
app.post('/api/upload/image', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  res.json({ success: true, filename: req.file.originalname, saved: 'campaign.jpg' });
});

// API: Delete campaign image for current session
app.delete('/api/delete-image', (req, res) => {
  try {
    const imgPath = path.join(getSessionDir(req), 'campaign.jpg');
    if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Check status of files for current session
app.get('/api/files-status', (req, res) => {
  const dir = getSessionDir(req);
  const exPath = path.join(dir, 'recipients.xlsx');
  const imPath = path.join(dir, 'campaign.jpg');
  let optOutCount = 0;
  try {
    if (fs.existsSync(optOutFilePath)) {
      const data = JSON.parse(fs.readFileSync(optOutFilePath, 'utf8'));
      optOutCount = (data.opted_out_numbers || []).length;
    }
  } catch (e) {}

  res.json({
    excelExists: fs.existsSync(exPath),
    imageExists: fs.existsSync(imPath),
    optOutCount: optOutCount
  });
});

// API: Parse Excel recipients with Consent Verification & Preview for current session
app.get('/api/recipients', (req, res) => {
  const exPath = path.join(getSessionDir(req), 'recipients.xlsx');
  if (!fs.existsSync(exPath)) {
    return res.json({ exists: false, total: 0, valid: 0, consented: 0, non_consented: 0, duplicates: 0, invalid: 0, opted_out: 0, preview: [] });
  }

  const pythonCmd = process.platform === 'win32' ? 'python' : (process.env.PYTHON_CMD || 'python3');
  const py = spawn(pythonCmd, ['-u', 'send_campaign.py', '--excel', exPath, '--optouts', optOutFilePath, '--preview'], { cwd: __dirname });
  let stdout = '';
  let stderr = '';

  py.stdout.on('data', chunk => stdout += chunk.toString());
  py.stderr.on('data', chunk => stderr += chunk.toString());

  py.on('close', code => {
    try {
      const data = JSON.parse(stdout.trim());
      res.json({ exists: true, ...data });
    } catch (e) {
      res.status(500).json({ error: 'Failed to parse Excel file', details: stdout || stderr });
    }
  });
});

// API: Save message text for current session
app.post('/api/save-message', (req, res) => {
  const { message } = req.body;
  if (typeof message !== 'string') return res.status(400).json({ error: 'Invalid message.' });
  fs.writeFileSync(path.join(getSessionDir(req), 'message.txt'), message, 'utf8');
  res.json({ success: true });
});

// API: Get current message text for current session
app.get('/api/get-message', (req, res) => {
  try {
    const msgPath = path.join(getSessionDir(req), 'message.txt');
    if (fs.existsSync(msgPath)) {
      return res.json({ message: fs.readFileSync(msgPath, 'utf8') });
    }
    res.json({ message: 'Hello {{name}},\nThank you for choosing our service!' });
  } catch (e) {
    res.json({ message: 'Hello {{name}},\nThank you for choosing our service!' });
  }
});

// API: Get campaign image as base64 for preview for current session
app.get('/api/preview-image', (req, res) => {
  try {
    const imgPath = path.join(getSessionDir(req), 'campaign.jpg');
    if (!fs.existsSync(imgPath)) return res.json({ image: null });
    const data = fs.readFileSync(imgPath);
    res.json({ image: 'data:image/jpeg;base64,' + data.toString('base64') });
  } catch (e) {
    res.json({ image: null });
  }
});

// API: Streaming Campaign Dispatcher via Official Meta Cloud API (Session Isolated)
app.get('/api/stream-campaign', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const cfg = getSessionConfig(req);

  if (!cfg || !cfg.token || !cfg.phoneNumberId) {
    res.write(`data: ${JSON.stringify({
      type: 'error',
      text: '[Configuration Error] Meta WhatsApp Cloud API credentials missing! Please configure Phone Number ID and Permanent Access Token in Card 01.'
    })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'finish', exitCode: 1 })}\n\n`);
    return res.end();
  }

  const sDir = getSessionDir(req);
  const exPath = path.join(sDir, 'recipients.xlsx');
  const msgPath = path.join(sDir, 'message.txt');
  const imgPath = path.join(sDir, 'campaign.jpg');

  if (!fs.existsSync(exPath)) {
    res.write(`data: ${JSON.stringify({
      type: 'error',
      text: '[Excel Error] No recipients.xlsx file found. Please upload your Excel list in Card 02 before launching.'
    })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'finish', exitCode: 1 })}\n\n`);
    return res.end();
  }

  res.write(`data: ${JSON.stringify({ type: 'log', text: 'Connecting to Official Meta WhatsApp Cloud API...' })}\n\n`);

  const pythonCmd = process.platform === 'win32' ? 'python' : (process.env.PYTHON_CMD || 'python3');
  const pyArgs = [
    '-u', 'send_campaign.py',
    '--excel', exPath,
    '--message', fs.existsSync(msgPath) ? msgPath : path.join(__dirname, 'message.txt'),
    '--image', fs.existsSync(imgPath) ? imgPath : 'campaign.jpg',
    '--token', cfg.token,
    '--phone-id', cfg.phoneNumberId,
    '--template', cfg.templateName || '',
    '--optouts', optOutFilePath
  ];

  const py = spawn(pythonCmd, pyArgs, {
    cwd: __dirname,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }
  });

  py.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    res.write(`data: ${JSON.stringify({ type: 'log', text })}\n\n`);
  });

  py.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    res.write(`data: ${JSON.stringify({ type: 'error', text })}\n\n`);
  });

  py.on('close', (exitCode) => {
    res.write(`data: ${JSON.stringify({ type: 'finish', exitCode })}\n\n`);
    res.end();
  });
});

const PORT = process.env.PORT || 8085;
app.listen(PORT, () => {
  console.log(`[Official WhatsApp Cloud API Gateway] Server running on port ${PORT}`);
});
