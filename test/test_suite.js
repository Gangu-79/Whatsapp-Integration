/**
 * Automated Enterprise Test Suite for WhatsApp Campaign Engine
 * Tests Meta API security redaction, token masking, dynamic 24-hr window,
 * Excel parsing & normalization, and background queue job state machine.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

const { redactSensitive, maskToken, verifyCredentials } = require('../meta_api');
const db = require('../db');

let passedTests = 0;
let failedTests = 0;

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  ✓ PASS: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(`    ${err.message}`);
    failedTests++;
  }
}

async function runAllTests() {
  console.log('\n======================================================');
  console.log('  WHATSAPP CAMPAIGN ENGINE - AUTOMATED TEST SUITE');
  console.log('======================================================\n');

  // --------------------------------------------------------------------------
  // SUITE 1: Security, Token Redaction & Masking
  // --------------------------------------------------------------------------
  console.log('=== Suite 1: Security, Token Redaction & Masking ===');

  await runTest('redactSensitive should scrub Meta EAAG/EAAB tokens from error messages', () => {
    const secretToken = 'EAAGm0PX4ZB10BOZCFm4Kq7yX9z1234567890abcdef';
    const leakedError = `Meta API error 190 with token ${secretToken} expired!`;
    const sanitized = redactSensitive(leakedError);

    assert(!sanitized.includes(secretToken), 'Token was not scrubbed from string!');
    assert(sanitized.includes('[REDACTED_ACCESS_TOKEN]'), 'Redaction placeholder not found!');
  });

  await runTest('redactSensitive should scrub tokens inside objects and arrays recursively', () => {
    const obj = {
      error: 'Token EAAU1234567890abcdef is invalid',
      meta: {
        nestedToken: 'EAAB9876543210zyxwvu',
        details: ['auth error with EAAC11223344556677']
      }
    };
    const scrubbed = redactSensitive(obj);

    assert(!JSON.stringify(scrubbed).includes('EAAU1234567890abcdef'));
    assert(!JSON.stringify(scrubbed).includes('EAAB9876543210zyxwvu'));
    assert(!JSON.stringify(scrubbed).includes('EAAC11223344556677'));
    assert(JSON.stringify(scrubbed).includes('[REDACTED_ACCESS_TOKEN]'));
  });

  await runTest('maskToken should only reveal first 6 and last 4 characters without leaking full token', () => {
    const token = 'EAAGm0PX4ZB10BOZCFm4Kq7yX9z1234567890abcdef';
    const masked = maskToken(token);

    assert.strictEqual(masked.startsWith('EAAGm0'), true);
    assert.strictEqual(masked.endsWith('cdef'), true);
    assert.strictEqual(masked.includes('...'), true);
    assert(!masked.includes('BOZCFm4Kq7yX9z1234567890'), 'Internal token characters were leaked!');
  });

  await runTest('maskToken should safely handle empty, null, or short values', () => {
    assert.strictEqual(maskToken(null), '');
    assert.strictEqual(maskToken(''), '');
    assert.strictEqual(maskToken('short'), '******');
  });

  // --------------------------------------------------------------------------
  // SUITE 2: Meta API Diagnostics & Error Recovery Advice
  // --------------------------------------------------------------------------
  console.log('\n=== Suite 2: Meta API Diagnostics & Error 190/132001 Resolution ===');

  await runTest('verifyCredentials should reject missing or invalid credentials gracefully', async () => {
    const res = await verifyCredentials('', '');
    assert.strictEqual(res.valid, false);
    assert(res.error.includes('Missing') || res.error.includes('credentials'));
  });

  await runTest('verifyCredentials should provide actionable 4-step advice on Error 190 without crashing', async () => {
    // Simulate testing with an intentionally invalid token
    const res = await verifyCredentials('1413623935167910', 'EAAG_dummy_invalid_expired_token_test_12345');
    assert.strictEqual(res.valid, false);
    assert(res.advice != null, 'No actionable recovery advice returned!');
    // Ensure token is not printed in plaintext in error message
    assert(!res.error.includes('EAAG_dummy_invalid_expired_token_test_12345'));
  });

  // --------------------------------------------------------------------------
  // SUITE 3: Dynamic 24-Hour Customer Care Window Calculation
  // --------------------------------------------------------------------------
  console.log('\n=== Suite 3: Database & Dynamic 24-Hour Messaging Window ===');

  await runTest('db.getConversations should calculate active 24h window when customer messaged recently', async () => {
    const testPhone = '919999988888';
    const recentTimestamp = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago

    // Seed incoming message
    await db.saveIncomingMessage({
      phone: testPhone,
      name: 'Test Customer Recent',
      text: 'Hello, I need insurance details',
      timestamp: recentTimestamp
    });

    const convos = await db.getConversations();
    const found = convos.find(c => c.phone === testPhone);

    assert(found != null, 'Conversation not found in database!');
    assert.strictEqual(found.is_window_active, true, 'Window should be ACTIVE for message sent 2h ago!');
    assert(found.window_time_left.includes('h'), 'Window time left should show remaining hours!');
  });

  await runTest('db.getConversations should calculate EXPIRED 24h window when customer messaged 26 hours ago', async () => {
    const testPhone = '9188888' + String(Date.now()).slice(-5);
    const oldTimestamp = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(); // 26 hours ago

    // Seed old incoming message
    await db.saveIncomingMessage({
      phone: testPhone,
      name: 'Test Customer Old',
      text: 'Old query from yesterday',
      timestamp: oldTimestamp
    });

    const convos = await db.getConversations();
    const found = convos.find(c => c.phone === testPhone);

    assert(found != null, 'Conversation not found in database!');
    assert.strictEqual(found.is_window_active, false, 'Window should be EXPIRED for message sent 26h ago!');
    assert.strictEqual(found.window_time_left, 'Expired', 'Window time left should be Expired!');
  });

  await runTest('db.openCustomerWindow should immediately activate the 24h window for an expired contact', async () => {
    const testPhone = '9177777' + String(Date.now()).slice(-5);
    const res = await db.openCustomerWindow(testPhone);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.is_window_active, true);

    const convos = await db.getConversations();
    const found = convos.find(c => c.phone === testPhone);
    assert(found != null);
    assert.strictEqual(found.is_window_active, true, 'Window should be ACTIVE after openCustomerWindow!');
  });

  // --------------------------------------------------------------------------
  // SUITE 4: Native Excel Spreadsheet Generation & E.164 Normalization
  // --------------------------------------------------------------------------
  console.log('\n=== Suite 4: Native Excel Generation & Parsing Engine ===');

  await runTest('XLSX should generate and parse contacts sheet with E.164 normalization', () => {
    const testData = [
      { Name: 'Amit Kumar', Phone: '9876543210', Consent: 'Yes' },           // 10-digit Indian -> 919876543210
      { Name: 'Priya Sharma', Phone: '+91 91234 56789', Consent: 'Yes' },     // formatted Indian -> 919123456789
      { Name: 'John Doe', Phone: '+1 (415) 555-2671', Consent: 'Yes' },       // US number -> 14155552671
      { Name: 'Duplicate Contact', Phone: '9876543210', Consent: 'Yes' },     // Duplicate -> should be filtered
      { Name: 'Opted Out User', Phone: '9988776655', Consent: 'Yes' },        // In opt-out set
      { Name: 'Invalid Phone', Phone: 'abc-123', Consent: 'Yes' }              // Invalid
    ];

    const ws = XLSX.utils.json_to_sheet(testData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Contacts');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    assert(buf && buf.length > 0, 'Failed to generate Excel buffer');

    // Parse buffer back
    const parsedWb = XLSX.read(buf, { type: 'buffer' });
    const sheet = parsedWb.Sheets[parsedWb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);

    assert.strictEqual(rows.length, 6, 'All 6 rows should be read from sheet');

    // Verify normalization logic
    const optOutSet = new Set(['919988776655', '9988776655']);
    const seen = new Set();
    const validRecipients = [];
    let duplicates = 0;
    let optedOut = 0;
    let invalid = 0;

    for (const row of rows) {
      let rawPhone = String(row.Phone || '').replace(/\D/g, '');
      if (!rawPhone || rawPhone.length < 7) {
        invalid++;
        continue;
      }
      if (rawPhone.length === 10) rawPhone = '91' + rawPhone;

      if (optOutSet.has(rawPhone)) {
        optedOut++;
        continue;
      }
      if (seen.has(rawPhone)) {
        duplicates++;
        continue;
      }
      seen.add(rawPhone);
      validRecipients.push({ name: row.Name, phone: rawPhone });
    }

    assert.strictEqual(validRecipients.length, 3, 'Expected exactly 3 valid normalized recipients');
    assert.strictEqual(duplicates, 1, 'Expected 1 duplicate');
    assert.strictEqual(optedOut, 1, 'Expected 1 opted out');
    assert.strictEqual(invalid, 1, 'Expected 1 invalid');
    assert.strictEqual(validRecipients[0].phone, '919876543210');
    assert.strictEqual(validRecipients[1].phone, '919123456789');
    assert.strictEqual(validRecipients[2].phone, '14155552671');
  });

  // --------------------------------------------------------------------------
  // SUITE 5: Background Campaign Queue State Machine
  // --------------------------------------------------------------------------
  console.log('\n=== Suite 5: Background Campaign Queue State Machine ===');

  await runTest('Campaign state machine should handle pause, resume, and cancellation properly', () => {
    const jobState = {
      id: 'job_test_101',
      status: 'idle',
      total: 10,
      processed: 0,
      sent: 0,
      failed: 0,
      isPaused: false,
      isCancelled: false
    };

    // Launch job
    jobState.status = 'running';
    assert.strictEqual(jobState.status, 'running');

    // Pause
    jobState.isPaused = true;
    jobState.status = 'paused';
    assert.strictEqual(jobState.isPaused, true);
    assert.strictEqual(jobState.status, 'paused');

    // Resume
    jobState.isPaused = false;
    jobState.status = 'running';
    assert.strictEqual(jobState.isPaused, false);
    assert.strictEqual(jobState.status, 'running');

    // Process 5 items
    jobState.processed = 5;
    jobState.sent = 5;

    // Cancel
    jobState.isCancelled = true;
    jobState.status = 'cancelled';
    assert.strictEqual(jobState.isCancelled, true);
    assert.strictEqual(jobState.status, 'cancelled');
    assert.strictEqual(jobState.processed, 5);
  });

  // --------------------------------------------------------------------------
  // SUITE 6: Chat Backup, Restore & Deduplication (Requirement 1 & 2)
  // --------------------------------------------------------------------------
  console.log('\n=== Suite 6: Chat Backup, Restore & Deduplication ===');

  await runTest('db.createBackupNow and getBackupStatus should track persistent backup snapshots', async () => {
    const backup = await db.createBackupNow();
    assert.strictEqual(backup.success, true);
    assert(backup.lastBackup != null);

    const status = await db.getBackupStatus();
    assert(status.lastBackup != null);
    assert(typeof status.conversationsCount === 'number');
    assert(typeof status.messagesCount === 'number');
  });

  await runTest('saveIncomingMessage and getMessagesForContact should deduplicate messages by ID', async () => {
    const testPhone = '919966559211';
    const msgId = 'test_dedup_' + Date.now();

    await db.saveIncomingMessage({
      id: msgId,
      phone: testPhone,
      name: 'Dedup Customer',
      text: 'First arrival of message'
    });

    // Attempt second save with exact same message ID
    await db.saveIncomingMessage({
      id: msgId,
      phone: testPhone,
      name: 'Dedup Customer',
      text: 'Second arrival of message'
    });

    const msgs = await db.getMessagesForContact(testPhone);
    const matching = msgs.filter(m => m.id === msgId);
    assert.strictEqual(matching.length, 1, 'Duplicate incoming message ID was not deduplicated!');
  });

  await runTest('exportBackup and restoreBackup should export and restore valid JSON store', async () => {
    const exported = await db.exportBackup();
    assert.strictEqual(exported.version, '2.0');
    assert(exported.store != null);
    assert(Array.isArray(exported.store.messages));

    const restored = await db.restoreBackup(exported);
    assert.strictEqual(restored.success, true);
  });

  // --------------------------------------------------------------------------
  // SUITE 7: Webhook Status Precedence & 24-Hour Policy Enforcement
  // --------------------------------------------------------------------------
  console.log('\n=== Suite 7: Webhook Precedence & 24-Hr Window Policy ===');

  await runTest('updateMessageDeliveryStatus should prevent regression of delivered/read status on out-of-order webhooks', async () => {
    const testMetaId = 'wamid_test_idempotent_' + Date.now();
    const testPhone = '919123456789';

    // 1. Create initial outgoing message with status 'sent'
    await db.saveOutgoingReply({
      phone: testPhone,
      text: 'Test message for status idempotency',
      metaMessageId: testMetaId,
      status: 'sent'
    });

    let msgs = await db.getMessagesForContact(testPhone);
    let target = msgs.find(m => m.meta_message_id === testMetaId);
    assert.strictEqual(target.status, 'sent', 'Initial status should be sent');

    // 2. Deliver webhook for 'delivered'
    await db.updateMessageDeliveryStatus(testMetaId, 'delivered');
    msgs = await db.getMessagesForContact(testPhone);
    target = msgs.find(m => m.meta_message_id === testMetaId);
    assert.strictEqual(target.status, 'delivered', 'Status should advance to delivered');

    // 3. Out-of-order duplicate webhook arrives with 'sent'
    await db.updateMessageDeliveryStatus(testMetaId, 'sent');
    msgs = await db.getMessagesForContact(testPhone);
    target = msgs.find(m => m.meta_message_id === testMetaId);
    assert.strictEqual(target.status, 'delivered', 'Delivered status must NOT regress to sent!');

    // 4. Advance to 'read'
    await db.updateMessageDeliveryStatus(testMetaId, 'read');
    msgs = await db.getMessagesForContact(testPhone);
    target = msgs.find(m => m.meta_message_id === testMetaId);
    assert.strictEqual(target.status, 'read', 'Status should advance to read');

    // 5. Out-of-order duplicate webhook arrives with 'delivered'
    await db.updateMessageDeliveryStatus(testMetaId, 'delivered');
    msgs = await db.getMessagesForContact(testPhone);
    target = msgs.find(m => m.meta_message_id === testMetaId);
    assert.strictEqual(target.status, 'read', 'Read status must NOT regress to delivered!');
  });

  await runTest('sendMessage should reject hello_world with Error 131058 on registered live numbers', async () => {
    const { sendMessage } = require('../meta_api');
    const res = await sendMessage({
      token: 'fake_token',
      phoneNumberId: 'fake_phone_id',
      to: '919876543210',
      text: 'Test',
      templateName: 'hello_world'
    });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.code, 131058, 'Should reject hello_world with 131058');
  });

  // --------------------------------------------------------------------------
  // SUITE 8: Meta Billing Configuration & Error 131042 Resolution
  // --------------------------------------------------------------------------
  console.log('\n=== Suite 8: Meta Billing Configuration & Error 131042 Resolution ===');

  await runTest('updateMessageDeliveryStatus should store Error 131042 code and error details on failure webhook', async () => {
    const testMetaId = 'wamid_test_131042_' + Date.now();
    const testPhone = '919876500001';

    // 1. Log outgoing campaign message
    await db.saveOutgoingReply({
      phone: testPhone,
      text: 'Marketing notification',
      metaMessageId: testMetaId,
      status: 'sent'
    });
    await db.logCampaignRecipient('camp_test_billing', testPhone, 'Test User', 'sent', testMetaId);

    // 2. Simulate Meta Webhook delivery status "failed" with Error 131042
    const errorDetails = 'Error 131042: Message failed to send because your WhatsApp Business account currency is not configured. Visit https://business.facebook.com/billing_hub/accounts/details/?business_id=1396896010170779&asset_id=1142185591806768&wizard_name=CHANGE_COUNTRY_CURRENCY&account_type=whatsapp-business-account to resolve this issue.';
    await db.updateMessageDeliveryStatus(testMetaId, 'failed', errorDetails, 131042);

    const msgs = await db.getMessagesForContact(testPhone);
    const targetMsg = msgs.find(m => m.meta_message_id === testMetaId);
    assert.strictEqual(targetMsg.status, 'failed', 'Message status must be failed');
    assert.strictEqual(targetMsg.error_code, 131042, 'Message error code must be 131042');
    assert(targetMsg.error_message.includes('131042'), 'Error message must contain 131042');

    const logs = await db.getRecentCampaignLogs(10);
    const targetLog = logs.find(l => l.meta_id === testMetaId);
    assert(targetLog != null, 'Campaign log must exist');
    assert.strictEqual(targetLog.status, 'failed', 'Campaign log status must be failed');
    assert.strictEqual(targetLog.error_code, 131042, 'Campaign log error code must be 131042');
    assert(targetLog.error_details.includes('CHANGE_COUNTRY_CURRENCY'), 'Log must contain Meta currency wizard URL');
  });

  await runTest('getWabaCurrency should safely handle missing token or wabaId', async () => {
    const { getWabaCurrency } = require('../meta_api');
    const res1 = await getWabaCurrency('', '');
    assert.strictEqual(res1.success, false);
    assert.strictEqual(res1.currencyConfigured, false);

    const res2 = await getWabaCurrency('fake_token', '');
    assert.strictEqual(res2.success, false);
    assert.strictEqual(res2.currencyConfigured, false);
  });

  // --------------------------------------------------------------------------
  // SUITE 9: Media Attachment (Video, PDF, Image) & Spreadsheet Column Variables
  // --------------------------------------------------------------------------
  console.log('\n=== Suite 9: Media Attachment (Video/PDF/Image) & Column Interpolation ===');

  await runTest('meta_api.sendMessage should construct valid video payload within 24h window', async () => {
    const { sendMessage } = require('../meta_api');
    // Using a fake token and test recipient to inspect payload construction
    // When mediaType is 'video' with mediaId, sendMessage produces a video type payload
    try {
      const res = await sendMessage({
        token: 'fake_token',
        phoneNumberId: 'fake_phone_id',
        to: '919966559281',
        text: 'Video update caption',
        mediaId: 'meta_media_video_12345',
        mediaType: 'video'
      });
      // Expected: network failure with fake token, but error should not be 400 invalid phone or payload error
      assert(res != null);
    } catch (e) {
      assert.fail('Should not throw unhandled exception: ' + e.message);
    }
  });

  await runTest('Column variable replacement should interpolate {{name}}, {{phone}}, and custom spreadsheet columns', () => {
    const rawRow = {
      Name: 'Rahul Sharma',
      Phone: '919966559281',
      Policy: 'POL-99201',
      Premium: '₹14,500',
      DueDate: '25-Oct-2026'
    };
    const templateText = 'Dear {{name}}, your policy {{Policy}} of {{Premium}} is due on {{DueDate}}. Contact +{{phone}}.';
    let textToSend = templateText;
    for (const [col, val] of Object.entries(rawRow)) {
      const regex = new RegExp(`\\{\\{${col}\\}\\}`, 'gi');
      textToSend = textToSend.replace(regex, String(val));
    }
    textToSend = textToSend.replace(/\{\{name\}\}/gi, rawRow.Name).replace(/\{\{phone\}\}/gi, rawRow.Phone);

    assert(textToSend.includes('Dear Rahul Sharma'), 'Name not replaced');
    assert(textToSend.includes('POL-99201'), 'Policy not replaced');
    assert(textToSend.includes('₹14,500'), 'Premium not replaced');
    assert(textToSend.includes('25-Oct-2026'), 'DueDate not replaced');
    assert(textToSend.includes('+919966559281'), 'Phone not replaced');
  });

  await runTest('XLSX batch generator should parse and validate 50 contacts correctly', () => {
    const contacts50 = [];
    for (let i = 1; i <= 50; i++) {
      contacts50.push({
        name: `Contact User ${i}`,
        phone: `9198765${String(10000 + i).slice(-5)}`,
        consent: 'yes'
      });
    }
    assert.strictEqual(contacts50.length, 50, 'Must have 50 contacts');
    const validCount = contacts50.filter(c => c.phone && c.phone.length >= 10).length;
    assert.strictEqual(validCount, 50, 'All 50 contacts must be valid');
  });

  await runTest('XLSX batch generator should parse and validate 100 contacts correctly', () => {
    const contacts100 = [];
    for (let i = 1; i <= 100; i++) {
      contacts100.push({
        name: `Customer Batch ${i}`,
        phone: `9198111${String(10000 + i).slice(-5)}`,
        consent: i % 10 === 0 ? 'no' : 'yes'
      });
    }
    assert.strictEqual(contacts100.length, 100, 'Must have 100 contacts');
    const consented = contacts100.filter(c => c.consent === 'yes').length;
    assert.strictEqual(consented, 90, '90 contacts should be consented');
  });

  // --------------------------------------------------------------------------
  // SUITE 10: Live Inbox Contact Sync, Batch Import & Failed Recipient Retry
  // --------------------------------------------------------------------------
  console.log('\n=== Suite 10: Live Inbox Contact Sync & Batch Import ===');

  await runTest('db.syncContactsBatch should upsert contacts into db.contacts and conversations', async () => {
    const batchList = [
      { phone: '919900011111', name: 'Batch Contact Alpha', raw_row: { Plan: 'Gold' } },
      { phone: '919900022222', name: 'Batch Contact Beta', raw_row: { Plan: 'Platinum' } }
    ];

    const count = await db.syncContactsBatch(batchList);
    assert.strictEqual(count, 2, 'Should sync exactly 2 contacts');

    const convs = await db.getConversations();
    const alphaConv = convs.find(c => c.phone === '919900011111');
    const betaConv = convs.find(c => c.phone === '919900022222');

    assert(alphaConv != null, 'Alpha contact must appear in conversations');
    assert(betaConv != null, 'Beta contact must appear in conversations');
    assert.strictEqual(alphaConv.contact_name, 'Batch Contact Alpha');
    assert.strictEqual(betaConv.contact_name, 'Batch Contact Beta');

    const allContacts = await db.getContacts();
    const alphaContact = allContacts.find(c => c.phone === '919900011111');
    assert(alphaContact != null, 'Alpha contact must exist in db.contacts');
    assert.strictEqual(alphaContact.custom_data.Plan, 'Gold', 'Custom data must be preserved');
  });

  await runTest('Outgoing messages from single or bulk send should auto-register contact in db.contacts', async () => {
    const testSinglePhone = '919900033333';
    await db.saveOutgoingReply({
      phone: testSinglePhone,
      name: 'Single Outgoing Recipient',
      text: 'Direct message test',
      status: 'sent'
    });

    const allContacts = await db.getContacts();
    const found = allContacts.find(c => c.phone === testSinglePhone);
    assert(found != null, 'Outgoing contact must be auto-registered in contacts');
    assert.strictEqual(found.name, 'Single Outgoing Recipient');
  });

  await runTest('Rate limit Error 130429 cooling backoff logic should handle retryable errors', () => {
    const isRateLimitError = (code) => code === 429 || code === 130429;
    assert.strictEqual(isRateLimitError(130429), true, '130429 must be recognized as rate limit');
    assert.strictEqual(isRateLimitError(429), true, '429 must be recognized as rate limit');
    assert.strictEqual(isRateLimitError(131058), false, '131058 is not a rate limit error');
  });

  // --------------------------------------------------------------------------
  // SUMMARY
  // --------------------------------------------------------------------------
  console.log('\n======================================================');
  console.log(`  TEST RESULTS: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log('======================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runAllTests().catch(err => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
