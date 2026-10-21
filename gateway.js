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
const XLSX = require('xlsx');

// Persistent Database, Meta Cloud API & Free WhatsApp Web Modules
const db = require('./db');
const metaApi = require('./meta_api');
const whatsappWeb = require('./whatsapp_web');

// Automatically connect WhatsApp Web incoming message listener to database
whatsappWeb.onIncomingMessage(async ({ phone, text, name, timestamp, messageId }) => {
  try {
    await db.saveIncomingMessage({
      phone,
      name: name || phone,
      text: text || '',
      metaMessageId: messageId,
      timestamp: timestamp || new Date().toISOString()
    });
    console.log(`[WhatsApp Web] Incoming message saved from +${phone}`);
  } catch (e) {
    console.warn('[WhatsApp Web Incoming Save Warning]:', e.message);
  }
});

// Boot WhatsApp Web engine asynchronously on server start
whatsappWeb.initWhatsAppWeb().catch(e => {
  console.warn('[WhatsApp Web Auto-Init]:', e.message);
});

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
  let wabaId = (sessionRow?.waba_id || diskCfg?.wabaId || globalWabaId || process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '').trim();
  const templateName = (sessionRow?.template_name || diskCfg?.templateName || globalTemplate || process.env.WHATSAPP_TEMPLATE_NAME || '').trim();
  const templateLang = (sessionRow?.template_lang || diskCfg?.templateLang || globalLang || process.env.WHATSAPP_TEMPLATE_LANG || 'en_US').trim();

  // Automatic WABA ID auto-discovery from Meta if token & phone ID exist
  if (!wabaId && token && phoneNumberId) {
    try {
      const autoWaba = await metaApi.autoDiscoverWabaId(token, phoneNumberId);
      if (autoWaba) {
        wabaId = autoWaba;
        await db.setSetting('WHATSAPP_BUSINESS_ACCOUNT_ID', autoWaba).catch(() => {});
        if (sessionRow) await db.saveSession(sid, { waba_id: autoWaba }).catch(() => {});
      }
    } catch (e) {}
  }

  return { token, phoneNumberId, wabaId, templateName, templateLang };
}

// Multer Storage: Handles Excel, Images (JPG, PNG), Documents (PDF), and Videos (MP4, 3GP)
const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, getSessionDir(req)),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (req.path.includes('excel')) {
      cb(null, 'recipients.xlsx');
    } else if (ext === '.pdf') {
      cb(null, 'campaign_media.pdf');
    } else if (ext === '.mp4') {
      cb(null, 'campaign_media.mp4');
    } else if (ext === '.3gp' || ext === '.3gpp') {
      cb(null, 'campaign_media.3gp');
    } else if (ext === '.png') {
      cb(null, 'campaign_media.png');
    } else {
      cb(null, 'campaign_media.jpg');
    }
  }
});

const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit (Meta document limit: 100MB, video: 16MB, image: 5MB)
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
    const wwebStatus = whatsappWeb.getWhatsAppWebStatus();

    if (!cfg.token || !cfg.phoneNumberId) {
      return res.json({
        connected: false,
        configured: false,
        state: 'unconfigured',
        provider: 'Meta WhatsApp Cloud API',
        phone: '',
        verifiedName: '',
        qualityRating: 'UNKNOWN',
        wweb: wwebStatus,
        message: 'Meta Cloud API credentials not configured. Please enter your Permanent Access Token and Phone Number ID.'
      });
    }

    // Live verification with Meta Graph API
    const verifyResult = await metaApi.verifyCredentials(cfg.token, cfg.phoneNumberId, cfg.wabaId);

    if (verifyResult.valid) {
      // Save profile info to DB
      const sid = getSessionId(req);
      const effectiveWaba = cfg.wabaId || verifyResult.wabaId || null;
      if (effectiveWaba && !cfg.wabaId) {
        await db.setSetting('WHATSAPP_BUSINESS_ACCOUNT_ID', effectiveWaba).catch(() => {});
      }

      db.saveSession(sid, {
        token: cfg.token,
        phone_number_id: cfg.phoneNumberId,
        waba_id: effectiveWaba,
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
        messagingLimitTier: verifyResult.messagingLimitTier || 'TIER_UNKNOWN',
        messagingLimitText: verifyResult.messagingLimitText || 'Dynamic Meta Limit',
        throughput: verifyResult.throughput || null,
        phoneNumberId: cfg.phoneNumberId,
        wabaId: effectiveWaba,
        currency: verifyResult.currency || null,
        currencyConfigured: verifyResult.currencyConfigured !== undefined ? verifyResult.currencyConfigured : true,
        maskedToken: metaApi.maskToken(cfg.token),
        templateName: cfg.templateName || '',
        templateLang: cfg.templateLang || 'en_US',
        wweb: wwebStatus
      });
    } else {
      // Return clear, detailed error diagnosis with masked secrets
      const safeError = metaApi.redactSensitive(verifyResult.error);
      const safeUserMsg = metaApi.redactSensitive(verifyResult.userMsg);
      return res.json({
        connected: false,
        configured: true,
        state: 'error',
        provider: 'Meta WhatsApp Cloud API',
        phone: '',
        maskedToken: metaApi.maskToken(cfg.token),
        error: safeError,
        code: verifyResult.code,
        subcode: verifyResult.subcode,
        userMsg: safeUserMsg,
        userTitle: metaApi.redactSensitive(verifyResult.userTitle),
        fbtraceId: verifyResult.fbtraceId,
        advice: metaApi.redactSensitive(verifyResult.advice),
        rootCauses: (verifyResult.rootCauses || []).map(r => metaApi.redactSensitive(r)),
        wweb: wwebStatus,
        message: `Meta API Error (${verifyResult.code}): ${safeUserMsg || safeError}`
      });
    }
  } catch (err) {
    console.error('[Status Check Error]:', metaApi.redactSensitive(err.message));
    res.status(500).json({
      connected: false,
      configured: false,
      error: metaApi.redactSensitive(err.message),
      wweb: whatsappWeb.getWhatsAppWebStatus(),
      message: 'Failed to verify Meta Cloud API status.'
    });
  }
});

// API: WhatsApp Web Multi-Device Status (QR Code & Linked User)
app.get('/api/wweb/status', (req, res) => {
  try {
    const status = whatsappWeb.getWhatsAppWebStatus();
    res.json({ success: true, ...status });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// API: Initialize or Re-trigger WhatsApp Web Socket & Fresh QR Code
app.post('/api/wweb/init', async (req, res) => {
  try {
    const force = req.body?.force === true;
    const result = await whatsappWeb.initWhatsAppWeb(force);
    res.json({ success: true, ...result, ...whatsappWeb.getWhatsAppWebStatus() });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// API: Disconnect WhatsApp Web & Clear Saved Multi-Device Credentials
app.post('/api/wweb/disconnect', async (req, res) => {
  try {
    const result = await whatsappWeb.disconnectWhatsAppWeb();
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// API: Deep Multi-Step Meta API Diagnostics Probe
app.get('/api/meta/diagnose', async (req, res) => {
  try {
    const cfg = await getEffectiveConfig(req);
    if (!cfg.token || !cfg.phoneNumberId) {
      return res.json({
        success: false,
        message: 'Meta Cloud API credentials not configured. Please add your Phone Number ID and Access Token.'
      });
    }

    const diagnosis = await metaApi.deepDiagnoseCredentials(cfg.token, cfg.phoneNumberId, cfg.wabaId);
    res.json({
      success: true,
      diagnosis
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Fetch Approved WhatsApp Message Templates from Meta Graph API
app.get('/api/meta/templates', async (req, res) => {
  try {
    let cfg = await getEffectiveConfig(req);

    // If wabaId is missing, auto-discover it using phoneNumberId and token
    if (!cfg.wabaId && cfg.phoneNumberId && cfg.token) {
      try {
        const autoWaba = await metaApi.autoDiscoverWabaId(cfg.token, cfg.phoneNumberId);
        if (autoWaba) {
          cfg.wabaId = autoWaba;
          await db.setSetting('WHATSAPP_BUSINESS_ACCOUNT_ID', autoWaba).catch(() => {});
          await db.saveSession(getSessionId(req), { waba_id: autoWaba }).catch(() => {});
        }
      } catch (e) {}
    }

    if (!cfg.token) {
      return res.json({
        success: false,
        configured: false,
        message: 'Permanent Access Token not configured. Please enter your Meta credentials in Settings.',
        templates: [],
        inReview: [],
        allTemplates: []
      });
    }

    if (!cfg.wabaId) {
      return res.json({
        success: false,
        configured: false,
        message: 'WABA ID could not be resolved. Please enter your WhatsApp Business Account ID (WABA ID) in Meta API Settings.',
        templates: [],
        inReview: [],
        allTemplates: []
      });
    }

    const result = await metaApi.fetchApprovedTemplates(cfg.token, cfg.wabaId);
    if (!result.success) {
      return res.json({
        success: false,
        error: result.error,
        code: result.code,
        message: `Meta API returned: ${result.error}`,
        templates: []
      });
    }

    res.json({
      success: true,
      wabaId: cfg.wabaId,
      totalCount: result.totalCount,
      approvedCount: result.approvedCount,
      inReviewCount: result.inReviewCount || 0,
      rejectedCount: result.rejectedCount || 0,
      templates: result.templates,
      inReview: result.inReview || [],
      rejected: result.rejected || [],
      allTemplates: result.allTemplates || []
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message, templates: [] });
  }
});

// API: Fetch WhatsApp Business Profile details (websites, about, description, email)
app.get('/api/meta/profile', async (req, res) => {
  try {
    const cfg = await getEffectiveConfig(req);
    if (!cfg.token || !cfg.phoneNumberId) {
      return res.status(400).json({ success: false, error: 'Meta Cloud API not configured' });
    }
    const result = await metaApi.getBusinessProfile(cfg.token, cfg.phoneNumberId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Remove website URL from WhatsApp Business Profile
app.post('/api/meta/profile/remove-website', async (req, res) => {
  try {
    const cfg = await getEffectiveConfig(req);
    if (!cfg.token || !cfg.phoneNumberId) {
      return res.status(400).json({ success: false, error: 'Meta Cloud API not configured' });
    }
    const result = await metaApi.removeProfileWebsites(cfg.token, cfg.phoneNumberId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
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
    const verify = await metaApi.verifyCredentials(effective.token, effective.phoneNumberId, effective.wabaId);

    if (verify.valid && verify.wabaId && !dataToSave.waba_id) {
      await db.setSetting('WHATSAPP_BUSINESS_ACCOUNT_ID', verify.wabaId).catch(() => {});
      await db.saveSession(sid, { waba_id: verify.wabaId }).catch(() => {});
    }

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
// MESSAGE STORAGE & DATABASE BACKUP / RECOVERY (Requirements 1 & 7)
// ============================================================================

// API: Get Current Backup Status & Snapshot Metadata
app.get('/api/backup/status', async (req, res) => {
  try {
    const status = await db.getBackupStatus();
    res.json({ success: true, ...status });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// API: Trigger Immediate Live Database Backup
app.post('/api/backup/create', async (req, res) => {
  try {
    const result = await db.createBackupNow();
    res.json({ success: true, message: 'Backup created successfully!', ...result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// API: Export Full Database Backup (Settings, Messages, Conversations, Logs)
app.get('/api/backup/export', async (req, res) => {
  try {
    const backup = await db.exportBackup();
    if (req.query.raw === '1') {
      return res.json(backup);
    }
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
    } else if (req.body && typeof req.body === 'string') {
      try {
        backupData = JSON.parse(req.body);
      } catch (e) {}
    }

    if (!backupData || !backupData.store) {
      return res.status(400).json({ success: false, error: 'No valid backup file or JSON payload provided.' });
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
    const engine = (req.body.engine || req.headers['x-engine-mode'] || (whatsappWeb.getWhatsAppWebStatus().connected ? 'web' : 'meta')).toLowerCase();

    // === 100% FREE WHATSAPP WEB MODE DISPATCH ===
    if (engine === 'web') {
      const wwebStatus = whatsappWeb.getWhatsAppWebStatus();
      if (!wwebStatus.connected) {
        return res.status(400).json({
          success: false,
          error: 'Free WhatsApp Web is not connected. Please scan the QR code to link your phone.'
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

      const isOptedOut = await db.isOptedOut(cleanPhone);
      if (isOptedOut) {
        return res.status(403).json({
          success: false,
          error: `Recipient (+${cleanPhone}) has opted out of messaging.`
        });
      }

      let mType = 'image';
      if (req.file) {
        const mime = req.file.mimetype || '';
        if (mime.includes('pdf')) mType = 'document';
        else if (mime.includes('video')) mType = 'video';
      }

      const webResult = await whatsappWeb.sendWhatsAppWebMessage({
        to: cleanPhone,
        text: (text || '').trim(),
        mediaPath: req.file ? req.file.path : null,
        mediaType: mType,
        filename: req.file ? req.file.originalname : 'attachment.pdf'
      });

      if (webResult.success) {
        await db.saveOutgoingReply({
          phone: cleanPhone,
          name: recipientName || cleanPhone,
          text: (text || `[${mType.toUpperCase()} Attachment]`).trim(),
          type: req.file ? mType : 'text',
          metaMessageId: webResult.messageId,
          targetPhoneId: 'whatsapp_web',
          status: 'sent'
        }).catch(() => {});

        return res.json({
          success: true,
          recipient: cleanPhone,
          messageId: webResult.messageId,
          engine: 'whatsapp_web',
          message: 'Message delivered directly via 100% Free WhatsApp Web Engine!'
        });
      } else {
        return res.status(500).json({
          success: false,
          recipient: cleanPhone,
          error: webResult.error,
          engine: 'whatsapp_web'
        });
      }
    }

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

    // Check if recipient is within active 24-hr customer care window
    const convs = await db.getConversations();
    const conv = convs.find(c => c.phone === cleanPhone);
    const isWindowActive = conv ? conv.is_window_active : false;

    // Template selection and validation (optional: only if explicit template requested)
    let effectiveTemplate = (templateName && templateName.trim()) ? templateName.trim() : null;
    let effectiveLang = (templateLang && templateLang.trim()) ? templateLang.trim() : (cfg.templateLang || 'en_US');
    let varCount = null;

    // Validate template only if caller explicitly specified a template
    if (effectiveTemplate) {
      if (effectiveTemplate.toLowerCase() === 'hello_world') {
        return res.status(400).json({
          success: false,
          code: 131058,
          error: "Meta API Error (131058): 'hello_world' templates can only be sent from Public Test Numbers.",
          explanation: "Your registered number is a live production number. Please send a direct customized message or use an approved template created in Meta WhatsApp Manager."
        });
      }

      // Pre-validate against WABA if WABA ID is configured
      let hasMediaHdr = false;
      if (cfg.wabaId) {
        const val = await metaApi.validateTemplate({
          token: cfg.token,
          wabaId: cfg.wabaId,
          templateName: effectiveTemplate,
          templateLang: effectiveLang
        });
        if (!val.valid) {
          return res.status(400).json({
            success: false,
            code: val.code || 132001,
            error: val.error,
            explanation: val.error
          });
        }
        if (val.template && val.template.language) {
          effectiveLang = val.template.language;
        }
        if (val.template && typeof val.template.variableCount === 'number') {
          varCount = val.template.variableCount;
        }
        if (val.template && typeof val.template.hasMediaHeader === 'boolean') {
          hasMediaHdr = val.template.hasMediaHeader;
        }
      }
    }

    const mediaIdToSend = (effectiveTemplate ? (hasMediaHdr ? mediaId : null) : mediaId);

    // Send via Meta API
    const result = await metaApi.sendMessage({
      token: cfg.token,
      phoneNumberId: cfg.phoneNumberId,
      to: cleanPhone,
      text: (text || '').trim(),
      mediaId: mediaIdToSend,
      mediaType,
      filename: mediaFilename,
      templateName: effectiveTemplate,
      templateLang: effectiveLang,
      recipientName: recipientName || '',
      variableCount: varCount,
      hasMediaHeader: hasMediaHdr
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
        details: result.details,
        billingBlocked: result.billingBlocked || false,
        billingUrl: result.billingUrl || null
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

// Helper to locate recipients.xlsx across session directory and fallback locations
function findSessionExcel(req) {
  const sDir = getSessionDir(req);
  const candidates = [
    path.join(sDir, 'recipients.xlsx'),
    path.join(sessionsBaseDir, 'sess_default', 'recipients.xlsx'),
    path.join(__dirname, 'recipients.xlsx'),
    path.join(sDir, 'checking excel.xlsx'),
    path.join(sessionsBaseDir, 'sess_default', 'checking excel.xlsx'),
    path.join(__dirname, 'checking excel.xlsx')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// API: Upload Excel recipients file (mirrors to session, sess_default, and root so it never gets lost)
app.post('/api/upload/excel', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  let syncedCount = 0;
  try {
    const defaultDir = path.join(sessionsBaseDir, 'sess_default');
    if (!fs.existsSync(defaultDir)) fs.mkdirSync(defaultDir, { recursive: true });
    fs.copyFileSync(req.file.path, path.join(defaultDir, 'recipients.xlsx'));
    fs.copyFileSync(req.file.path, path.join(__dirname, 'recipients.xlsx'));

    // Automatically parse spreadsheet and sync contacts into DB so Live Inbox has all contacts immediately
    const parsed = parseRecipientsExcel(req.file.path);
    if (parsed.success && parsed.preview && parsed.preview.length > 0) {
      syncedCount = await db.syncContactsBatch(parsed.preview);
    }
  } catch (e) {
    console.warn('[Excel Copy/Sync Warning]:', e.message);
  }
  res.json({ success: true, filename: req.file.originalname, saved: 'recipients.xlsx', syncedContacts: syncedCount });
});

// API: Delete Excel recipients file
app.delete('/api/delete-excel', (req, res) => {
  try {
    const exPath = findSessionExcel(req);
    if (exPath && fs.existsSync(exPath)) fs.unlinkSync(exPath);
    const defPath = path.join(sessionsBaseDir, 'sess_default', 'recipients.xlsx');
    if (fs.existsSync(defPath)) fs.unlinkSync(defPath);
    const rootPath = path.join(__dirname, 'recipients.xlsx');
    if (fs.existsSync(rootPath)) fs.unlinkSync(rootPath);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Helper to find session media file (image, video, or pdf) with fallback
function findSessionMedia(sDir) {
  const dirs = [
    sDir,
    path.join(sessionsBaseDir, 'sess_default'),
    __dirname
  ];
  const candidates = [
    'campaign_media.pdf',
    'campaign_media.mp4',
    'campaign_media.3gp',
    'campaign_media.png',
    'campaign_media.jpg',
    'campaign.mp4',
    'campaign.jpg',
    'campaign.png',
    'campaign.pdf'
  ];
  for (const d of dirs) {
    if (!d || !fs.existsSync(d)) continue;
    for (const c of candidates) {
      const p = path.join(d, c);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

// API: Upload Media Attachment (Supports PDF documents, PNG/JPG images, and MP4/3GP videos)
app.post('/api/upload/media', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  const ext = path.extname(req.file.originalname).toLowerCase();
  let type = 'image';
  if (ext === '.pdf') type = 'document';
  else if (ext === '.mp4' || ext === '.3gp' || ext === '.3gpp') type = 'video';

  try {
    const defaultDir = path.join(sessionsBaseDir, 'sess_default');
    if (!fs.existsSync(defaultDir)) fs.mkdirSync(defaultDir, { recursive: true });
    fs.copyFileSync(req.file.path, path.join(defaultDir, path.basename(req.file.path)));
  } catch (e) {}
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
    const defaultDir = path.join(sessionsBaseDir, 'sess_default');
    if (!fs.existsSync(defaultDir)) fs.mkdirSync(defaultDir, { recursive: true });
    fs.copyFileSync(req.file.path, path.join(defaultDir, 'campaign.jpg'));
  } catch (e) {}
  res.json({ success: true, filename: req.file.originalname, saved: 'campaign.jpg', type: 'image' });
});

// API: Delete Media Attachment (Cleans all candidate media across sDir, sess_default, and workspace)
function clearAllSessionMedia(sDir) {
  const dirs = [sDir, path.join(sessionsBaseDir, 'sess_default'), __dirname];
  const candidates = [
    'campaign_media.pdf', 'campaign_media.mp4', 'campaign_media.3gp', 'campaign_media.3gpp',
    'campaign_media.png', 'campaign_media.jpg', 'campaign_media.jpeg',
    'campaign.mp4', 'campaign.jpg', 'campaign.jpeg', 'campaign.png', 'campaign.pdf'
  ];
  let deletedCount = 0;
  for (const d of dirs) {
    if (!d || !fs.existsSync(d)) continue;
    for (const c of candidates) {
      const p = path.join(d, c);
      if (fs.existsSync(p)) {
        try { fs.unlinkSync(p); deletedCount++; } catch (err) {}
      }
    }
  }
  return deletedCount;
}

app.delete('/api/delete-media', (req, res) => {
  try {
    const sDir = getSessionDir(req);
    const count = clearAllSessionMedia(sDir);
    res.json({ success: true, deleted: count });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.delete('/api/delete-image', (req, res) => {
  try {
    const sDir = getSessionDir(req);
    const count = clearAllSessionMedia(sDir);
    res.json({ success: true, deleted: count });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Check files status for current session
app.get('/api/files-status', async (req, res) => {
  const dir = getSessionDir(req);
  const exPath = findSessionExcel(req);
  const mediaPath = findSessionMedia(dir);

  let mediaType = null;
  let mediaFilename = null;
  if (mediaPath) {
    const ext = path.extname(mediaPath).toLowerCase();
    if (ext === '.pdf') mediaType = 'document';
    else if (ext === '.mp4' || ext === '.3gp' || ext === '.3gpp') mediaType = 'video';
    else mediaType = 'image';
    mediaFilename = path.basename(mediaPath);
  }

  let optOutCount = 0;
  try {
    const optList = await db.getOptOutList();
    optOutCount = optList.length;
  } catch (e) {}

  res.json({
    excelExists: !!(exPath && fs.existsSync(exPath)),
    imageExists: !!mediaPath,
    mediaExists: !!mediaPath,
    mediaType: mediaType,
    mediaFilename: mediaFilename,
    optOutCount: optOutCount
  });
});

/**
 * Native Node.js Excel & CSV parsing using xlsx.
 * Handles .xlsx, .xls, and .csv files directly in memory with robust column detection,
 * E.164 phone normalization, opt-out filtering, deduplication, and variable extraction.
 */
function parseRecipientsExcel(filePath, optOutPhones = new Set()) {
  if (!filePath || !fs.existsSync(filePath)) {
    return {
      success: false,
      exists: false,
      total: 0,
      valid: 0,
      consented: 0,
      non_consented: 0,
      duplicates: 0,
      invalid: 0,
      opted_out: 0,
      preview: []
    };
  }

  try {
    const workbook = XLSX.readFile(filePath, { cellDates: true });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      return { success: false, exists: true, total: 0, valid: 0, consented: 0, non_consented: 0, duplicates: 0, invalid: 0, opted_out: 0, preview: [] };
    }

    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
    if (!rows || rows.length === 0) {
      return { success: false, exists: true, total: 0, valid: 0, consented: 0, non_consented: 0, duplicates: 0, invalid: 0, opted_out: 0, preview: [] };
    }

    // Flexible column name matching
    const firstRow = rows[0] || {};
    const colKeys = Object.keys(firstRow);
    let nameKey = colKeys.find(k => /^(name|full_?name|recipient|contact_?name|customer_?name)$/i.test(k.trim()));
    let phoneKey = colKeys.find(k => /(phone|mobile|ph_?no|contact|number|whatsapp)/i.test(k.trim()));
    let consentKey = colKeys.find(k => /(consent|opt_?in|permission|agree|status)/i.test(k.trim()));

    if (!nameKey && colKeys.length > 0) nameKey = colKeys[0];
    if (!phoneKey && colKeys.length > 1) phoneKey = colKeys[1];

    const total = rows.length;
    const validRecords = [];
    const seenPhones = new Set();
    let duplicateCount = 0;
    let invalidCount = 0;
    let optedOutCount = 0;
    let consentedCount = 0;
    let nonConsentedCount = 0;

    for (let idx = 0; idx < rows.length; idx++) {
      const row = rows[idx];
      const rawName = String(row[nameKey] || '').trim();
      const rawPhone = String(row[phoneKey] || '').trim();

      if (!rawPhone) {
        invalidCount++;
        continue;
      }

      const clean = metaApi.cleanPhoneNumber(rawPhone, '91');
      if (!metaApi.isValidE164(clean)) {
        invalidCount++;
        continue;
      }

      if (optOutPhones.has(clean)) {
        optedOutCount++;
        continue;
      }

      if (seenPhones.has(clean)) {
        duplicateCount++;
        continue;
      }

      let hasConsent = true;
      if (consentKey && row[consentKey] !== undefined && String(row[consentKey]).trim()) {
        const val = String(row[consentKey]).trim().toLowerCase();
        if (['yes', 'y', 'true', '1', 'opted_in', 'optin', 'agreed', 'subscribed'].includes(val)) {
          hasConsent = true;
          consentedCount++;
        } else {
          hasConsent = false;
          nonConsentedCount++;
        }
      } else {
        consentedCount++;
      }

      seenPhones.add(clean);
      validRecords.push({
        row_idx: idx + 2,
        name: rawName || 'Customer',
        phone: clean,
        has_consent: hasConsent,
        raw_row: row
      });
    }

    return {
      success: true,
      exists: true,
      total,
      valid: validRecords.length,
      consented: consentedCount,
      non_consented: nonConsentedCount,
      duplicates: duplicateCount,
      invalid: invalidCount,
      opted_out: optedOutCount,
      preview: validRecords
    };
  } catch (err) {
    console.error('[Excel Parse Error]:', err.message);
    return {
      success: false,
      exists: true,
      error: 'Error parsing spreadsheet: ' + err.message,
      total: 0,
      valid: 0,
      consented: 0,
      non_consented: 0,
      duplicates: 0,
      invalid: 0,
      opted_out: 0,
      preview: []
    };
  }
}

// API: Parse Excel Recipients with pure Node.js validation, preview, and deduplication
app.get('/api/recipients', async (req, res) => {
  try {
    const exPath = findSessionExcel(req);
    if (!exPath || !fs.existsSync(exPath)) {
      return res.json({
        success: false,
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

    // Build opt-out phone set from both SQLite and optouts.json
    const optOutSet = new Set();
    try {
      const optList = await db.getOptOutList();
      for (const o of optList) {
        if (o.phone) optOutSet.add(o.phone);
      }
      const optOutFilePath = path.join(__dirname, 'optouts.json');
      if (fs.existsSync(optOutFilePath)) {
        const data = JSON.parse(fs.readFileSync(optOutFilePath, 'utf8'));
        for (const p of data.opted_out_numbers || []) {
          optOutSet.add(String(p).replace(/\D/g, ''));
        }
      }
    } catch (e) {}

    const parsed = parseRecipientsExcel(exPath, optOutSet);
    if (parsed.success && parsed.preview && parsed.preview.length > 0) {
      db.syncContactsBatch(parsed.preview).catch(err => console.warn('[Contact Sync Background]:', err.message));
    }
    res.json(parsed);
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to process Excel file: ' + err.message });
  }
});

// API: Download Official Sample Spreadsheet (.xlsx)
app.get('/api/sample-excel', (req, res) => {
  try {
    const wb = XLSX.utils.book_new();
    const sampleData = [
      ['Name', 'Phone', 'Consent', 'Notes'],
      ['Rahul Sharma', '919966559281', 'Yes', 'Existing policy holder'],
      ['Priya Patel', '919876543210', 'Yes', 'Renewal inquiry'],
      ['Amit Kumar', '919123456789', 'Yes', 'New claim update']
    ];
    const ws = XLSX.utils.aoa_to_sheet(sampleData);
    ws['!cols'] = [{ wch: 18 }, { wch: 18 }, { wch: 10 }, { wch: 28 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Recipients');

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="sample_whatsapp_recipients.xlsx"');
    res.send(buffer);
  } catch (err) {
    res.status(500).send('Error generating sample spreadsheet: ' + err.message);
  }
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
        isVideo: false,
        image: null
      });
    }
    if (ext === '.mp4' || ext === '.3gp' || ext === '.3gpp') {
      return res.json({
        type: 'video',
        filename: path.basename(mediaPath),
        isPdf: false,
        isVideo: true,
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
// 4. ENTERPRISE NATIVE BACKGROUND BULK CAMPAIGN QUEUE ENGINE (Requirement 5)
// ============================================================================

// In-Memory Campaign State Store (Session ID -> Job State)
const activeCampaignJobs = new Map();

function getCampaignJob(sid) {
  return activeCampaignJobs.get(sid) || null;
}

/**
 * Launches an asynchronous background campaign job with controlled pacing,
 * batch pausing, idempotency, retry backoff on 429, and automatic halt on fatal errors.
 */
function launchBackgroundCampaignJob({
  sessionId,
  campaignId,
  recipients,
  templateText,
  mediaId = null,
  mediaPath = null,
  mediaType = 'image',
  filename = 'attachment.pdf',
  templateName = null,
  templateLang = 'en_US',
  delayMs = 1500,
  token,
  phoneNumberId,
  wabaId = null,
  engine = 'meta'
}) {
  const job = {
    id: campaignId,
    sessionId,
    engine,
    mediaPath,
    status: 'running', // 'running' | 'paused' | 'completed' | 'cancelled' | 'failed'
    total: recipients.length,
    currentIndex: 0,
    sent: 0,
    accepted: 0,
    delivered: 0,
    read: 0,
    failed: 0,
    logs: [],
    recipients,
    templateText,
    mediaId,
    mediaType,
    filename,
    templateName,
    templateLang,
    delayMs,
    token,
    phoneNumberId,
    wabaId,
    startedAt: new Date().toISOString(),
    completedAt: null,
    listeners: new Set()
  };

  activeCampaignJobs.set(sessionId, job);

  // Background execution loop
  (async () => {
    const broadcast = (data) => {
      for (const res of job.listeners) {
        try {
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch (e) {}
      }
    };

    const addLog = (text, type = 'info') => {
      const entry = { time: new Date().toLocaleTimeString(), text, type };
      job.logs.push(entry);
      if (job.logs.length > 500) job.logs.shift();
      broadcast({ type: 'log', text, logType: type, timestamp: entry.time });
    };

    if (job.engine === 'web') {
      addLog(`Connecting to 100% Free WhatsApp Web Engine (Zero Meta Cost Mode)...`, 'ok');
      addLog(`Background campaign engine started: ${job.total} recipients queued. [Campaign ID: ${job.id}]`);
    } else {
      addLog(`Connecting to Official Meta WhatsApp Cloud API...`);
      addLog(`Background campaign engine started: ${job.total} recipients queued. [Campaign ID: ${job.id}]`);
    }

    // 1. Fetch conversations from DB to know which recipients have active 24h windows
    let existingConvs = [];
    let effectiveTemplate = job.templateName || null;
    let effectiveLang = job.templateLang || 'en_US';
    let matchedTemplate = null;

    if (job.engine === 'meta') {
      try {
        existingConvs = await db.getConversations();
      } catch (e) {}

      // 2. Resolve approved template to comply with Meta 24-hr policy
      if (!job.wabaId && job.token && job.phoneNumberId) {
        try {
          const autoWaba = await metaApi.autoDiscoverWabaId(job.token, job.phoneNumberId);
          if (autoWaba) {
            job.wabaId = autoWaba;
            await db.setSetting('WHATSAPP_BUSINESS_ACCOUNT_ID', autoWaba).catch(() => {});
          }
        } catch (e) {}
      }

      if (job.wabaId) {
        try {
          const tplsRes = await metaApi.fetchApprovedTemplates(job.token, job.wabaId);
          if (tplsRes.success) {
            const nonHelloWorld = (tplsRes.templates || []).filter(t => !t.isHelloWorld && t.name.toLowerCase() !== 'hello_world');
            if (!effectiveTemplate && nonHelloWorld.length > 0) {
              effectiveTemplate = nonHelloWorld[0].name;
              effectiveLang = nonHelloWorld[0].language || 'en_US';
              addLog(`[Policy Compliance] Contacts outside 24h window require a Meta Template. Auto-selected approved template: '${effectiveTemplate}' (${effectiveLang})`, 'ok');
            } else if (!effectiveTemplate && (tplsRes.inReview || []).length > 0) {
              addLog(`[Policy Notice] Custom template(s) '${tplsRes.inReview.map(t => t.name).join(', ')}' are currently PENDING Meta approval. Meta restricts 'hello_world' on live numbers. Once Meta finishes review, click ⟳ Refresh.`, 'warn');
            }
            if (effectiveTemplate) {
              const cleanTpl = effectiveTemplate.trim().toLowerCase();
              const sameName = (tplsRes.allTemplates || []).filter(t => (t.name || '').trim().toLowerCase() === cleanTpl);
              matchedTemplate = sameName.find(t => t.language === effectiveLang) || sameName[0] || null;
              if (matchedTemplate) {
                if (matchedTemplate.language) effectiveLang = matchedTemplate.language;
                if (matchedTemplate.status !== 'APPROVED') {
                  addLog(`[Template Notice] Selected template '${effectiveTemplate}' has status '${matchedTemplate.status}' in Meta WABA. Only APPROVED templates can be delivered.`, 'warn');
                }
              }
            }
          }
        } catch (e) {
          console.warn('[Template Auto-Detect Error]:', e.message);
        }
      }

      // 3. Pre-flight Billing Currency Check (Protects against Error 131042)
      if (job.wabaId && job.token) {
        try {
          const currCheck = await metaApi.getWabaCurrency(job.token, job.wabaId);
          if (currCheck.success && currCheck.currencyConfigured === false) {
            const billingUrl = `https://business.facebook.com/billing_hub/accounts/details/?business_id=1396896010170779&asset_id=${job.wabaId}&wizard_name=CHANGE_COUNTRY_CURRENCY&account_type=whatsapp-business-account`;
            const billingErrMsg = `Meta Account Currency Not Configured (Error 131042): WhatsApp Business Account currency is missing in Meta Business Manager. Meta Cloud API blocks message delivery to handsets. Please configure your billing currency at: ${billingUrl}`;
            addLog(`\n[CRITICAL HALT - BILLING BLOCKER 131042]`, 'err');
            addLog(billingErrMsg, 'err');
            job.status = 'failed';
            job.completedAt = new Date().toISOString();
            await db.updateCampaignStats(job.id, job.sent, job.failed, 'failed').catch(() => {});
            broadcast({
              type: 'finish',
              exitCode: 131042,
              sentCount: 0,
              failedCount: job.total,
              status: 'failed',
              error: billingErrMsg,
              billingUrl
            });
            return;
          }
        } catch (e) {
          console.warn('[WABA Currency Pre-check Error]:', e.message);
        }
      }
    }

    try {
      for (let i = job.currentIndex; i < job.total; i++) {
        // Handle Pause state
        while (job.status === 'paused') {
          await new Promise(r => setTimeout(r, 800));
        }

        // Handle Cancel state
        if (job.status === 'cancelled') {
          addLog(`Campaign cancelled by user. Stopped at recipient ${i}/${job.total}.`, 'warn');
          break;
        }

        job.currentIndex = i;
        const recip = job.recipients[i];
        const name = recip.name || 'Customer';
        const phone = recip.phone;
        const cleanPhone = metaApi.cleanPhoneNumber(phone);

        // Dynamic Variable Replacement: {{name}}, {{phone}}, and any spreadsheet column {{col_name}}
        let textToSend = (job.templateText || '');
        if (recip.raw_row && typeof recip.raw_row === 'object') {
          for (const [col, val] of Object.entries(recip.raw_row)) {
            const regex = new RegExp(`\\{\\{${col}\\}\\}`, 'gi');
            textToSend = textToSend.replace(regex, String(val !== undefined && val !== null ? val : ''));
          }
        }
        textToSend = textToSend.replace(/\{\{name\}\}/gi, name).replace(/\{\{phone\}\}/gi, cleanPhone);

        // === 100% FREE WHATSAPP WEB BULK DISPATCH ===
        if (job.engine === 'web') {
          addLog(`[${i + 1}/${job.total}] Sending Free WhatsApp message to ${name} (+${cleanPhone})...`);

          const wStatus = whatsappWeb.getWhatsAppWebStatus();
          if (!wStatus.connected) {
            job.status = 'failed';
            addLog(`[CRITICAL HALT] WhatsApp Web disconnected. Please scan the QR code to re-link your phone.`, 'err');
            break;
          }

          const result = await whatsappWeb.sendWhatsAppWebMessage({
            to: cleanPhone,
            text: textToSend,
            mediaPath: job.mediaPath,
            mediaType: job.mediaType,
            filename: job.filename
          });

          if (result.success) {
            job.sent++;
            job.accepted++;
            addLog(`--> DELIVERED via Free WhatsApp Web (Msg ID: ${result.messageId}) [₹0 Meta Cost]`, 'ok');

            await db.logCampaignRecipient(job.id, cleanPhone, name, 'sent', result.messageId).catch(() => {});
            await db.saveOutgoingReply({
              phone: cleanPhone,
              name,
              text: textToSend || '[Media Attachment]',
              metaMessageId: result.messageId,
              targetPhoneId: 'whatsapp_web',
              status: 'sent'
            }).catch(() => {});
          } else {
            job.failed++;
            addLog(`--> FAILED via WhatsApp Web: ${result.error}`, 'err');

            await db.logCampaignRecipient(
              job.id,
              cleanPhone,
              name,
              'failed',
              null,
              500,
              result.error
            ).catch(() => {});

            await db.saveOutgoingReply({
              phone: cleanPhone,
              name,
              text: textToSend || '[Media Attachment]',
              targetPhoneId: 'whatsapp_web',
              status: 'failed',
              errorMessage: result.error
            }).catch(() => {});
          }

          await db.updateCampaignStats(job.id, job.sent, job.failed, job.status === 'running' ? 'running' : job.status).catch(() => {});

          broadcast({
            type: 'progress',
            index: i + 1,
            total: job.total,
            percent: Math.round(((i + 1) / job.total) * 100),
            sent: job.sent,
            failed: job.failed,
            recipient: { name, phone },
            result
          });

          // Anti-Ban Human-like Pacing: 5s to 8s randomized delay between messages to protect user's WhatsApp number
          if (i < job.total - 1 && job.status === 'running') {
            const basePacing = Math.max(job.delayMs || 5000, 5000);
            const antiBanDelay = basePacing + Math.floor(Math.random() * 2500);
            addLog(`[Anti-Ban Protection] Pacing ${Math.round(antiBanDelay / 1000)}s before next message to protect linked phone number...`);
            await new Promise(r => setTimeout(r, antiBanDelay));
          }

          continue; // Finish web message, proceed to next recipient
        }

        addLog(`[${i + 1}/${job.total}] Sending to ${name} (+${cleanPhone})...`);

        // Check if this contact has an active 24h care window
        const conv = existingConvs.find(c => c.phone === cleanPhone);
        const isWindowActive = conv ? conv.is_window_active : false;

        // If outside 24h window, Meta policy strictly requires an APPROVED template!
        const tplToUse = isWindowActive ? (job.templateName || null) : (effectiveTemplate || job.templateName || null);
        const langToUse = effectiveLang || job.templateLang || 'en_US';
        const varCount = matchedTemplate ? matchedTemplate.variableCount : null;
        const hasMediaHdr = matchedTemplate ? !!matchedTemplate.hasMediaHeader : false;
        const mediaIdToSend = (tplToUse ? (hasMediaHdr ? job.mediaId : null) : job.mediaId);

        if (job.mediaId && tplToUse && !hasMediaHdr && i === job.currentIndex) {
          addLog(`[Template Safety] Approved template '${tplToUse}' has no media header in Meta. Media parameter safely omitted to strictly comply with Meta Cloud API rules (prevents Error 132018).`, 'ok');
        }

        // Build template variables array for approved templates with variable parameters
        let tplVars = null;
        if (varCount && varCount > 0) {
          tplVars = [];
          tplVars.push(name || 'Customer');
          if (varCount >= 2) {
            if (recip.raw_row) {
              const candidateVal = recip.raw_row['var2'] || recip.raw_row['variable2'] || recip.raw_row['Policy'] || recip.raw_row['Notes'] || recip.raw_row['Amount'] || (textToSend !== job.templateText ? textToSend : 'Notification');
              tplVars.push(String(candidateVal || 'Notification'));
            } else {
              tplVars.push(textToSend || 'Notification');
            }
          }
          for (let v = tplVars.length; v < varCount; v++) {
            const colName = `var${v + 1}`;
            const extraVal = (recip.raw_row && recip.raw_row[colName]) ? recip.raw_row[colName] : '-';
            tplVars.push(String(extraVal));
          }
        }

        // Strict Policy Enforcement: Never dispatch free-form text outside 24h window!
        if (!isWindowActive && !tplToUse) {
          job.failed++;
          const errDetail = 'Meta Policy Restriction (Error 131047): Recipient is outside the 24-hr customer service window. Free-form text was safely blocked to prevent Meta delivery failure. An APPROVED WhatsApp template is required.';
          addLog(`--> BLOCKED [Policy 131047]: Recipient (+${cleanPhone}) requires an APPROVED Meta Template because the 24h service window is closed.`, 'err');

          await db.logCampaignRecipient(
            job.id,
            cleanPhone,
            name,
            'failed',
            null,
            131047,
            errDetail
          ).catch(() => {});

          await db.saveOutgoingReply({
            phone: cleanPhone,
            name,
            text: textToSend,
            targetPhoneId: job.phoneNumberId,
            status: 'failed',
            errorMessage: errDetail
          }).catch(() => {});

          await db.updateCampaignStats(job.id, job.sent, job.failed, job.status === 'running' ? 'running' : job.status).catch(() => {});

          broadcast({
            type: 'progress',
            index: i + 1,
            total: job.total,
            percent: Math.round(((i + 1) / job.total) * 100),
            sent: job.sent,
            failed: job.failed,
            recipient: { name, phone },
            result: { success: false, code: 131047, error: errDetail }
          });

          continue; // Process remaining recipients independently!
        }

        let result = await metaApi.sendMessage({
          token: job.token,
          phoneNumberId: job.phoneNumberId,
          to: cleanPhone,
          text: textToSend,
          mediaId: mediaIdToSend,
          mediaType: job.mediaType,
          filename: job.filename,
          templateName: tplToUse,
          templateLang: langToUse,
          recipientName: name,
          variableCount: varCount,
          templateVariables: tplVars,
          hasMediaHeader: hasMediaHdr
        });

        // Language mismatch auto-retry: if 132001 (template not found for language), try alternate en/en_US
        if (!result.success && result.code === 132001 && tplToUse) {
          const altLang = (langToUse === 'en_US' || langToUse === 'en-US') ? 'en' : (langToUse === 'en' ? 'en_US' : null);
          if (altLang) {
            addLog(`[Language Auto-Retry] Retrying template '${tplToUse}' with alternate language '${altLang}'...`, 'warn');
            result = await metaApi.sendMessage({
              token: job.token,
              phoneNumberId: job.phoneNumberId,
              to: cleanPhone,
              text: textToSend,
              mediaId: mediaIdToSend,
              mediaType: job.mediaType,
              filename: job.filename,
              templateName: tplToUse,
              templateLang: altLang,
              recipientName: name,
              variableCount: varCount,
              templateVariables: tplVars,
              hasMediaHeader: hasMediaHdr
            });
          }
        }

        // Retry on rate limit (HTTP 429 or Meta Error 130429) with progressive cooling backoff
        if (!result.success && (result.code === 429 || result.code === 130429)) {
          let retryAttempts = 0;
          while (!result.success && (result.code === 429 || result.code === 130429) && retryAttempts < 2) {
            retryAttempts++;
            const coolOffSec = retryAttempts === 1 ? 15 : 25;
            addLog(`[Rate Limit 130429] Meta throttled sending (Too many messages in short time). Cooling down ${coolOffSec}s to reset Meta rate limiter...`, 'warn');
            await new Promise(r => setTimeout(r, coolOffSec * 1000));
            result = await metaApi.sendMessage({
              token: job.token,
              phoneNumberId: job.phoneNumberId,
              to: cleanPhone,
              text: textToSend,
              mediaId: mediaIdToSend,
              mediaType: job.mediaType,
              filename: job.filename,
              templateName: tplToUse,
              templateLang: langToUse,
              recipientName: name,
              variableCount: varCount,
              templateVariables: tplVars,
              hasMediaHeader: hasMediaHdr
            });
          }
          // After experiencing a rate limit, automatically increase inter-message pacing
          if (job.delayMs < 3500) {
            job.delayMs = 3500;
            addLog(`[Auto-Pacing] Dynamically increased pacing to 3.5s per message to ensure 100% deliverability without triggering Meta rate limits.`);
          }
        }

        if (result.success) {
          job.sent++;
          job.accepted++;
          const usedTplStr = tplToUse ? ` (Template: ${tplToUse})` : '';
          addLog(`--> ACCEPTED by Meta Cloud API (Meta ID: ${result.messageId})${usedTplStr}`, 'ok');

          await db.logCampaignRecipient(job.id, cleanPhone, name, 'sent', result.messageId).catch(() => {});
          await db.saveOutgoingReply({
            phone: cleanPhone,
            name,
            text: textToSend || (tplToUse ? `Template: ${tplToUse}` : '[Media Attachment]'),
            metaMessageId: result.messageId,
            targetPhoneId: job.phoneNumberId,
            status: 'sent'
          }).catch(() => {});
        } else {
          job.failed++;
          const errDetail = result.explanation || result.error;
          addLog(`--> FAILED [Code ${result.code}]: ${errDetail}`, 'err');

          await db.logCampaignRecipient(
            job.id,
            cleanPhone,
            name,
            'failed',
            null,
            result.code,
            errDetail
          ).catch(() => {});

          await db.saveOutgoingReply({
            phone: cleanPhone,
            name,
            text: textToSend || (tplToUse ? `Template: ${tplToUse}` : '[Media Attachment]'),
            targetPhoneId: job.phoneNumberId,
            status: 'failed',
            errorMessage: errDetail
          }).catch(() => {});

          // Automatic halt on fatal credentials or account error
          if ([190, 131031, 131042].includes(result.code)) {
            job.status = 'failed';
            addLog(`[CRITICAL HALT] Meta returned fatal error ${result.code}. Halting campaign to protect account.`, 'err');
            break;
          }
        }

        // Update campaign progress in database
        await db.updateCampaignStats(job.id, job.sent, job.failed, job.status === 'running' ? 'running' : job.status).catch(() => {});

        // Broadcast progress event to connected SSE clients
        broadcast({
          type: 'progress',
          index: i + 1,
          total: job.total,
          percent: Math.round(((i + 1) / job.total) * 100),
          sent: job.sent,
          failed: job.failed,
          recipient: { name, phone },
          result
        });

        // Controlled pacing delay between messages
        if (i < job.total - 1 && job.status === 'running') {
          let wait = job.delayMs;
          // Extra 2s pause every 10 messages for Meta Cloud API rate compliance
          if ((i + 1) % 10 === 0) {
            wait += 2000;
            addLog(`[Batch Pause] Completed batch of 10. Pausing 2s to strictly comply with Meta rate limits...`);
          }
          await new Promise(r => setTimeout(r, wait));
        }
      }

      if (job.status === 'running') {
        job.status = 'completed';
        addLog(`Campaign dispatch finished! Total: ${job.total}, Accepted: ${job.sent}, Failed: ${job.failed}.`, 'ok');
      }

      job.completedAt = new Date().toISOString();
      await db.updateCampaignStats(job.id, job.sent, job.failed, job.status).catch(() => {});
      await db.createBackupNow().catch(() => {});

      broadcast({
        type: 'finish',
        exitCode: job.status === 'completed' ? 0 : 1,
        sentCount: job.sent,
        failedCount: job.failed,
        status: job.status
      });
    } catch (fatalErr) {
      console.error('[Bulk Campaign Engine Error]:', fatalErr.message);
      job.status = 'failed';
      addLog(`Fatal engine error: ${fatalErr.message}`, 'err');
      broadcast({ type: 'finish', exitCode: 1, error: fatalErr.message });
    }
  })();

  return job;
}

// API: Start Background Bulk Campaign
app.post('/api/bulk/start', async (req, res) => {
  try {
    const engine = (req.body?.engine || req.headers['x-engine-mode'] || (whatsappWeb.getWhatsAppWebStatus().connected ? 'web' : 'meta')).toLowerCase();
    const cfg = await getEffectiveConfig(req);

    if (engine === 'web') {
      const wStatus = whatsappWeb.getWhatsAppWebStatus();
      if (!wStatus.connected) {
        return res.status(400).json({
          success: false,
          error: 'Free WhatsApp Web is not connected. Please scan the QR code to link your phone.'
        });
      }
    } else {
      if (!cfg.token || !cfg.phoneNumberId) {
        return res.status(401).json({
          success: false,
          error: 'Meta Cloud API not configured. Please enter your Phone Number ID and Permanent Access Token in Settings.'
        });
      }
    }

    const sDir = getSessionDir(req);
    const exPath = findSessionExcel(req);
    if (!exPath || !fs.existsSync(exPath)) {
      return res.status(400).json({ success: false, error: 'No recipients.xlsx file uploaded. Please upload your Excel list.' });
    }

    // Build opt-out phone set
    const optOutSet = new Set();
    try {
      const optList = await db.getOptOutList();
      for (const o of optList) {
        if (o.phone) optOutSet.add(o.phone);
      }
    } catch (e) {}

    const parsed = parseRecipientsExcel(exPath, optOutSet);
    if (!parsed.valid || parsed.preview.length === 0) {
      return res.status(400).json({ success: false, error: 'No valid recipient phone numbers found in the uploaded file.' });
    }

    const sid = getSessionId(req);
    const existingJob = getCampaignJob(sid);
    if (existingJob && existingJob.status === 'running') {
      return res.status(409).json({
        success: false,
        error: 'A campaign is already actively running for this session. Please pause or cancel it first.',
        campaignId: existingJob.id
      });
    }

    // Read message text and media
    const msgPath = path.join(sDir, 'message.txt');
    let templateText = 'Hello {{name}},\nThank you for choosing our service!';
    if (req.body && req.body.message) {
      templateText = req.body.message;
    } else if (fs.existsSync(msgPath)) {
      templateText = fs.readFileSync(msgPath, 'utf8');
    }

    const mediaPath = findSessionMedia(sDir);
    let mediaId = null;
    let mediaType = 'image';
    let mediaFilename = 'attachment.pdf';
    if (mediaPath) {
      if (engine === 'meta') {
        try {
          const up = await metaApi.uploadMedia(cfg.token, cfg.phoneNumberId, mediaPath);
          mediaId = up.mediaId;
          mediaType = up.type;
          mediaFilename = up.filename;
        } catch (e) {
          console.warn('[Bulk Media Upload Note]:', e.message);
        }
      } else {
        mediaFilename = path.basename(mediaPath);
        if (mediaFilename.endsWith('.pdf')) mediaType = 'document';
        else if (mediaFilename.endsWith('.mp4')) mediaType = 'video';
      }
    }

    const campaignId = 'camp_' + Date.now();
    await db.createCampaign(campaignId, 'Bulk Campaign ' + new Date().toLocaleDateString(), parsed.valid).catch(() => {});

    const job = launchBackgroundCampaignJob({
      sessionId: sid,
      campaignId,
      engine,
      mediaPath,
      recipients: parsed.preview,
      templateText,
      mediaId,
      mediaType,
      filename: mediaFilename,
      templateName: (req.body?.templateName || cfg.templateName || '').trim() || null,
      templateLang: (req.body?.templateLang || cfg.templateLang || 'en_US').trim(),
      delayMs: parseInt(req.body?.delayMs) || (engine === 'web' ? 5000 : 1500),
      token: cfg.token,
      phoneNumberId: cfg.phoneNumberId,
      wabaId: cfg.wabaId
    });

    res.json({
      success: true,
      campaignId,
      totalRecipients: parsed.valid,
      message: `Bulk campaign engine launched with ${parsed.valid} recipients in background.`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Get Current Bulk Campaign Job Status (Preserves progress across browser refreshes)
app.get('/api/bulk/status', (req, res) => {
  const sid = getSessionId(req);
  const job = getCampaignJob(sid);
  if (!job) {
    return res.json({
      running: false,
      status: 'idle',
      total: 0,
      currentIndex: 0,
      sent: 0,
      failed: 0,
      percent: 0,
      logs: []
    });
  }

  res.json({
    running: job.status === 'running',
    status: job.status,
    id: job.id,
    total: job.total,
    currentIndex: job.currentIndex,
    sent: job.sent,
    accepted: job.accepted,
    failed: job.failed,
    percent: job.total > 0 ? Math.round((job.currentIndex / job.total) * 100) : 0,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    logs: job.logs.slice(-50)
  });
});

// API: Pause Bulk Campaign
app.post('/api/bulk/pause', (req, res) => {
  const sid = getSessionId(req);
  const job = getCampaignJob(sid);
  if (!job || job.status !== 'running') {
    return res.status(400).json({ success: false, error: 'No active running campaign to pause.' });
  }
  job.status = 'paused';
  job.logs.push({ time: new Date().toLocaleTimeString(), text: 'Campaign paused by user.', type: 'warn' });
  res.json({ success: true, status: 'paused', message: 'Campaign safely paused.' });
});

// API: Resume Bulk Campaign
app.post('/api/bulk/resume', (req, res) => {
  const sid = getSessionId(req);
  const job = getCampaignJob(sid);
  if (!job || job.status !== 'paused') {
    return res.status(400).json({ success: false, error: 'No paused campaign to resume.' });
  }
  job.status = 'running';
  job.logs.push({ time: new Date().toLocaleTimeString(), text: 'Campaign resumed by user.', type: 'info' });
  res.json({ success: true, status: 'running', message: 'Campaign resumed.' });
});

// API: Cancel Bulk Campaign
app.post('/api/bulk/cancel', (req, res) => {
  const sid = getSessionId(req);
  const job = getCampaignJob(sid);
  if (!job || !['running', 'paused'].includes(job.status)) {
    return res.status(400).json({ success: false, error: 'No active campaign to cancel.' });
  }
  job.status = 'cancelled';
  job.logs.push({ time: new Date().toLocaleTimeString(), text: 'Campaign cancelled by user.', type: 'warn' });
  res.json({ success: true, status: 'cancelled', message: 'Campaign cancelled.' });
});

// API: Re-Send to Failed Campaign Recipients Only
app.post('/api/bulk/retry-failed', async (req, res) => {
  try {
    const sid = getSessionId(req);
    const existingJob = getCampaignJob(sid);
    if (existingJob && ['running', 'paused'].includes(existingJob.status)) {
      return res.status(400).json({ success: false, error: 'A campaign is already running. Please wait for it to complete.' });
    }

    const cfg = await getEffectiveConfig(req);
    if (!cfg.token || !cfg.phoneNumberId) {
      return res.status(401).json({ success: false, error: 'Meta Cloud API credentials missing! Configure Phone Number ID and Token in Settings.' });
    }

    // Retrieve failed recipients from database
    const logs = await db.getRecentCampaignLogs(2000);
    const failedLogs = logs.filter(l => (l.status || '').toLowerCase() === 'failed');

    const seen = new Set();
    const failedRecipients = [];
    for (const log of failedLogs) {
      const cleanPhone = metaApi.cleanPhoneNumber(log.phone);
      if (cleanPhone && !seen.has(cleanPhone)) {
        seen.add(cleanPhone);
        failedRecipients.push({
          name: log.name || 'Customer',
          phone: cleanPhone
        });
      }
    }

    if (failedRecipients.length === 0) {
      return res.status(400).json({ success: false, error: 'No failed contacts found to retry.' });
    }

    const sDir = getSessionDir(req);
    const msgPath = path.join(sDir, 'message.txt');
    let templateText = 'Hello {{name}},\nThank you for choosing our service!';
    if (fs.existsSync(msgPath)) {
      templateText = fs.readFileSync(msgPath, 'utf8');
    }

    const mediaPath = findSessionMedia(sDir);
    let mediaId = null;
    let mediaType = 'image';
    let mediaFilename = 'attachment.pdf';
    if (mediaPath) {
      try {
        const up = await metaApi.uploadMedia(cfg.token, cfg.phoneNumberId, mediaPath);
        mediaId = up.mediaId;
        mediaType = up.type;
        mediaFilename = up.filename;
      } catch (e) {}
    }

    const campaignId = 'retry_failed_' + Date.now();
    await db.createCampaign(campaignId, 'Retry Failed Contacts (' + failedRecipients.length + ')', failedRecipients.length).catch(() => {});

    const job = launchBackgroundCampaignJob({
      sessionId: sid,
      campaignId,
      recipients: failedRecipients,
      templateText,
      mediaId,
      mediaType,
      filename: mediaFilename,
      templateName: (req.body?.templateName || cfg.templateName || '').trim() || null,
      templateLang: (req.body?.templateLang || cfg.templateLang || 'en_US').trim(),
      delayMs: 3500, // Safe 3.5s delay to strictly comply with Meta rate limits
      token: cfg.token,
      phoneNumberId: cfg.phoneNumberId,
      wabaId: cfg.wabaId
    });

    res.json({
      success: true,
      campaignId,
      totalRecipients: failedRecipients.length,
      message: `Launched retry job for ${failedRecipients.length} failed contacts with safe 3.5s pacing.`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Send Message to One Selected Recipient from Excel Preview List
app.post('/api/bulk/send-single-recipient', async (req, res) => {
  try {
    const { phone, name, templateName, templateLang } = req.body;
    const engine = (req.body?.engine || req.headers['x-engine-mode'] || (whatsappWeb.getWhatsAppWebStatus().connected ? 'web' : 'meta')).toLowerCase();
    const cfg = await getEffectiveConfig(req);

    if (engine === 'web') {
      const wStatus = whatsappWeb.getWhatsAppWebStatus();
      if (!wStatus.connected) {
        return res.status(400).json({ success: false, error: 'Free WhatsApp Web is not connected. Please scan the QR code to link your phone.' });
      }
      if (!phone) {
        return res.status(400).json({ success: false, error: 'Recipient phone number is required.' });
      }
      const cleanPhone = metaApi.cleanPhoneNumber(phone);
      if (!metaApi.isValidE164(cleanPhone)) {
        return res.status(400).json({ success: false, error: `Invalid phone number: +${cleanPhone}` });
      }

      const sDir = getSessionDir(req);
      const msgPath = path.join(sDir, 'message.txt');
      let textToSend = 'Hello {{name}},\nThank you for choosing our service!';
      if (fs.existsSync(msgPath)) {
        textToSend = fs.readFileSync(msgPath, 'utf8');
      }
      textToSend = textToSend.replace(/\{\{name\}\}/gi, name || 'Customer');

      const mediaPath = findSessionMedia(sDir);
      let mediaType = 'image';
      if (mediaPath && mediaPath.endsWith('.pdf')) mediaType = 'document';
      else if (mediaPath && mediaPath.endsWith('.mp4')) mediaType = 'video';

      const webRes = await whatsappWeb.sendWhatsAppWebMessage({
        to: cleanPhone,
        text: textToSend,
        mediaPath,
        mediaType,
        filename: mediaPath ? path.basename(mediaPath) : 'attachment.pdf'
      });

      if (webRes.success) {
        await db.logCampaignRecipient('manual_single_excel', cleanPhone, name || 'Customer', 'sent', webRes.messageId).catch(() => {});
        await db.saveOutgoingReply({
          phone: cleanPhone,
          name: name || 'Customer',
          text: textToSend,
          metaMessageId: webRes.messageId,
          targetPhoneId: 'whatsapp_web',
          status: 'sent'
        }).catch(() => {});
        return res.json({ success: true, messageId: webRes.messageId, recipient: cleanPhone, engine: 'whatsapp_web' });
      } else {
        return res.status(500).json({ success: false, error: webRes.error, recipient: cleanPhone, engine: 'whatsapp_web' });
      }
    }

    if (!cfg.token || !cfg.phoneNumberId) {
      return res.status(401).json({ success: false, error: 'Meta Cloud API not configured.' });
    }
    if (!phone) {
      return res.status(400).json({ success: false, error: 'Recipient phone number is required.' });
    }

    const cleanPhone = metaApi.cleanPhoneNumber(phone);
    if (!metaApi.isValidE164(cleanPhone)) {
      return res.status(400).json({ success: false, error: `Invalid phone number: +${cleanPhone}` });
    }

    const sDir = getSessionDir(req);
    const msgPath = path.join(sDir, 'message.txt');
    let textToSend = 'Hello {{name}},\nThank you for choosing our service!';
    if (fs.existsSync(msgPath)) {
      textToSend = fs.readFileSync(msgPath, 'utf8');
    }
    textToSend = textToSend.replace(/\{\{name\}\}/gi, name || 'Customer');

    const mediaPath = findSessionMedia(sDir);
    let mediaId = null;
    let mediaType = 'image';
    let mediaFilename = 'attachment.pdf';
    if (mediaPath) {
      try {
        const up = await metaApi.uploadMedia(cfg.token, cfg.phoneNumberId, mediaPath);
        mediaId = up.mediaId;
        mediaType = up.type;
        mediaFilename = up.filename;
      } catch (e) {}
    }

    let tplToUse = (templateName || cfg.templateName || '').trim() || null;
    let tplLangToUse = templateLang || cfg.templateLang || 'en_US';
    let varCount = null;
    let hasMediaHdr = false;
    if (tplToUse && cfg.wabaId) {
      try {
        const val = await metaApi.validateTemplate({
          token: cfg.token,
          wabaId: cfg.wabaId,
          templateName: tplToUse,
          templateLang: tplLangToUse
        });
        if (val.valid && val.template) {
          if (val.template.language) tplLangToUse = val.template.language;
          if (typeof val.template.variableCount === 'number') varCount = val.template.variableCount;
          if (typeof val.template.hasMediaHeader === 'boolean') hasMediaHdr = val.template.hasMediaHeader;
        }
      } catch (e) {}
    }
    const mediaIdToSend = (tplToUse ? (hasMediaHdr ? mediaId : null) : mediaId);

    const result = await metaApi.sendMessage({
      token: cfg.token,
      phoneNumberId: cfg.phoneNumberId,
      to: cleanPhone,
      text: textToSend,
      mediaId: mediaIdToSend,
      mediaType,
      filename: mediaFilename,
      templateName: tplToUse,
      templateLang: tplLangToUse,
      recipientName: name || 'Customer',
      variableCount: varCount,
      hasMediaHeader: hasMediaHdr
    });

    if (result.success) {
      await db.logCampaignRecipient('manual_single_excel', cleanPhone, name || 'Customer', 'sent', result.messageId).catch(() => {});
      await db.saveOutgoingReply({
        phone: cleanPhone,
        text: textToSend,
        metaMessageId: result.messageId,
        status: 'sent'
      }).catch(() => {});
      res.json({ success: true, messageId: result.messageId, recipient: cleanPhone });
    } else {
      await db.logCampaignRecipient('manual_single_excel', cleanPhone, name || 'Customer', 'failed', null, result.code, result.explanation || result.error).catch(() => {});
      res.status(result.code === 400 ? 400 : 502).json({
        success: false,
        code: result.code,
        error: result.error,
        explanation: result.explanation
      });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Download Failed Recipients Report as CSV
app.get('/api/reports/failed-recipients', async (req, res) => {
  try {
    const logs = await db.getRecentCampaignLogs(2000);
    const failedLogs = logs.filter(l => (l.status || '').toLowerCase() === 'failed');

    let csv = 'Campaign,Recipient Name,Phone Number,Error Code,Error Details,Sent Timestamp\n';
    for (const log of failedLogs) {
      const camp = (log.campaign_id || 'Bulk').replace(/"/g, '""');
      const name = (log.name || 'Customer').replace(/"/g, '""');
      const phone = log.phone ? `+${log.phone}` : '';
      const errCode = log.error_code || '';
      const errDetails = (log.error_details || '').replace(/"/g, '""').replace(/\r?\n/g, ' ');
      const sentAt = log.sent_at || '';
      csv += `"${camp}","${name}","${phone}","${errCode}","${errDetails}","${sentAt}"\n`;
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="whatsapp_failed_recipients.csv"');
    res.send(csv);
  } catch (e) {
    res.status(500).send('Error generating failed recipients report: ' + e.message);
  }
});

// SSE Streaming Adapter for UI execution terminal (Connects directly to Native Background Engine)
app.get('/api/stream-campaign', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const engine = (req.query?.engine || (whatsappWeb.getWhatsAppWebStatus().connected ? 'web' : 'meta')).toLowerCase();
  const cfg = await getEffectiveConfig(req);

  if (engine === 'web') {
    const wStatus = whatsappWeb.getWhatsAppWebStatus();
    if (!wStatus.connected) {
      res.write(`data: ${JSON.stringify({
        type: 'error',
        text: '[Connection Error] Free WhatsApp Web is not connected! Please scan the QR code on the dashboard to link your phone.'
      })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'finish', exitCode: 1 })}\n\n`);
      return res.end();
    }
  } else {
    if (!cfg.token || !cfg.phoneNumberId) {
      res.write(`data: ${JSON.stringify({
        type: 'error',
        text: '[Configuration Error] Meta WhatsApp Cloud API credentials missing! Please configure Phone Number ID and Permanent Access Token in Settings.'
      })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'finish', exitCode: 1 })}\n\n`);
      return res.end();
    }
  }

  const sid = getSessionId(req);
  let job = getCampaignJob(sid);

  // If no job is currently running or paused, launch one from the uploaded Excel file
  if (!job || ['completed', 'cancelled', 'failed'].includes(job.status)) {
    const sDir = getSessionDir(req);
    const exPath = findSessionExcel(req);
    if (!exPath || !fs.existsSync(exPath)) {
      res.write(`data: ${JSON.stringify({
        type: 'error',
        text: '[Excel Error] No recipients.xlsx file found. Please upload your Excel list before launching.'
      })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'finish', exitCode: 1 })}\n\n`);
      return res.end();
    }

    const optOutSet = new Set();
    try {
      const optList = await db.getOptOutList();
      for (const o of optList) {
        if (o.phone) optOutSet.add(o.phone);
      }
    } catch (e) {}

    const parsed = parseRecipientsExcel(exPath, optOutSet);
    if (!parsed.valid || parsed.preview.length === 0) {
      res.write(`data: ${JSON.stringify({
        type: 'error',
        text: '[Excel Error] No valid recipients found in the uploaded spreadsheet.'
      })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'finish', exitCode: 1 })}\n\n`);
      return res.end();
    }

    const msgPath = path.join(sDir, 'message.txt');
    let templateText = 'Hello {{name}},\nThank you for choosing our service!';
    if (fs.existsSync(msgPath)) {
      templateText = fs.readFileSync(msgPath, 'utf8');
    }

    const mediaPath = findSessionMedia(sDir);
    let mediaId = null;
    let mediaType = 'image';
    let mediaFilename = 'attachment.pdf';
    if (mediaPath) {
      if (engine === 'meta') {
        try {
          const up = await metaApi.uploadMedia(cfg.token, cfg.phoneNumberId, mediaPath);
          mediaId = up.mediaId;
          mediaType = up.type;
          mediaFilename = up.filename;
        } catch (e) {}
      } else {
        mediaFilename = path.basename(mediaPath);
        if (mediaFilename.endsWith('.pdf')) mediaType = 'document';
        else if (mediaFilename.endsWith('.mp4')) mediaType = 'video';
      }
    }

    const campaignId = 'camp_' + Date.now();
    await db.createCampaign(campaignId, 'Bulk Campaign ' + new Date().toLocaleDateString(), parsed.valid).catch(() => {});

    job = launchBackgroundCampaignJob({
      sessionId: sid,
      campaignId,
      engine,
      mediaPath,
      recipients: parsed.preview,
      templateText,
      mediaId,
      mediaType,
      filename: mediaFilename,
      templateName: (req.query.template || cfg.templateName || '').trim() || null,
      templateLang: (req.query.templateLang || cfg.templateLang || 'en_US').trim(),
      delayMs: parseInt(req.query.delayMs) || (engine === 'web' ? 5000 : 1500),
      token: cfg.token,
      phoneNumberId: cfg.phoneNumberId,
      wabaId: cfg.wabaId
    });
  }

  // Send historical logs to newly connected client
  for (const l of job.logs) {
    res.write(`data: ${JSON.stringify({ type: 'log', text: l.text, logType: l.type })}\n\n`);
  }

  // Register client listener
  job.listeners.add(res);

  req.on('close', () => {
    job.listeners.delete(res);
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
            let errorDetails = null;
            let errorCode = null;
            if (status.errors && status.errors.length > 0) {
              const err0 = status.errors[0];
              errorCode = err0.code ? parseInt(err0.code) : null;
              const detail = err0.error_data?.details || err0.message || err0.title || 'Message delivery failed';
              errorDetails = errorCode ? `Error ${errorCode}: ${detail}` : detail;
              if (errorCode === 131042) {
                console.error(`[Meta Webhook] FATAL BILLING BLOCKER 131042: WhatsApp Business Account currency is not configured. Configure currency in Meta Business Manager: https://business.facebook.com/billing_hub/accounts/details/?business_id=1396896010170779&asset_id=1142185591806768&wizard_name=CHANGE_COUNTRY_CURRENCY&account_type=whatsapp-business-account`);
              }
            } else if (status.errors) {
              errorDetails = typeof status.errors === 'string' ? status.errors : JSON.stringify(status.errors);
            }

            console.log(`[Meta Webhook] Delivery: ${deliveryStatus} | Code: ${errorCode || 'N/A'} | Recipient: ${status.recipient_id} | MetaID: ${metaId}`);
            await db.updateMessageDeliveryStatus(metaId, deliveryStatus, errorDetails, errorCode).catch(() => {});
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

// API: Get Inbox Conversations (Persistent Store)
app.get('/api/inbox', async (req, res) => {
  try {
    const conversations = await db.getConversations();
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

// API: Send Reply to Contact via WhatsApp Web or Meta Cloud API
app.post('/api/inbox/reply', async (req, res) => {
  try {
    const { to, message, templateName, templateLang } = req.body;
    const engine = (req.body?.engine || (whatsappWeb.getWhatsAppWebStatus().connected && !req.body?.templateName ? 'web' : 'meta')).toLowerCase();
    const cfg = await getEffectiveConfig(req);

    if (engine === 'web' || (!cfg.token && whatsappWeb.getWhatsAppWebStatus().connected)) {
      const wStatus = whatsappWeb.getWhatsAppWebStatus();
      if (!wStatus.connected) {
        return res.status(400).json({ success: false, error: 'WhatsApp Web is not connected. Please scan the QR code to link your phone.' });
      }
      if (!to || !message || !message.trim()) {
        return res.status(400).json({ success: false, error: 'Recipient phone number and reply message are required.' });
      }
      const cleanPhone = metaApi.cleanPhoneNumber(to);
      const webRes = await whatsappWeb.sendWhatsAppWebMessage({
        to: cleanPhone,
        text: message.trim()
      });
      if (webRes.success) {
        await db.saveOutgoingReply({
          phone: cleanPhone,
          text: message.trim(),
          metaMessageId: webRes.messageId,
          targetPhoneId: 'whatsapp_web',
          status: 'sent'
        }).catch(() => {});
        return res.json({ success: true, messageId: webRes.messageId, mode: 'whatsapp_web' });
      } else {
        return res.status(500).json({ success: false, error: webRes.error, mode: 'whatsapp_web' });
      }
    }

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

    // Check if recipient is within active 24-hr customer care window
    const convs = await db.getConversations();
    const conv = convs.find(c => c.phone === cleanPhone);
    const isWindowActive = conv ? conv.is_window_active : false;

    // Resolve template: explicit template, or direct message if requested
    let effectiveTemplate = null;
    if (templateName && String(templateName).trim() && templateName !== '__direct__') {
      effectiveTemplate = String(templateName).trim();
    } else if (!isWindowActive && cfg.templateName) {
      effectiveTemplate = cfg.templateName;
    }

    // Strict Meta 24-hour Policy Enforcement:
    if (!isWindowActive && !effectiveTemplate) {
      return res.status(400).json({
        success: false,
        code: 131047,
        error: "Customer's 24-hour service window is closed (Error 131047).",
        explanation: "Meta policy requires an APPROVED Message Template to reply to a customer outside the 24-hr window. Please select an approved template from the template dropdown above the chat box."
      });
    }

    if (effectiveTemplate && effectiveTemplate.toLowerCase() === 'hello_world') {
      return res.status(400).json({
        success: false,
        code: 131058,
        error: "Meta API Error (131058): 'hello_world' templates can only be sent from Public Test Numbers.",
        explanation: "Your registered number is a live production number. Please use an approved template created in Meta WhatsApp Manager."
      });
    }

    // Determine template language and resolve template details from WABA
    let chosenLang = templateLang || cfg.templateLang || 'en_US';
    let varCount = null;

    let hasMediaHdr = false;
    if (effectiveTemplate && cfg.wabaId) {
      try {
        const val = await metaApi.validateTemplate({
          token: cfg.token,
          wabaId: cfg.wabaId,
          templateName: effectiveTemplate,
          templateLang: chosenLang
        });
        if (val.valid && val.template) {
          if (val.template.language) chosenLang = val.template.language;
          if (typeof val.template.variableCount === 'number') varCount = val.template.variableCount;
          if (typeof val.template.hasMediaHeader === 'boolean') hasMediaHdr = val.template.hasMediaHeader;
        }
      } catch (e) {}
    }

    // Attempt sending message via Meta Cloud API
    let result = await metaApi.sendMessage({
      token: cfg.token,
      phoneNumberId: cfg.phoneNumberId,
      to: cleanPhone,
      text: message.trim(),
      templateName: effectiveTemplate,
      templateLang: chosenLang,
      recipientName: conv?.contact_name || '',
      variableCount: varCount,
      hasMediaHeader: hasMediaHdr
    });

    // Language mismatch auto-retry: if 132001 (template not found for language), try alternate en/en_US
    if (!result.success && result.code === 132001 && effectiveTemplate) {
      const altLang = (chosenLang === 'en_US' || chosenLang === 'en-US') ? 'en' : (chosenLang === 'en' ? 'en_US' : null);
      if (altLang) {
        console.log(`[Inbox Reply] Retrying template '${effectiveTemplate}' with alternate language '${altLang}'...`);
        const retryResult = await metaApi.sendMessage({
          token: cfg.token,
          phoneNumberId: cfg.phoneNumberId,
          to: cleanPhone,
          text: message.trim(),
          templateName: effectiveTemplate,
          templateLang: altLang,
          recipientName: conv?.contact_name || '',
          variableCount: varCount,
          hasMediaHeader: hasMediaHdr
        });
        if (retryResult.success) {
          result = retryResult;
        }
      }
    }

    // Auto-recovery from Meta 131047 (24h window closed):
    // If a direct message failed with 131047 because customer's window expired on Meta,
    // automatically attempt to send using the configured template or any approved WABA template!
    if (!result.success && result.code === 131047 && !effectiveTemplate) {
      let fallbackTemplate = cfg.templateName;
      if (!fallbackTemplate && cfg.wabaId) {
        try {
          const tplsRes = await metaApi.fetchApprovedTemplates(cfg.token, cfg.wabaId);
          if (tplsRes.success && tplsRes.templates && tplsRes.templates.length > 0) {
            fallbackTemplate = tplsRes.templates[0].name;
            console.log(`[Inbox Reply] Auto-recovering from 131047 with approved WABA template: '${fallbackTemplate}'`);
          }
        } catch (e) {}
      }

      if (fallbackTemplate) {
        console.log(`[Inbox Reply] 24-hr window closed on Meta. Auto-retrying via template '${fallbackTemplate}'...`);
        const tplRetry = await metaApi.sendMessage({
          token: cfg.token,
          phoneNumberId: cfg.phoneNumberId,
          to: cleanPhone,
          text: message.trim(),
          templateName: fallbackTemplate,
          templateLang: chosenLang,
          recipientName: conv?.contact_name || ''
        });
        if (tplRetry.success) {
          result = tplRetry;
          effectiveTemplate = fallbackTemplate;
        }
      }
    }

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
        usedTemplate: effectiveTemplate,
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
        details: result.details,
        billingBlocked: result.billingBlocked || false,
        billingUrl: result.billingUrl || null
      });
    }
  } catch (e) {
    console.error('[Inbox Reply Error]:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// API: Sync or Activate 24-hr Customer Care Window manually when customer replies on WhatsApp
app.post('/api/inbox/open-window', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: 'Phone number required' });
    const cleanPhone = metaApi.cleanPhoneNumber(phone);
    const result = await db.openCustomerWindow(cleanPhone);
    res.json(result);
  } catch (e) {
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
        totalAccepted: totalSent + totalDelivered + totalRead,
        totalPendingDelivery: totalSent,
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
