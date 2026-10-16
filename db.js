/**
 * SQLite Database Module for WhatsApp Campaign Engine
 * Persistent storage for Settings, Sessions, Conversations, Messages, Contacts, and Campaign Logs.
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// Ensure data directory exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = process.env.DATABASE_PATH || path.join(dataDir, 'whatsapp.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('[Database Error] Failed to connect to SQLite:', err.message);
  } else {
    console.log('[Database] Connected to persistent SQLite database at:', dbPath);
  }
});

// Enable WAL mode for high concurrency
db.run('PRAGMA journal_mode = WAL;');
db.run('PRAGMA foreign_keys = ON;');

// Helper to run SQL with Promises
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

// Initialize Tables
async function initDb() {
  // 1. Settings Table
  await run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 2. Sessions Table (User Authentication & Session Isolation)
  await run(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      token TEXT,
      phone_number_id TEXT,
      waba_id TEXT,
      template_name TEXT DEFAULT 'campaign_update',
      template_lang TEXT DEFAULT 'en_US',
      verified_name TEXT,
      display_phone TEXT,
      quality_rating TEXT,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_active DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 3. Contacts Table (Verified consent, Opt-Out suppression)
  await run(`
    CREATE TABLE IF NOT EXISTS contacts (
      phone TEXT PRIMARY KEY,
      name TEXT,
      country_code TEXT DEFAULT '91',
      has_consent INTEGER DEFAULT 1,
      is_opted_out INTEGER DEFAULT 0,
      opt_out_reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 4. Conversations Table (Two-way WhatsApp Inbox)
  await run(`
    CREATE TABLE IF NOT EXISTS conversations (
      phone TEXT PRIMARY KEY,
      contact_name TEXT,
      last_message TEXT,
      last_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      unread_count INTEGER DEFAULT 0,
      window_expires_at DATETIME,
      target_phone_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 5. Messages Table (Permanent chat history with delivery statuses)
  await run(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      phone TEXT,
      direction TEXT,
      sender_name TEXT,
      type TEXT DEFAULT 'text',
      body TEXT,
      media_url TEXT,
      media_id TEXT,
      status TEXT DEFAULT 'pending',
      error_message TEXT,
      meta_message_id TEXT,
      target_phone_id TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (phone) REFERENCES conversations(phone) ON DELETE CASCADE
    );
  `);

  // 6. Campaigns Table
  await run(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      name TEXT,
      total_recipients INTEGER DEFAULT 0,
      sent_count INTEGER DEFAULT 0,
      delivered_count INTEGER DEFAULT 0,
      read_count INTEGER DEFAULT 0,
      failed_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    );
  `);

  // 7. Campaign Logs (Individual recipient delivery tracking)
  await run(`
    CREATE TABLE IF NOT EXISTS campaign_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id TEXT,
      phone TEXT,
      name TEXT,
      status TEXT DEFAULT 'pending',
      meta_id TEXT,
      error_code TEXT,
      error_details TEXT,
      sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    );
  `);

  // Indexes for fast lookup
  await run(`CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_messages_meta_id ON messages(meta_message_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_campaign_logs_cid ON campaign_logs(campaign_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_conversations_timestamp ON conversations(last_timestamp DESC);`);

  console.log('[Database] All SQLite tables and indexes initialized successfully.');
}

// ─── SETTINGS / CONFIG METHODS ───
async function getSetting(key, fallback = null) {
  const row = await get('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : fallback;
}

async function setSetting(key, value) {
  return run(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP;
  `, [key, typeof value === 'object' ? JSON.stringify(value) : String(value)]);
}

// ─── SESSION METHODS (User Isolation & Authentication) ───
async function getSession(sessionId) {
  if (!sessionId) return null;
  const row = await get('SELECT * FROM sessions WHERE session_id = ?', [sessionId]);
  if (!row) return null;
  // Update last_active
  run('UPDATE sessions SET last_active = CURRENT_TIMESTAMP WHERE session_id = ?', [sessionId]).catch(() => {});
  return row;
}

async function saveSession(sessionId, data) {
  const current = (await getSession(sessionId)) || {};
  const merged = { ...current, ...data };
  return run(`
    INSERT INTO sessions (
      session_id, token, phone_number_id, waba_id, template_name, template_lang, verified_name, display_phone, quality_rating, status, last_active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(session_id) DO UPDATE SET
      token = excluded.token,
      phone_number_id = excluded.phone_number_id,
      waba_id = excluded.waba_id,
      template_name = excluded.template_name,
      template_lang = excluded.template_lang,
      verified_name = excluded.verified_name,
      display_phone = excluded.display_phone,
      quality_rating = excluded.quality_rating,
      status = excluded.status,
      last_active = CURRENT_TIMESTAMP;
  `, [
    sessionId,
    merged.token || null,
    merged.phone_number_id || null,
    merged.waba_id || null,
    merged.template_name || 'campaign_update',
    merged.template_lang || 'en_US',
    merged.verified_name || null,
    merged.display_phone || null,
    merged.quality_rating || 'GREEN',
    merged.status || 'active'
  ]);
}

async function deleteSession(sessionId) {
  return run('DELETE FROM sessions WHERE session_id = ?', [sessionId]);
}

// ─── CONTACTS & OPTOUT METHODS ───
async function isOptedOut(phone) {
  const clean = String(phone).replace(/\D/g, '');
  const row = await get('SELECT is_opted_out FROM contacts WHERE phone = ?', [clean]);
  return !!(row && row.is_opted_out);
}

async function setOptOut(phone, isOptOut = 1, reason = 'User requested STOP') {
  const clean = String(phone).replace(/\D/g, '');
  return run(`
    INSERT INTO contacts (phone, is_opted_out, opt_out_reason, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(phone) DO UPDATE SET
      is_opted_out = excluded.is_opted_out,
      opt_out_reason = excluded.opt_out_reason,
      updated_at = CURRENT_TIMESTAMP;
  `, [clean, isOptOut ? 1 : 0, reason]);
}

async function getOptOutList() {
  return all('SELECT phone, opt_out_reason, updated_at FROM contacts WHERE is_opted_out = 1 ORDER BY updated_at DESC');
}

// ─── INBOX & CONVERSATION METHODS ───
async function getConversations(targetPhoneId = null) {
  let query = 'SELECT * FROM conversations';
  const params = [];
  if (targetPhoneId) {
    query += ' WHERE target_phone_id = ? OR target_phone_id IS NULL';
    params.push(targetPhoneId);
  }
  query += ' ORDER BY last_timestamp DESC';
  const rows = await all(query, params);

  const now = new Date();
  return rows.map(conv => {
    const expiresAt = conv.window_expires_at ? new Date(conv.window_expires_at) : null;
    const isWindowActive = expiresAt && expiresAt > now;
    const remainingMs = isWindowActive ? expiresAt.getTime() - now.getTime() : 0;
    const remainingHours = Math.floor(remainingMs / (1000 * 60 * 60));
    const remainingMins = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));

    return {
      ...conv,
      is_window_active: isWindowActive,
      window_time_left: isWindowActive ? `${remainingHours}h ${remainingMins}m` : 'Expired'
    };
  });
}

async function getMessagesForContact(phone) {
  const clean = String(phone).replace(/\D/g, '');
  return all('SELECT * FROM messages WHERE phone = ? ORDER BY timestamp ASC', [clean]);
}

async function saveIncomingMessage({ id, phone, name, text, type = 'text', mediaUrl = null, mediaId = null, targetPhoneId = null, timestamp = null }) {
  const cleanPhone = String(phone).replace(/\D/g, '');
  const msgTime = timestamp ? new Date(timestamp).toISOString() : new Date().toISOString();
  const windowExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24hr customer service window

  // 1. Upsert Conversation
  await run(`
    INSERT INTO conversations (phone, contact_name, last_message, last_timestamp, unread_count, window_expires_at, target_phone_id)
    VALUES (?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET
      contact_name = COALESCE(excluded.contact_name, contact_name),
      last_message = excluded.last_message,
      last_timestamp = excluded.last_timestamp,
      unread_count = unread_count + 1,
      window_expires_at = excluded.window_expires_at,
      target_phone_id = COALESCE(excluded.target_phone_id, target_phone_id);
  `, [cleanPhone, name || null, text, msgTime, windowExpiry, targetPhoneId]);

  // 2. Insert Message
  const msgId = id || 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
  await run(`
    INSERT OR REPLACE INTO messages (id, phone, direction, sender_name, type, body, media_url, media_id, status, target_phone_id, timestamp)
    VALUES (?, ?, 'incoming', ?, ?, ?, ?, ?, 'received', ?, ?);
  `, [msgId, cleanPhone, name || 'Customer', type, text, mediaUrl, mediaId, targetPhoneId, msgTime]);

  return { id: msgId, phone: cleanPhone, text, timestamp: msgTime };
}

async function saveOutgoingReply({ id, phone, text, type = 'text', mediaUrl = null, mediaId = null, metaMessageId = null, targetPhoneId = null, status = 'sent', errorMessage = null }) {
  const cleanPhone = String(phone).replace(/\D/g, '');
  const now = new Date().toISOString();
  const msgId = id || 'reply_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);

  // 1. Upsert Conversation
  await run(`
    INSERT INTO conversations (phone, last_message, last_timestamp, target_phone_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET
      last_message = excluded.last_message,
      last_timestamp = excluded.last_timestamp,
      target_phone_id = COALESCE(excluded.target_phone_id, target_phone_id);
  `, [cleanPhone, text, now, targetPhoneId]);

  // 2. Insert Outgoing Message
  await run(`
    INSERT OR REPLACE INTO messages (id, phone, direction, sender_name, type, body, media_url, media_id, status, error_message, meta_message_id, target_phone_id, timestamp)
    VALUES (?, ?, 'outgoing', 'You', ?, ?, ?, ?, ?, ?, ?, ?, ?);
  `, [msgId, cleanPhone, type, text, mediaUrl, mediaId, status, errorMessage, metaMessageId, targetPhoneId, now]);

  return { id: msgId, metaMessageId, status };
}

async function updateMessageDeliveryStatus(metaMessageId, status, errorDetails = null) {
  if (!metaMessageId) return;
  // Update in messages table
  await run(`
    UPDATE messages
    SET status = ?, error_message = COALESCE(?, error_message)
    WHERE meta_message_id = ?;
  `, [status, errorDetails, metaMessageId]);

  // Update in campaign logs if applicable
  await run(`
    UPDATE campaign_logs
    SET status = ?, error_details = COALESCE(?, error_details)
    WHERE meta_id = ?;
  `, [status, errorDetails, metaMessageId]);
}

async function markConversationRead(phone) {
  const clean = String(phone).replace(/\D/g, '');
  return run('UPDATE conversations SET unread_count = 0 WHERE phone = ?', [clean]);
}

// ─── CAMPAIGN & REPORTING METHODS ───
async function createCampaign(id, name, totalRecipients) {
  return run(`
    INSERT INTO campaigns (id, name, total_recipients, status, created_at)
    VALUES (?, ?, ?, 'running', CURRENT_TIMESTAMP);
  `, [id, name, totalRecipients]);
}

async function logCampaignRecipient(campaignId, phone, name, status, metaId = null, errorCode = null, errorDetails = null) {
  return run(`
    INSERT INTO campaign_logs (campaign_id, phone, name, status, meta_id, error_code, error_details, sent_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP);
  `, [campaignId, phone, name, status, metaId, errorCode, errorDetails]);
}

async function updateCampaignStats(campaignId, sent, failed, status = null) {
  return run(`
    UPDATE campaigns
    SET sent_count = ?, failed_count = ?, status = COALESCE(?, status),
        completed_at = CASE WHEN ? IN ('completed', 'failed') THEN CURRENT_TIMESTAMP ELSE completed_at END
    WHERE id = ?;
  `, [sent, failed, status, status, campaignId]);
}

async function getCampaignSummary(campaignId) {
  const campaign = await get('SELECT * FROM campaigns WHERE id = ?', [campaignId]);
  const logs = await all('SELECT * FROM campaign_logs WHERE campaign_id = ? ORDER BY id ASC', [campaignId]);
  return { campaign, logs };
}

async function getRecentCampaignLogs(limit = 100) {
  return all(`
    SELECT cl.*, c.name as campaign_name
    FROM campaign_logs cl
    LEFT JOIN campaigns c ON cl.campaign_id = c.id
    ORDER BY cl.sent_at DESC
    LIMIT ?;
  `, [limit]);
}

// Initialize on module load
initDb().catch(err => console.error('[Database Init Error]:', err));

module.exports = {
  db,
  run,
  get,
  all,
  getSetting,
  setSetting,
  getSession,
  saveSession,
  deleteSession,
  isOptedOut,
  setOptOut,
  getOptOutList,
  getConversations,
  getMessagesForContact,
  saveIncomingMessage,
  saveOutgoingReply,
  updateMessageDeliveryStatus,
  markConversationRead,
  createCampaign,
  logCampaignRecipient,
  updateCampaignStats,
  getCampaignSummary,
  getRecentCampaignLogs
};
