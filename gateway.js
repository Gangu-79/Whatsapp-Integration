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

// Multer storage: Excel -> recipients.xlsx, image -> campaign.jpg
const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, __dirname),
  filename: (req, file, cb) => {
    if (req.path.includes('excel')) cb(null, 'recipients.xlsx');
    else if (req.path.includes('image')) cb(null, 'campaign.jpg');
    else cb(null, file.originalname);
  }
});
const upload = multer({ storage: uploadStorage });

const optOutFilePath = path.join(__dirname, 'optouts.json');

// Ensure optouts.json exists
if (!fs.existsSync(optOutFilePath)) {
  fs.writeFileSync(optOutFilePath, JSON.stringify({ opted_out_numbers: [], updated_at: new Date().toISOString() }, null, 2), 'utf8');
}

// Helper to read .env
function getEnv(key) {
  try {
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, 'utf8');
      for (const line of envContent.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith(key + '=')) {
          return trimmed.substring(key.length + 1).trim();
        }
      }
    }
  } catch (e) {}
  return process.env[key] || '';
}

// Helper to update keys in .env safely
function setEnv(key, value) {
  try {
    const envPath = path.join(__dirname, '.env');
    let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      content += `\n${key}=${value}`;
    }
    fs.writeFileSync(envPath, content, 'utf8');
    process.env[key] = value;
  } catch (e) {
    console.error('Failed to update .env:', e.message);
  }
}

// Serve Frontend UI
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================================
// OFFICIAL META WHATSAPP CLOUD API ENDPOINTS
// ============================================================================

// API: Get Meta Cloud API Connection & Business Profile Status
app.get('/api/status', async (req, res) => {
  const token = getEnv('WHATSAPP_TOKEN');
  const phoneNumberId = getEnv('WHATSAPP_PHONE_NUMBER_ID');
  const wabaId = getEnv('WHATSAPP_BUSINESS_ACCOUNT_ID');
  const templateName = getEnv('WHATSAPP_TEMPLATE_NAME') || 'campaign_update';

  if (!token || !phoneNumberId) {
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
      wabaId: wabaId,
      templateName: templateName
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

// API: Save/Update Meta Cloud API credentials securely on server
app.post('/api/config', async (req, res) => {
  const { token, phoneNumberId, wabaId, templateName } = req.body;

  if (token && typeof token === 'string' && token.trim()) {
    setEnv('WHATSAPP_TOKEN', token.trim());
  }
  if (phoneNumberId && typeof phoneNumberId === 'string' && phoneNumberId.trim()) {
    setEnv('WHATSAPP_PHONE_NUMBER_ID', phoneNumberId.trim());
  }
  if (wabaId && typeof wabaId === 'string') {
    setEnv('WHATSAPP_BUSINESS_ACCOUNT_ID', wabaId.trim());
  }
  if (templateName && typeof templateName === 'string') {
    setEnv('WHATSAPP_TEMPLATE_NAME', templateName.trim());
  }

  res.json({ success: true, message: 'Configuration updated successfully.' });
});

// API: Disconnect / Clear Meta Credentials
app.post('/api/logout', (req, res) => {
  try {
    setEnv('WHATSAPP_TOKEN', '');
    setEnv('WHATSAPP_PHONE_NUMBER_ID', '');
    setEnv('WHATSAPP_BUSINESS_ACCOUNT_ID', '');
    res.json({
      success: true,
      message: 'Disconnected from WhatsApp Cloud API. Note: Your phone number and Meta Business Account remain registered on Meta.'
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

        // 2. Process incoming messages for Opt-Out (STOP / UNSUBSCRIBE)
        if (value.messages) {
          for (const msg of value.messages) {
            const from = msg.from;
            const text = (msg.text?.body || '').trim().toUpperCase();

            if (['STOP', 'UNSUBSCRIBE', 'CANCEL', 'OPTOUT'].includes(text)) {
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

// ============================================================================
// EXCEL & CAMPAIGN DISPATCH ENDPOINTS
// ============================================================================

// API: Upload Excel recipients file
app.post('/api/upload/excel', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  res.json({ success: true, filename: req.file.originalname, saved: 'recipients.xlsx' });
});

// API: Delete Excel recipients file
app.delete('/api/delete-excel', (req, res) => {
  try {
    const exPath = path.join(__dirname, 'recipients.xlsx');
    if (fs.existsSync(exPath)) fs.unlinkSync(exPath);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Upload campaign image
app.post('/api/upload/image', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  res.json({ success: true, filename: req.file.originalname, saved: 'campaign.jpg' });
});

// API: Delete campaign image
app.delete('/api/delete-image', (req, res) => {
  try {
    const imgPath = path.join(__dirname, 'campaign.jpg');
    if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Check status of files & opt-outs
app.get('/api/files-status', (req, res) => {
  const exPath = path.join(__dirname, 'recipients.xlsx');
  const imPath = path.join(__dirname, 'campaign.jpg');
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

// API: Parse Excel recipients with Consent Verification, Deduplication, and Preview
app.get('/api/recipients', (req, res) => {
  const exPath = path.join(__dirname, 'recipients.xlsx');
  if (!fs.existsSync(exPath)) {
    return res.json({ exists: false, total: 0, valid: 0, consented: 0, non_consented: 0, duplicates: 0, invalid: 0, opted_out: 0, preview: [] });
  }

  const pythonCmd = process.platform === 'win32' ? 'python' : (process.env.PYTHON_CMD || 'python3');
  const py = spawn(pythonCmd, ['-u', 'send_campaign.py', '--preview'], { cwd: __dirname });
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

// API: Save message text
app.post('/api/save-message', (req, res) => {
  const { message } = req.body;
  if (typeof message !== 'string') return res.status(400).json({ error: 'Invalid message.' });
  fs.writeFileSync(path.join(__dirname, 'message.txt'), message, 'utf8');
  res.json({ success: true });
});

// API: Get current message text
app.get('/api/get-message', (req, res) => {
  try {
    const msg = fs.readFileSync(path.join(__dirname, 'message.txt'), 'utf8');
    res.json({ message: msg });
  } catch (e) {
    res.json({ message: 'Hello {{name}},\nThank you for choosing our service!' });
  }
});

// API: Get campaign image as base64 for preview
app.get('/api/preview-image', (req, res) => {
  try {
    const imgPath = path.join(__dirname, 'campaign.jpg');
    if (!fs.existsSync(imgPath)) return res.json({ image: null });
    const data = fs.readFileSync(imgPath);
    res.json({ image: 'data:image/jpeg;base64,' + data.toString('base64') });
  } catch (e) {
    res.json({ image: null });
  }
});

// API: Streaming Campaign Dispatcher via Official Meta Cloud API (Server-Sent Events)
app.get('/api/stream-campaign', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const token = getEnv('WHATSAPP_TOKEN');
  const phoneNumberId = getEnv('WHATSAPP_PHONE_NUMBER_ID');

  if (!token || !phoneNumberId) {
    res.write(`data: ${JSON.stringify({
      type: 'error',
      text: '[Configuration Error] Meta WhatsApp Cloud API credentials missing! Please configure WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID in Card 01 or Render environment variables.'
    })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'finish', exitCode: 1 })}\n\n`);
    return res.end();
  }

  res.write(`data: ${JSON.stringify({ type: 'log', text: 'Connecting to Official Meta WhatsApp Cloud API...' })}\n\n`);

  const pythonCmd = process.platform === 'win32' ? 'python' : (process.env.PYTHON_CMD || 'python3');
  const py = spawn(pythonCmd, ['-u', 'send_campaign.py'], {
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
