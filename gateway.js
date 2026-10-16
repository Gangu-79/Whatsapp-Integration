/**
 * WhatsApp Campaign Engine - Enterprise Meta Cloud API Gateway
 * Policy-Compliant, Official Meta WhatsApp Business Platform Integration
 * Supports Single & Bulk Excel Messaging, PDF/Image Attachments,
 * 2-Way Persistent Inbox, Rate-Limiting, Delivery Reports, and Meta Webhooks.
 */

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const multer = require('multer');

// Persistent Database & Meta Cloud API Modules
const db = require('./db');
const metaApi = require('./meta_api');

// Lightweight local .env parser (without external dotenv dependency)
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  try {
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const line of envContent.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (process.env[key] === undefined && val) {
          process.env[key] = val;
        }
      }
    }
  } catch (e) {
    console.warn('[Env Warning] Could not parse .env:', e.message);
  }
}

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Base Sessions Directory for user file uploads
const sessionsBaseDir = path.join(__dirname, 'sessions');
if (!fs.existsSync(sessionsBaseDir)) fs.mkdirSync(sessionsBaseDir, { recursive: true });

function getSessionId(req) {
  const h = req.headers['x-session-id'] || req.query?.sessionId || req.body?.sessionId;
  if (h && typeof h === 'string') {
    const cleaned = h.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    if (cleaned && cleaned.length >= 8) return cleaned;
  }
  return 'sess_default';
}

function getSessionDir(req) {
  const sid = getSessionId(req);
  const dir = path.join(sessionsBaseDir, sid);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Robust Multi-Tier Configuration Resolver:
 * Resolves credentials in priority:
 * 1. Database Session (Per-session / user settings)
 * 2. SQLite Global Settings (Stored permanently across restarts)
 * 3. Disk Session File (sessions/<sid>/config.json)
 * 4. Process Environment Variables (Render / System .env)
 */
async function getEffectiveConfig(req) {
  const sid = getSessionId(req);

  // 1. Session Database
  let sessionRow = null;
  try {
    sessionRow = await db.getSession(sid);
  } catch (e) {}

  // 2. Global SQLite Settings
  let globalToken = null, globalPhoneId = null, globalWabaId = null, globalTemplate = null, globalLang = null;
  try {
    globalToken = await db.getSetting('WHATSAPP_TOKEN');
    globalPhoneId = await db.getSetting('WHATSAPP_PHONE_NUMBER_ID');
    globalWabaId = await db.getSetting('WHATSAPP_BUSINESS_ACCOUNT_ID');
    globalTemplate = await db.getSetting('WHATSAPP_TEMPLATE_NAME');
    globalLang = await db.getSetting('WHATSAPP_TEMPLATE_LANG');
  } catch (e) {}

  // 3. Disk session config
  let diskCfg = {};
  const cfgPath = path.join(getSessionDir(req), 'config.json');
  if (fs.existsSync(cfgPath)) {
    try { diskCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) || {}; } catch (e) {}
  }

  const token = (sessionRow?.token || diskCfg?.token || globalToken || process.env.WHATSAPP_TOKEN || '').trim();
  const phoneNumberId = (sessionRow?.phone_number_id || diskCfg?.phoneNumberId || globalPhoneId || process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
  const wabaId = (sessionRow?.waba_id || diskCfg?.wabaId || globalWabaId || process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '').trim();
  const templateName = (sessionRow?.template_name || diskCfg?.templateName || globalTemplate || process.env.WHATSAPP_TEMPLATE_NAME || 'campaign_update').trim();
  const templateLang = (sessionRow?.template_lang || diskCfg?.templateLang || globalLang || process.env.WHATSAPP_TEMPLATE_LANG || 'en_US').trim();

  return { token, phoneNumberId, wabaId, templateName, templateLang };
}

// Multer Storage: Handles Excel, Images (JPG, PNG), and Documents (PDF)
const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, getSessionDir(req)),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (req.path.includes('excel')) {
      cb(null, 'recipients.xlsx');
    } else if (ext === '.pdf') {
      cb(null, 'campaign_media.pdf');
    } else if (ext === '.png') {
      cb(null, 'campaign_media.png');
    } else {
      cb(null, 'campaign_media.jpg');
    }
  }
});

const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB limit (Meta document limit is 100MB, image is 5MB)
});

// Serve Frontend UI (Anti-cache headers prevent stale browser caching)
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  maxAge: 0,
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================================
// 1. META CLOUD API CONNECTION & STATUS
// ============================================================================

// API: Check Meta Cloud API Connection & Business Profile Status
app.get('/api/status', async (req, res) => {
  try {
    const cfg = await getEffectiveConfig(req);

    if (!cfg.token || !cfg.phoneNumberId) {
      return res.json({
        connected: false,
        configured: false,
        state: 'unconfigured',
        provider: 'Meta WhatsApp Cloud API',
        phone: '',
        verifiedName: '',
        qualityRating: 'UNKNOWN',
        message: 'Meta Cloud API credentials not configured. Please enter your Permanent Access Token and Phone Number ID.'
      });
    }

    // Live verification with Meta Graph API
    const verifyResult = await metaApi.verifyCredentials(cfg.token, cfg.phoneNumberId);

    if (verifyResult.valid) {
      // Save profile info to DB
      const sid = getSessionId(req);
      db.saveSession(sid, {
        token: cfg.token,
        phone_number_id: cfg.phoneNumberId,
        waba_id: cfg.wabaId,
        template_name: cfg.templateName,
        template_lang: cfg.templateLang,
        verified_name: verifyResult.verifiedName,
        display_phone: verifyResult.displayPhone,
        quality_rating: verifyResult.qualityRating,
        status: 'connected'
      }).catch(() => {});

      return res.json({
        connected: true,
        configured: true,
        state: 'open',
        provider: 'Meta WhatsApp Cloud API',
        phone: verifyResult.displayPhone || verifyResult.phone,
        displayPhone: verifyResult.displayPhone,
        verifiedName: verifyResult.verifiedName,
        qualityRating: verifyResult.qualityRating,
        codeStatus: verifyResult.codeStatus,
        phoneNumberId: cfg.phoneNumberId,
        wabaId: cfg.wabaId,
        templateName: cfg.templateName,
        templateLang: cfg.templateLang
      });
    } else {
      // Return clear, detailed error diagnosis
      return res.json({
        connected: false,
        configured: true,
        state: 'error',
        provider: 'Meta WhatsApp Cloud API',
        phone: '',
        error: verifyResult.error,
        code: verifyResult.code,
        subcode: verifyResult.subcode,
        advice: verifyResult.advice,
        message: `Meta API Error (${verifyResult.code}): ${verifyResult.error}`
      });
    }
  } catch (err) {
    console.error('[Status Check Error]:', err.message);
    res.status(500).json({
      connected: false,
      configured: false,
      error: err.message,
      message: 'Failed to verify Meta Cloud API status.'
    });
  }
});

// API: Save/Update Meta Cloud API credentials permanently in SQLite and session
app.post('/api/config', async (req, res) => {
  try {
    const { token, phoneNumberId, wabaId, templateName, templateLang } = req.body;
    const sid = getSessionId(req);

    const dataToSave = {};
    if (token && typeof token === 'string' && token.trim()) {
      dataToSave.token = token.trim();
      await db.setSetting('WHATSAPP_TOKEN', token.trim());
    }
    if (phoneNumberId && typeof phoneNumberId === 'string' && phoneNumberId.trim()) {
      dataToSave.phone_number_id = phoneNumberId.trim();
      await db.setSetting('WHATSAPP_PHONE_NUMBER_ID', phoneNumberId.trim());
    }
    if (wabaId && typeof wabaId === 'string') {
      dataToSave.waba_id = wabaId.trim();
      await db.setSetting('WHATSAPP_BUSINESS_ACCOUNT_ID', wabaId.trim());
    }
    if (templateName && typeof templateName === 'string') {
      dataToSave.template_name = templateName.trim();
      await db.setSetting('WHATSAPP_TEMPLATE_NAME', templateName.trim());
    }
    if (templateLang && typeof templateLang === 'string') {
      dataToSave.template_lang = templateLang.trim();
      await db.setSetting('WHATSAPP_TEMPLATE_LANG', templateLang.trim());
    }

    // Save to persistent database
    await db.saveSession(sid, dataToSave);

    // Also write to disk config.json for backwards compatibility
    const sDir = getSessionDir(req);
    const cfgPath = path.join(sDir, 'config.json');
    let current = {};
    if (fs.existsSync(cfgPath)) {
      try { current = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) {}
    }
    fs.writeFileSync(cfgPath, JSON.stringify({ ...current, ...dataToSave }, null, 2), 'utf8');

    // Run verification
    const effective = await getEffectiveConfig(req);
    const verify = await metaApi.verifyCredentials(effective.token, effective.phoneNumberId);

    res.json({
      success: true,
      verified: verify.valid,
      details: verify,
      message: verify.valid
        ? 'Meta Cloud API connected successfully!'
        : `Credentials saved, but Meta verification returned: ${verify.error}`
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================================
// USER AUTHENTICATION & SESSION MANAGEMENT (Requirement 2)
// ============================================================================

const userSessions = new Map();

function generateAuthToken(user) {
  const token = 'wa_sec_' + crypto.randomBytes(32).toString('hex');
  userSessions.set(token, {
    user,
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 // 7-day session
  });
  return token;
}

function getAuthUser(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : (req.headers['x-auth-token'] || '');
  if (!token) return null;
  const sess = userSessions.get(token);
  if (!sess) return null;
  if (Date.now() > sess.expiresAt) {
    userSessions.delete(token);
    return null;
  }
  return sess.user;
}

// API: Register User
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password, name } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password are required.' });
    }
    const user = await db.registerUser({ username, password, name });
    const token = generateAuthToken(user);
    res.json({
      success: true,
      user,
      token,
      message: 'Account registered successfully.'
    });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// API: Login User
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password are required.' });
    }
    const user = await db.loginUser(username, password);
    const token = generateAuthToken(user);
    res.json({
      success: true,
      user,
      token,
      message: 'Login successful.'
    });
  } catch (e) {
    res.status(401).json({ success: false, error: e.message });
  }
});

// API: Current Authenticated User Status
app.get('/api/auth/me', (req, res) => {
  const user = getAuthUser(req);
  if (user) {
    return res.json({ authenticated: true, user });
  }
  return res.json({ authenticated: false, user: null });
});

// API: Logout Web Session
// Requirement 5: Web logout must NOT disconnect WhatsApp Business account credentials.
app.post('/api/logout', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : (req.headers['x-auth-token'] || '');
    if (token) userSessions.delete(token);

    const sid = getSessionId(req);
    // Mark session as inactive in DB, but keep credentials safely stored
    if (sid && sid !== 'sess_default') {
      await db.run('UPDATE sessions SET status = "logged_out" WHERE session_id = ?', [sid]).catch(() => {});
    }
    res.json({
      success: true,
      message: 'Logged out of web application. Your WhatsApp Business connection remains active for incoming messages.'
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================================
// META DEEP DIAGNOSTICS & ERROR 200 RESOLVER (Requirement 4)
// ============================================================================

app.get('/api/meta/diagnose', async (req, res) => {
  try {
    const cfg = await getEffectiveConfig(req);
    if (!cfg.token || !cfg.phoneNumberId) {
      return res.json({
        success: false,
        configured: false,
        message: 'Credentials not configured. Please enter your Permanent Access Token and Phone Number ID.'
      });
    }

    const diagnosis = await metaApi.deepDiagnoseCredentials(cfg.token, cfg.phoneNumberId, cfg.wabaId);
    res.json({
      success: true,
      configured: true,
      phoneNumberId: cfg.phoneNumberId,
      wabaId: cfg.wabaId,
      diagnosis
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================================
// MESSAGE STORAGE & DATABASE BACKUP / RECOVERY (Requirement 7)
// ============================================================================

// API: Export Full Database Backup (Settings, Messages, Conversations, Logs)
app.get('/api/backup/export', async (req, res) => {
  try {
    const backup = await db.exportBackup();
    const dateStr = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="whatsapp_backup_${dateStr}.json"`);
    res.send(JSON.stringify(backup, null, 2));
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// API: Restore Database Backup
app.post('/api/backup/restore', upload.single('backupFile'), async (req, res) => {
  try {
    let backupData = null;
    if (req.file) {
      const raw = fs.readFileSync(req.file.path, 'utf8');
      backupData = JSON.parse(raw);
    } else if (req.body && req.body.store) {
      backupData = req.body;
    } else {
      return res.status(400).json({ success: false, error: 'No backup file or JSON payload provided.' });
    }

    const result = await db.restoreBackup(backupData);
    res.json({
      success: true,
      message: 'Database backup restored successfully! All messages and settings recovered.',
      result
    });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to restore backup: ' + e.message });
  }
});

// ============================================================================
// 2. SINGLE DIRECT MESSAGING (Requirement 1 & 6)
// ============================================================================

// API: Send Single Message to one recipient (supports text, PDF, JPG, PNG)
app.post('/api/send-single', upload.single('mediaFile'), async (req, res) => {
  try {
    const { to, text, templateName, templateLang, recipientName, countryCode } = req.body;
    const cfg = await getEffectiveConfig(req);

    if (!cfg.token || !cfg.phoneNumberId) {
      return res.status(401).json({
        success: false,
        error: 'Meta WhatsApp Cloud API credentials not configured. Please add your credentials in Settings.'
      });
    }

    if (!to || !to.trim()) {
      return res.status(400).json({ success: false, error: 'Recipient phone number is required.' });
    }

    const defaultCode = (countryCode || '91').replace(/\D/g, '') || '91';
    const cleanPhone = metaApi.cleanPhoneNumber(to, defaultCode);

    if (!metaApi.isValidE164(cleanPhone)) {
      return res.status(400).json({
        success: false,
        error: `Invalid phone number format: '${to}'. Must contain a valid country code and 10-15 digits.`
      });
    }

    // Check opt-out status
    const isOptedOut = await db.isOptedOut(cleanPhone);
    if (isOptedOut) {
      return res.status(403).json({
        success: false,
        error: `Recipient (+${cleanPhone}) has opted out of messaging. Message blocked per Meta WhatsApp policy.`
      });
    }

    // Handle media attachment if uploaded or present
    let mediaId = null;
    let mediaType = 'image';
    let mediaFilename = 'attachment.pdf';

    if (req.file) {
      const uploadRes = await metaApi.uploadMedia(cfg.token, cfg.phoneNumberId, req.file.path);
      mediaId = uploadRes.mediaId;
      mediaType = uploadRes.type;
      mediaFilename = uploadRes.filename;
    }

    const effectiveTemplate = (templateName && templateName.trim()) ? templateName.trim() : null;
    const effectiveLang = (templateLang && templateLang.trim()) ? templateLang.trim() : cfg.templateLang;

    // Send via Meta API
    const result = await metaApi.sendMessage({
      token: cfg.token,
      phoneNumberId: cfg.phoneNumberId,
      to: cleanPhone,
      text: (text || '').trim(),
      mediaId,
      mediaType,
      filename: mediaFilename,
      templateName: effectiveTemplate,
      templateLang: effectiveLang,
      recipientName: recipientName || ''
    });

    // Save outgoing message to database
    if (result.success) {
      await db.saveOutgoingReply({
        phone: cleanPhone,
        text: (text || `[${mediaType.toUpperCase()} Attachment]`).trim(),
        type: mediaId ? mediaType : 'text',
        mediaId: mediaId,
        metaMessageId: result.messageId,
        targetPhoneId: cfg.phoneNumberId,
        status: 'sent'
      });
      await db.logCampaignRecipient(
        'single_dispatch',
        cleanPhone,
        recipientName || 'Single Contact',
        'sent',
        result.messageId
      ).catch(() => {});
      return res.json({
        success: true,
        messageId: result.messageId,
        recipient: cleanPhone,
        status: 'sent',
        message: 'Message accepted by Meta Cloud API.'
      });
    } else {
      await db.saveOutgoingReply({
        phone: cleanPhone,
        text: (text || '').trim(),
        type: mediaId ? mediaType : 'text',
        targetPhoneId: cfg.phoneNumberId,
        status: 'failed',
        errorMessage: result.explanation || result.error
      });
      await db.logCampaignRecipient(
        'single_dispatch',
        cleanPhone,
        recipientName || 'Single Contact',
        'failed',
        null,
        result.code,
        result.explanation || result.error
      ).catch(() => {});
      return res.status(result.code === 400 ? 400 : 502).json({
        success: false,
        code: result.code,
        error: result.error,
        explanation: result.explanation,
        details: result.details
      });
    }
  } catch (err) {
    console.error('[Send Single Error]:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// 3. EXCEL & MEDIA ATTACHMENTS (Requirements 1, 7 & 8)
// ============================================================================

// API: Upload Excel recipients file
app.post('/api/upload/excel', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  res.json({ success: true, filename: req.file.originalname, saved: 'recipients.xlsx' });
});

// API: Delete Excel recipients file
app.delete('/api/delete-excel', (req, res) => {
  try {
    const exPath = path.join(getSessionDir(req), 'recipients.xlsx');
    if (fs.existsSync(exPath)) fs.unlinkSync(exPath);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Helper to find session media file (image or pdf)
function findSessionMedia(sDir) {
  const candidates = [
    'campaign_media.pdf',
    'campaign_media.png',
    'campaign_media.jpg',
    'campaign.jpg',
    'campaign.png',
    'campaign.pdf'
  ];
  for (const c of candidates) {
    const p = path.join(sDir, c);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// API: Upload Media Attachment (Supports PDF documents, PNG, and JPG images)
app.post('/api/upload/media', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  const ext = path.extname(req.file.originalname).toLowerCase();
  const type = ext === '.pdf' ? 'document' : 'image';
  res.json({
    success: true,
    filename: req.file.originalname,
    saved: path.basename(req.file.path),
    type: type
  });
});

// Backward-compatible alias for /api/upload/image
app.post('/api/upload/image', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  // Also copy to campaign.jpg for backwards compatibility with send_campaign.py
  const sDir = getSessionDir(req);
  try {
    fs.copyFileSync(req.file.path, path.join(sDir, 'campaign.jpg'));
  } catch (e) {}
  res.json({ success: true, filename: req.file.originalname, saved: 'campaign.jpg', type: 'image' });
});

// API: Delete Media Attachment
app.delete('/api/delete-media', (req, res) => {
  try {
    const sDir = getSessionDir(req);
    const mediaPath = findSessionMedia(sDir);
    if (mediaPath && fs.existsSync(mediaPath)) fs.unlinkSync(mediaPath);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.delete('/api/delete-image', (req, res) => {
  try {
    const sDir = getSessionDir(req);
    const mediaPath = findSessionMedia(sDir);
    if (mediaPath && fs.existsSync(mediaPath)) fs.unlinkSync(mediaPath);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Check files status for current session
app.get('/api/files-status', async (req, res) => {
  const dir = getSessionDir(req);
  const exPath = path.join(dir, 'recipients.xlsx');
  const mediaPath = findSessionMedia(dir);

  let mediaType = null;
  let mediaFilename = null;
  if (mediaPath) {
    const ext = path.extname(mediaPath).toLowerCase();
    mediaType = ext === '.pdf' ? 'document' : 'image';
    mediaFilename = path.basename(mediaPath);
  }

  let optOutCount = 0;
  try {
    const optList = await db.getOptOutList();
    optOutCount = optList.length;
  } catch (e) {}

  res.json({
    excelExists: fs.existsSync(exPath),
    imageExists: !!mediaPath,
    mediaExists: !!mediaPath,
    mediaType: mediaType,
    mediaFilename: mediaFilename,
    optOutCount: optOutCount
  });
});

// API: Parse Excel Recipients with validation, preview, and deduplication
app.get('/api/recipients', (req, res) => {
  const exPath = path.join(getSessionDir(req), 'recipients.xlsx');
  if (!fs.existsSync(exPath)) {
    return res.json({
      exists: false,
      total: 0,
      valid: 0,
      consented: 0,
      non_consented: 0,
      duplicates: 0,
      invalid: 0,
      opted_out: 0,
      preview: []
    });
  }

  const optOutFilePath = path.join(__dirname, 'optouts.json');
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

// API: Message template text
app.post('/api/save-message', (req, res) => {
  const { message } = req.body;
  if (typeof message !== 'string') return res.status(400).json({ error: 'Invalid message.' });
  fs.writeFileSync(path.join(getSessionDir(req), 'message.txt'), message, 'utf8');
  res.json({ success: true });
});

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

// API: Preview media attachment (Base64 for images or PDF info)
app.get('/api/preview-image', (req, res) => {
  try {
    const sDir = getSessionDir(req);
    const mediaPath = findSessionMedia(sDir);
    if (!mediaPath) return res.json({ image: null, type: null });

    const ext = path.extname(mediaPath).toLowerCase();
    if (ext === '.pdf') {
      return res.json({
        type: 'document',
        filename: path.basename(mediaPath),
        isPdf: true,
        image: null
      });
    }

    const data = fs.readFileSync(mediaPath);
    const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
    res.json({
      type: 'image',
      image: `data:${mime};base64,` + data.toString('base64'),
      filename: path.basename(mediaPath)
    });
  } catch (e) {
    res.json({ image: null, type: null });
  }
});

// ============================================================================
// 4. STREAMING BULK CAMPAIGN DISPATCHER (Requirements 2 & 8)
// ============================================================================

app.get('/api/stream-campaign', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const cfg = await getEffectiveConfig(req);

  if (!cfg.token || !cfg.phoneNumberId) {
    res.write(`data: ${JSON.stringify({
      type: 'error',
      text: '[Configuration Error] Meta WhatsApp Cloud API credentials missing! Please configure Phone Number ID and Permanent Access Token in Settings.'
    })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'finish', exitCode: 1 })}\n\n`);
    return res.end();
  }

  const sDir = getSessionDir(req);
  const exPath = path.join(sDir, 'recipients.xlsx');
  const msgPath = path.join(sDir, 'message.txt');
  const mediaPath = findSessionMedia(sDir);

  if (!fs.existsSync(exPath)) {
    res.write(`data: ${JSON.stringify({
      type: 'error',
      text: '[Excel Error] No recipients.xlsx file found. Please upload your Excel list before launching.'
    })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'finish', exitCode: 1 })}\n\n`);
    return res.end();
  }

  const campaignId = 'camp_' + Date.now();
  await db.createCampaign(campaignId, 'Bulk Campaign ' + new Date().toLocaleDateString(), 0).catch(() => {});

  res.write(`data: ${JSON.stringify({ type: 'log', text: 'Connecting to Official Meta WhatsApp Cloud API...' })}\n\n`);
  res.write(`data: ${JSON.stringify({ type: 'log', text: `Campaign ID initialized: ${campaignId}` })}\n\n`);

  const optOutFilePath = path.join(__dirname, 'optouts.json');
  const pythonCmd = process.platform === 'win32' ? 'python' : (process.env.PYTHON_CMD || 'python3');

  const pyArgs = [
    '-u', 'send_campaign.py',
    '--excel', exPath,
    '--message', fs.existsSync(msgPath) ? msgPath : path.join(__dirname, 'message.txt'),
    '--image', mediaPath || 'campaign.jpg',
    '--token', cfg.token,
    '--phone-id', cfg.phoneNumberId,
    '--template', cfg.templateName || '',
    '--template-lang', cfg.templateLang || 'en_US',
    '--optouts', optOutFilePath
  ];

  const py = spawn(pythonCmd, pyArgs, {
    cwd: __dirname,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }
  });

  let sentCount = 0;
  let failedCount = 0;
  let currentRecipientName = '';
  let currentRecipientPhone = '';
  let lineRemainder = '';

  py.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    lineRemainder += text;
    const lines = lineRemainder.split(/\r?\n/);
    lineRemainder = lines.pop(); // keep trailing incomplete line

    for (const l of lines) {
      const trimmed = l.trim();
      const recipMatch = trimmed.match(/\[\d+\/\d+\]\s+Recipient:\s*(.*?)\s*\(\+(\d+)\)/);
      if (recipMatch) {
        currentRecipientName = recipMatch[1].trim();
        currentRecipientPhone = recipMatch[2].trim();
      }

      if (trimmed.includes('ACCEPTED by Meta Cloud API')) {
        sentCount++;
        const idMatch = trimmed.match(/Message ID:\s*([^\)]+)/);
        const metaId = idMatch ? idMatch[1].trim() : null;
        if (currentRecipientPhone) {
          db.logCampaignRecipient(campaignId, currentRecipientPhone, currentRecipientName || 'Customer', 'sent', metaId).catch(() => {});
        }
      }

      if (trimmed.includes('Status: FAILED')) {
        failedCount++;
        const errMatch = trimmed.match(/Meta Error\s*(\d+)/);
        const errCode = errMatch ? errMatch[1].trim() : null;
        if (currentRecipientPhone) {
          db.logCampaignRecipient(campaignId, currentRecipientPhone, currentRecipientName || 'Customer', 'failed', null, errCode, trimmed).catch(() => {});
        }
      }
    }

    res.write(`data: ${JSON.stringify({ type: 'log', text })}\n\n`);
  });

  py.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    res.write(`data: ${JSON.stringify({ type: 'error', text })}\n\n`);
  });

  py.on('close', async (exitCode) => {
    await db.updateCampaignStats(campaignId, sentCount, failedCount, exitCode === 0 ? 'completed' : 'failed').catch(() => {});
    res.write(`data: ${JSON.stringify({ type: 'finish', exitCode, sentCount, failedCount })}\n\n`);
    res.end();
  });
});

// ============================================================================
// 5. META WEBHOOKS & 2-WAY INBOX (Requirements 3 & 4)
// ============================================================================

// Webhook Verification (Meta Hub Challenge)
app.get('/api/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const expectedToken = process.env.WEBHOOK_VERIFY_TOKEN || 'whatsapp_campaign_verify_token_123';

  if (mode === 'subscribe' && token === expectedToken) {
    console.log('[Meta Webhook] Successfully verified webhook subscription challenge.');
    return res.status(200).send(challenge);
  }
  console.warn('[Meta Webhook] Verification failed. Received token:', token);
  res.status(403).send('Forbidden');
});

// Webhook Listener: Incoming Messages & Delivery Status Updates
app.post('/api/webhook', async (req, res) => {
  const body = req.body;

  if (body.object === 'whatsapp_business_account') {
    const entries = body.entry || [];
    for (const entry of entries) {
      const changes = entry.changes || [];
      for (const change of changes) {
        const value = change.value || {};
        const targetPhoneId = value.metadata?.phone_number_id || null;

        // 1. Process delivery receipts (sent, delivered, read, failed)
        if (value.statuses) {
          for (const status of value.statuses) {
            const metaId = status.id;
            const deliveryStatus = status.status; // 'sent' | 'delivered' | 'read' | 'failed'
            const errorDetails = status.errors ? JSON.stringify(status.errors) : null;

            console.log(`[Meta Webhook] Delivery: ${deliveryStatus} | Recipient: ${status.recipient_id} | MetaID: ${metaId}`);
            await db.updateMessageDeliveryStatus(metaId, deliveryStatus, errorDetails).catch(() => {});
          }
        }

        // 2. Process incoming messages
        if (value.messages) {
          const contacts = value.contacts || [];
          const contactName = contacts[0]?.profile?.name || '';

          for (const msg of value.messages) {
            const from = msg.from;
            const cleanFrom = metaApi.cleanPhoneNumber(from);
            const msgType = msg.type || 'text';

            let rawText = '';
            if (msgType === 'text') {
              rawText = msg.text?.body || '';
            } else if (msgType === 'button') {
              rawText = msg.button?.text || '';
            } else if (msgType === 'interactive') {
              rawText = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '';
            } else if (['image', 'document', 'audio', 'video'].includes(msgType)) {
              rawText = msg[msgType]?.caption || `[${msgType.toUpperCase()} Attachment]`;
            }

            const mediaId = msg[msgType]?.id || null;
            const textUpper = rawText.trim().toUpperCase();

            // Save incoming message permanently into SQLite
            await db.saveIncomingMessage({
              id: msg.id,
              phone: cleanFrom,
              name: contactName,
              text: rawText,
              type: msgType,
              mediaId: mediaId,
              targetPhoneId: targetPhoneId,
              timestamp: msg.timestamp ? new Date(parseInt(msg.timestamp) * 1000).toISOString() : new Date().toISOString()
            }).catch(err => console.error('[Webhook Save Error]:', err.message));

            // Check Opt-Out Keywords (STOP, UNSUBSCRIBE, CANCEL)
            if (['STOP', 'UNSUBSCRIBE', 'CANCEL', 'OPTOUT'].includes(textUpper)) {
              console.log(`[Meta Webhook] Opt-out keyword received from +${cleanFrom}. Updating exclusion status.`);
              await db.setOptOut(cleanFrom, 1, `User sent keyword: ${textUpper}`).catch(() => {});

              // Also write to optouts.json for backwards compatibility
              const optOutFilePath = path.join(__dirname, 'optouts.json');
              try {
                let optData = { opted_out_numbers: [] };
                if (fs.existsSync(optOutFilePath)) {
                  optData = JSON.parse(fs.readFileSync(optOutFilePath, 'utf8'));
                }
                if (!optData.opted_out_numbers.includes(cleanFrom)) {
                  optData.opted_out_numbers.push(cleanFrom);
                  optData.updated_at = new Date().toISOString();
                  fs.writeFileSync(optOutFilePath, JSON.stringify(optData, null, 2), 'utf8');
                }
              } catch (e) {}
            }
          }
        }
      }
    }
    return res.status(200).send('EVENT_RECEIVED');
  }
  res.sendStatus(404);
});

// API: Get Inbox Conversations (Persistent SQLite)
app.get('/api/inbox', async (req, res) => {
  try {
    const cfg = await getEffectiveConfig(req);
    const conversations = await db.getConversations(cfg.phoneNumberId || null);
    res.json({
      success: true,
      count: conversations.length,
      conversations: conversations
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// API: Get Full Conversation History for a specific contact
app.get('/api/inbox/messages/:phone', async (req, res) => {
  try {
    const phone = req.params.phone;
    const cleanPhone = metaApi.cleanPhoneNumber(phone);
    const messages = await db.getMessagesForContact(cleanPhone);
    await db.markConversationRead(cleanPhone);
    res.json({
      success: true,
      phone: cleanPhone,
      messages: messages
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// API: Send Reply to Contact via Meta Cloud API
// Fixes the bug where inbox replies were not reaching recipients
app.post('/api/inbox/reply', async (req, res) => {
  try {
    const { to, message, templateName } = req.body;
    const cfg = await getEffectiveConfig(req);

    if (!cfg.token || !cfg.phoneNumberId) {
      return res.status(401).json({
        success: false,
        error: 'Meta Cloud API not configured. Please add your Phone Number ID and Permanent Access Token in Settings.'
      });
    }

    if (!to || !message || !message.trim()) {
      return res.status(400).json({ success: false, error: 'Recipient phone number and reply message are required.' });
    }

    const cleanPhone = metaApi.cleanPhoneNumber(to);
    if (!metaApi.isValidE164(cleanPhone)) {
      return res.status(400).json({ success: false, error: `Invalid phone number: '${to}'. Must contain 10-15 digits.` });
    }

    // Check opt-out
    if (await db.isOptedOut(cleanPhone)) {
      return res.status(403).json({ success: false, error: 'This contact has opted out of WhatsApp messages.' });
    }

    // Send reply via Meta Cloud API
    const result = await metaApi.sendMessage({
      token: cfg.token,
      phoneNumberId: cfg.phoneNumberId,
      to: cleanPhone,
      text: message.trim(),
      templateName: templateName || null,
      templateLang: cfg.templateLang
    });

    if (result.success) {
      // Save outgoing reply to SQLite database immediately
      const saved = await db.saveOutgoingReply({
        phone: cleanPhone,
        text: message.trim(),
        metaMessageId: result.messageId,
        targetPhoneId: cfg.phoneNumberId,
        status: 'sent'
      });

      return res.json({
        success: true,
        messageId: result.messageId,
        replyId: saved.id,
        status: 'sent'
      });
    } else {
      // Save failed attempt
      await db.saveOutgoingReply({
        phone: cleanPhone,
        text: message.trim(),
        targetPhoneId: cfg.phoneNumberId,
        status: 'failed',
        errorMessage: result.explanation || result.error
      });

      return res.status(result.code === 400 ? 400 : 502).json({
        success: false,
        code: result.code,
        error: result.error,
        explanation: result.explanation,
        details: result.details
      });
    }
  } catch (e) {
    console.error('[Inbox Reply Error]:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================================
// 6. DELIVERY REPORTS & AUDIT LOGS (Requirements 7 & 8)
// ============================================================================

// API: Get Recent Delivery Logs & Reach Analytics Summary
app.get('/api/reports', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 200;
    const logs = await db.getRecentCampaignLogs(limit);
    const campaigns = await db.all('SELECT * FROM campaigns ORDER BY created_at DESC LIMIT 20');

    // Aggregate delivery metrics
    let totalSent = 0;
    let totalDelivered = 0;
    let totalRead = 0;
    let totalFailed = 0;

    for (const log of logs) {
      const st = (log.status || '').toLowerCase();
      if (st === 'sent') totalSent++;
      else if (st === 'delivered') totalDelivered++;
      else if (st === 'read') totalRead++;
      else if (st === 'failed') totalFailed++;
    }

    res.json({
      success: true,
      summary: {
        totalTracked: logs.length,
        totalSent,
        totalDelivered,
        totalRead,
        totalFailed,
        totalReached: totalDelivered + totalRead
      },
      campaigns,
      logs
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// API: Download Delivery Report as CSV
app.get('/api/reports/download', async (req, res) => {
  try {
    const logs = await db.getRecentCampaignLogs(2000);
    let csv = 'Campaign,Recipient Name,Phone Number,Delivery Status,Meta Message ID,Error Code,Error Details,Sent Timestamp\n';

    for (const log of logs) {
      const camp = (log.campaign_id || log.campaign_name || 'Dispatch').replace(/"/g, '""');
      const name = (log.name || 'Customer').replace(/"/g, '""');
      const phone = log.phone ? `+${log.phone}` : '';
      const status = log.status || 'unknown';
      const metaId = log.meta_id || '';
      const errCode = log.error_code || '';
      const errDetails = (log.error_details || '').replace(/"/g, '""').replace(/\r?\n/g, ' ');
      const sentAt = log.sent_at || '';

      csv += `"${camp}","${name}","${phone}","${status}","${metaId}","${errCode}","${errDetails}","${sentAt}"\n`;
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="whatsapp_delivery_report.csv"');
    res.send(csv);
  } catch (e) {
    res.status(500).send('Error generating report: ' + e.message);
  }
});

// API: Get Opt-Out List
app.get('/api/contacts/optouts', async (req, res) => {
  try {
    const list = await db.getOptOutList();
    res.json({ success: true, count: list.length, optouts: list });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================================
// SERVER INITIALIZATION
// ============================================================================

const PORT = process.env.PORT || 8085;
app.listen(PORT, () => {
  console.log(`=============================================================`);
  console.log(`[Official WhatsApp Cloud API Gateway] Server running on port ${PORT}`);
  console.log(`[Database] Persistent SQLite active with auto-recovery.`);
  console.log(`[Webhook] Listening at /api/webhook`);
  console.log(`=============================================================`);
});
