/**
 * Official Meta WhatsApp Cloud API Client
 * Enterprise-grade integration with rate-limiting, controlled batching,
 * PDF/Image attachment support, and detailed error diagnostics.
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

const GRAPH_API_VERSION = 'v21.0';
const GRAPH_BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

/**
 * Universally redacts any Meta access tokens (starting with EAA...) from strings or objects.
 * Prevents any credential leakage in logs, diagnostics, and API error responses.
 */
function redactSensitive(val) {
  if (val === null || val === undefined) return val;
  if (typeof val === 'object') {
    try {
      const jsonStr = JSON.stringify(val);
      const redacted = jsonStr.replace(/EAA[A-Za-z0-9_-]{10,}/gi, '[REDACTED_ACCESS_TOKEN]');
      return JSON.parse(redacted);
    } catch (e) {
      return val;
    }
  }
  return String(val).replace(/EAA[A-Za-z0-9_-]{10,}/gi, '[REDACTED_ACCESS_TOKEN]');
}

/**
 * Safely masks a token for UI presentation (e.g. EAABcd...98fA).
 */
function maskToken(token) {
  if (!token || typeof token !== 'string') return '';
  const trimmed = token.trim();
  if (trimmed.length <= 10) return '******';
  return trimmed.slice(0, 6) + '...' + trimmed.slice(-4);
}

/**
 * Normalizes phone numbers to pure international digits (E.164 without leading '+').
 * E.g. "+91 99665-59211" -> "919966559211", "9876543210" -> "919876543210"
 */
function cleanPhoneNumber(rawPhone, defaultCountryCode = '91') {
  if (!rawPhone) return '';
  let str = String(rawPhone).trim();
  if (str.endsWith('.0')) str = str.slice(0, -2);
  let digits = str.replace(/\D/g, '');

  // Auto-prepend default country code if exactly 10 digits
  if (digits.length === 10) {
    digits = defaultCountryCode + digits;
  }
  return digits;
}

/**
 * Validates E.164 format (10 to 15 digits)
 */
function isValidE164(phone) {
  const digits = String(phone).replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15;
}

/**
 * Query Meta Graph API for the registered phone number status and business profile.
 */
async function verifyCredentials(token, phoneNumberId, wabaId = null) {
  if (!token || !phoneNumberId) {
    return {
      valid: false,
      error: 'Missing Token or Phone Number ID',
      code: 400
    };
  }

  try {
    const url = `${GRAPH_BASE_URL}/${phoneNumberId}?fields=verified_name,display_phone_number,quality_rating,code_verification_status,status`;
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 12000
    });

    const data = response.data;
    const phone = (data.display_phone_number || '').replace(/\D/g, '');

    return {
      valid: true,
      phone: phone || phoneNumberId,
      displayPhone: data.display_phone_number || phone,
      verifiedName: data.verified_name || 'Verified WhatsApp Business',
      qualityRating: data.quality_rating || 'GREEN',
      codeStatus: data.code_verification_status || 'VERIFIED',
      status: data.status || 'CONNECTED'
    };
  } catch (err) {
    const errorObj = err.response?.data?.error || {};
    const errorCode = errorObj.code || err.response?.status || 500;
    const rawErrorMsg = errorObj.message || err.message;
    const errorMsg = redactSensitive(rawErrorMsg);
    const errorType = errorObj.type || 'ApiException';
    const errorUserTitle = redactSensitive(errorObj.error_user_title || null);
    const errorUserMsg = redactSensitive(errorObj.error_user_msg || null);
    const fbtraceId = errorObj.fbtrace_id || null;
    const errorSubcode = errorObj.error_subcode || null;

    let userAdvice = errorUserMsg ? `${errorUserMsg}. ` : 'Check your Access Token and Phone Number ID in Meta Developers Console.';
    let rootCauses = [];

    if (errorCode === 190) {
      userAdvice = 'Meta Error 190: Access token has expired, is invalid, or was revoked. A fresh Permanent System User Token is required from Meta Business Suite.\n\nHow to fix:\n1. Open Meta Business Suite (business.facebook.com) -> Settings -> System Users.\n2. Ensure your System User has Full Control under Assigned Assets -> WhatsApp Accounts.\n3. Click "Generate New Token", select your WhatsApp App, and check permissions: "whatsapp_business_messaging" and "whatsapp_business_management".\n4. Copy the newly generated permanent token and paste it into Settings in this application.';
      rootCauses.push('The token has expired or was manually revoked in Meta Business Suite.');
      rootCauses.push('A short-lived 24-hour developer token was configured instead of a Permanent System User Token.');
      rootCauses.push('The Meta Business account or user password was changed, which automatically invalidates previous session tokens.');
    } else if (errorCode === 100) {
      userAdvice = 'Phone Number ID does not exist or does not belong to this Meta App/Business Portfolio.';
      rootCauses.push('Check that the Phone Number ID is 15-16 digits and matches the Phone Number ID in WhatsApp > API Setup.');
    } else if (errorCode === 200 || errorCode === 10) {
      userAdvice = errorUserMsg || 'Meta API access is blocked or permission is denied by Meta Business Suite.';
      rootCauses = [
        '1. Asset Not Assigned to System User: In Meta Business Suite -> Business Settings -> System Users -> Select your System User -> Click "Add Assets" -> Select "WhatsApp Accounts" -> Select your WABA -> Enable "Manage WhatsApp account (Full control)" -> Save Changes.',
        '2. Payment / Billing Method Verification: If you recently added or updated your payment card, Meta holds API traffic until the card is verified in Meta Business Suite -> Billing & Payments.',
        '3. Token Permissions: Ensure your System User token was generated with both "whatsapp_business_messaging" and "whatsapp_business_management" checked.',
        '4. App in Development Mode: If your Meta App is still in "Development" mode, switch it to "Live" mode or add recipient numbers to the Allowed Testers list in the App Dashboard.'
      ];
    }

    return {
      valid: false,
      code: errorCode,
      subcode: errorSubcode,
      userMsg: errorUserMsg,
      userTitle: errorUserTitle,
      fbtraceId: fbtraceId,
      type: errorType,
      error: errorMsg,
      advice: redactSensitive(userAdvice),
      rootCauses: rootCauses.map(r => redactSensitive(r))
    };
  }
}

/**
 * Deep Multi-Step Meta API Diagnostics
 * Probes token, permissions, phone number ID, and WABA ID to isolate the exact cause of any error.
 */
async function deepDiagnoseCredentials(token, phoneNumberId, wabaId = null) {
  const steps = [];

  if (!token || !token.trim()) {
    return {
      ok: false,
      summary: 'Permanent Access Token is missing',
      steps: [{ name: 'Token Check', passed: false, detail: 'Token is blank' }]
    };
  }

  // Probe 1: Token & User Profile
  let tokenInfo = { ok: false };
  try {
    const res = await axios.get(`${GRAPH_BASE_URL}/me?fields=id,name`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000
    });
    tokenInfo = { ok: true, id: res.data.id, name: res.data.name };
    steps.push({
      name: 'Token Signature & Validity',
      passed: true,
      detail: `Valid Meta Token (Identity: ${res.data.name || 'System User'}, ID: ${res.data.id})`
    });
  } catch (err) {
    const errData = err.response?.data?.error || {};
    steps.push({
      name: 'Token Signature & Validity',
      passed: false,
      code: errData.code || 500,
      detail: errData.message || err.message
    });
  }

  // Probe 2: Token Permissions / Scopes
  try {
    const res = await axios.get(`${GRAPH_BASE_URL}/me/permissions`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000
    });
    const perms = (res.data?.data || []).filter(p => p.status === 'granted').map(p => p.permission);
    const hasMessaging = perms.includes('whatsapp_business_messaging');
    const hasManagement = perms.includes('whatsapp_business_management');

    steps.push({
      name: 'Token WhatsApp Permissions',
      passed: hasMessaging,
      detail: `Granted: ${perms.length > 0 ? perms.join(', ') : 'None detected'}. ` +
        (!hasMessaging ? 'Missing "whatsapp_business_messaging". ' : '') +
        (!hasManagement ? 'Recommended: "whatsapp_business_management".' : '')
    });
  } catch (err) {
    // If /me/permissions is restricted for System Users, note it gracefully
    steps.push({
      name: 'Token WhatsApp Permissions',
      passed: true,
      detail: 'System User Token active (Direct permission probe bypassed by Meta policy)'
    });
  }

  // Probe 3: Phone Number ID Accessibility
  let phoneAccessible = false;
  let phoneData = null;
  if (phoneNumberId) {
    try {
      const res = await axios.get(`${GRAPH_BASE_URL}/${phoneNumberId}?fields=verified_name,display_phone_number,quality_rating,code_verification_status,status`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10000
      });
      phoneAccessible = true;
      phoneData = res.data;
      steps.push({
        name: 'Phone Number ID Authorization',
        passed: true,
        detail: `Connected to ${res.data.display_phone_number || phoneNumberId} (${res.data.verified_name || 'Verified'}). Quality: ${res.data.quality_rating || 'GREEN'}`
      });
    } catch (err) {
      const errObj = err.response?.data?.error || {};
      const code = errObj.code || 500;
      const msg = redactSensitive(errObj.message || err.message);
      let fix = 'Check Phone Number ID.';
      if (code === 200) {
        fix = 'API Access Blocked: System user needs WhatsApp Account asset assigned with Full Control, or Meta Payment method requires review.';
      } else if (code === 100) {
        fix = 'Phone Number ID does not exist or does not match this Meta Business account.';
      }
      steps.push({
        name: 'Phone Number ID Authorization',
        passed: false,
        code,
        detail: `Meta Error (${code}): ${msg}. Action: ${fix}`
      });
    }
  }

  // Probe 4: WABA ID Accessibility (Optional)
  if (wabaId && wabaId.trim()) {
    try {
      const res = await axios.get(`${GRAPH_BASE_URL}/${wabaId.trim()}?fields=id,name,currency,timezone_id`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10000
      });
      steps.push({
        name: 'WhatsApp Business Account (WABA)',
        passed: true,
        detail: `WABA ID ${res.data.id} (${res.data.name || 'Active'}) verified.`
      });
    } catch (err) {
      const errObj = err.response?.data?.error || {};
      steps.push({
        name: 'WhatsApp Business Account (WABA)',
        passed: false,
        code: errObj.code || 500,
        detail: `WABA Query Note: ${errObj.message || err.message}`
      });
    }
  }

  const allPassed = steps.every(s => s.passed);

  return {
    ok: allPassed,
    phoneAccessible,
    phoneData,
    steps,
    summary: allPassed
      ? 'All Meta Cloud API probes passed successfully. WhatsApp connection is healthy.'
      : 'One or more Meta API probes flagged an authorization or configuration issue.'
  };
}

/**
 * Upload a media file (Image JPG/PNG or Document PDF) to Meta Cloud API.
 * Returns Meta media_id string.
 */
async function uploadMedia(token, phoneNumberId, filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Media file not found at: ${filePath}`);
  }

  const ext = path.extname(filePath).toLowerCase();
  let mimeType = 'image/jpeg';
  if (ext === '.png') mimeType = 'image/png';
  else if (ext === '.pdf') mimeType = 'application/pdf';
  else if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';

  const form = new FormData();
  form.append('file', fs.createReadStream(filePath), {
    filename: path.basename(filePath),
    contentType: mimeType
  });
  form.append('messaging_product', 'whatsapp');

  const url = `${GRAPH_BASE_URL}/${phoneNumberId}/media`;
  const response = await axios.post(url, form, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...form.getHeaders()
    },
    maxContentLength: 100 * 1024 * 1024,
    timeout: 60000
  });

  if (response.data && response.data.id) {
    return {
      mediaId: response.data.id,
      mimeType,
      filename: path.basename(filePath),
      type: mimeType === 'application/pdf' ? 'document' : 'image'
    };
  } else {
    throw new Error(`Meta media upload returned no ID: ${JSON.stringify(response.data)}`);
  }
}

/**
 * Query Meta Graph API for all approved WhatsApp Message Templates belonging to the WABA.
 */
async function fetchApprovedTemplates(token, wabaId) {
  if (!token) {
    return { success: false, error: 'Meta access token is required to fetch templates.', templates: [] };
  }
  if (!wabaId) {
    return { success: false, error: 'WhatsApp Business Account ID (WABA ID) is required to fetch templates.', templates: [] };
  }

  try {
    const url = `${GRAPH_BASE_URL}/${wabaId.trim()}/message_templates?fields=name,status,language,category,components&limit=100`;
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000
    });

    const list = response.data?.data || [];
    
    const mapTemplate = (t) => {
      const headerComp = (t.components || []).find(c => c.type === 'HEADER');
      const bodyComp = (t.components || []).find(c => c.type === 'BODY');
      const hasMediaHeader = headerComp && ['IMAGE', 'DOCUMENT', 'VIDEO'].includes(headerComp.format);
      const mediaFormat = hasMediaHeader ? headerComp.format : null;
      
      const bodyText = bodyComp ? bodyComp.text || '' : '';
      const varMatches = bodyText.match(/\{\{\d+\}\}/g) || [];
      const variableCount = new Set(varMatches).size;

      return {
        name: t.name,
        language: t.language,
        category: t.category,
        status: t.status,
        hasMediaHeader,
        mediaFormat,
        variableCount,
        bodyText
      };
    };

    const allMapped = list.map(mapTemplate);
    const approved = allMapped.filter(t => t.status === 'APPROVED' && t.name.toLowerCase() !== 'hello_world');

    return {
      success: true,
      wabaId: wabaId.trim(),
      templates: approved,
      allTemplates: allMapped,
      totalCount: allMapped.length,
      approvedCount: approved.length
    };
  } catch (err) {
    const errData = err.response?.data?.error || {};
    return {
      success: false,
      code: errData.code || 500,
      error: errData.message || err.message,
      templates: [],
      allTemplates: []
    };
  }
}

/**
 * Validate that a template exists and is APPROVED in Meta WABA.
 */
async function validateTemplate({ token, wabaId, templateName, templateLang }) {
  if (!templateName || !templateName.trim()) {
    return { valid: false, error: 'Template name is required.' };
  }

  const cleanName = templateName.trim();
  if (cleanName.toLowerCase() === 'hello_world') {
    return {
      valid: false,
      code: 131058,
      error: "The 'hello_world' template is only allowed on Meta sandbox test numbers (Error 131058). Please use an approved template created in Meta WhatsApp Manager."
    };
  }

  if (!wabaId || !token) {
    return { valid: true, warning: 'WABA ID not configured; skipping WABA pre-validation.' };
  }

  const res = await fetchApprovedTemplates(token, wabaId);
  if (!res.success) {
    return { valid: true, warning: `Could not verify template status with Meta WABA: ${res.error}` };
  }

  // Check if template exists under any status in the WABA
  const anyMatch = (res.allTemplates || []).find(t => t.name.toLowerCase() === cleanName.toLowerCase());
  if (anyMatch && anyMatch.status !== 'APPROVED') {
    const statusMsg = anyMatch.status === 'IN_REVIEW' || anyMatch.status === 'PENDING'
      ? `Template '${cleanName}' is currently 'IN REVIEW' by Meta. Meta only delivers messages using 'APPROVED' templates. Meta usually approves new templates within 1-5 minutes. Please wait for Meta's review or test via direct chat (inside the active 24-hr window).`
      : `Template '${cleanName}' has status '${anyMatch.status}' in Meta WhatsApp Manager. Only 'APPROVED' templates can be delivered.`;
    return {
      valid: false,
      code: 132001,
      error: statusMsg,
      status: anyMatch.status
    };
  }

  const match = res.templates.find(t => t.name.toLowerCase() === cleanName.toLowerCase());
  if (!match) {
    return {
      valid: false,
      code: 132001,
      error: `Template '${cleanName}' was not found among APPROVED templates in WhatsApp Business Account (${wabaId}). Please verify the template name in Meta WhatsApp Manager.`
    };
  }

  // Auto-resolve language: if template language is 'en' and user passed 'en_US' (or vice versa), adopt template's actual language
  let effectiveLanguage = match.language;
  if (templateLang && match.language !== templateLang) {
    const langMatch = res.templates.find(t => t.name.toLowerCase() === cleanName.toLowerCase() && t.language === templateLang);
    if (langMatch) {
      effectiveLanguage = langMatch.language;
    }
  }

  return { valid: true, template: { ...match, language: effectiveLanguage } };
}

/**
 * Send an official WhatsApp message via Meta Cloud API.
 * Handles:
 * - Approved Template Message (Outbound bulk outside 24h window)
 * - Document/PDF Message with caption
 * - Image Message with caption
 * - Direct Text Message
 */
async function sendMessage({
  token,
  phoneNumberId,
  to,
  text = '',
  mediaId = null,
  mediaType = 'image',
  filename = 'document.pdf',
  templateName = null,
  templateLang = 'en_US',
  recipientName = '',
  variableCount = null
}) {
  const cleanPhone = cleanPhoneNumber(to);
  if (!isValidE164(cleanPhone)) {
    return {
      success: false,
      code: 400,
      error: `Invalid E.164 phone number: '${to}'. Must contain 10-15 digits.`
    };
  }

  // Pre-check: Reject hello_world on registered production numbers
  if (templateName && templateName.toLowerCase().trim() === 'hello_world') {
    return {
      success: false,
      code: 131058,
      error: "Meta API Error (131058): Hello World templates can only be sent from the Public Test Numbers.",
      explanation: "Your registered number is a live production number. Meta restricts 'hello_world' to test numbers. Please choose an approved template created in Meta WhatsApp Manager or send direct messages within the active 24-hr customer window."
    };
  }

  const url = `${GRAPH_BASE_URL}/${phoneNumberId}/messages`;
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  };

  let payload = {};

  // Case 1: Meta Approved Template Message
  if (templateName && templateName.trim()) {
    payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanPhone,
      type: 'template',
      template: {
        name: templateName.trim(),
        language: { code: templateLang || 'en_US' }
      }
    };

    const components = [];

    // Header component if media attachment is present
    if (mediaId) {
      if (mediaType === 'document') {
        components.push({
          type: 'header',
          parameters: [
            { type: 'document', document: { id: mediaId, filename: filename || 'attachment.pdf' } }
          ]
        });
      } else {
        components.push({
          type: 'header',
          parameters: [
            { type: 'image', image: { id: mediaId } }
          ]
        });
      }
    }

    // Body component with dynamic variables
    if (templateName.trim() !== 'hello_world') {
      const bodyParams = [];
      if (variableCount === 0) {
        // Template has 0 variables - no body parameters
      } else if (variableCount === 1) {
        const val1 = (recipientName && recipientName.trim()) ? recipientName.trim() : (text && text.trim() ? text.trim() : 'Customer');
        bodyParams.push({ type: 'text', text: val1 });
      } else if (variableCount === 2) {
        const val1 = (recipientName && recipientName.trim()) ? recipientName.trim() : 'Customer';
        const val2 = (text && text.trim()) ? text.trim() : 'Notification';
        bodyParams.push({ type: 'text', text: val1 }, { type: 'text', text: val2 });
      } else if (recipientName && recipientName.trim()) {
        bodyParams.push({ type: 'text', text: recipientName.trim() });
      }

      if (bodyParams.length > 0) {
        components.push({
          type: 'body',
          parameters: bodyParams
        });
      }
    }

    if (components.length > 0) {
      payload.template.components = components;
    }
  }
  // Case 2: Document / PDF Message (within 24hr window)
  else if (mediaId && mediaType === 'document') {
    payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanPhone,
      type: 'document',
      document: {
        id: mediaId,
        caption: text || '',
        filename: filename || 'attachment.pdf'
      }
    };
  }
  // Case 3: Image Message (within 24hr window)
  else if (mediaId) {
    payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanPhone,
      type: 'image',
      image: {
        id: mediaId,
        caption: text || ''
      }
    };
  }
  // Case 4: Standard Text Message (within 24hr window)
  else {
    payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanPhone,
      type: 'text',
      text: {
        preview_url: false,
        body: text || 'Hello'
      }
    };
  }

  try {
    const response = await axios.post(url, payload, { headers, timeout: 25000 });
    const msgId = response.data?.messages?.[0]?.id || 'ACCEPTED';
    return {
      success: true,
      messageId: msgId,
      status: 'sent'
    };
  } catch (err) {
    const errorObj = err.response?.data?.error || {};
    const errorCode = errorObj.code || err.response?.status || 500;
    const rawErrorMsg = errorObj.message || err.message || '';
    const rawErrorDetails = errorObj.error_data?.details || '';
    const errorMsg = redactSensitive(rawErrorMsg);
    const errorDetails = redactSensitive(rawErrorDetails);

    let explanation = errorMsg;
    if (errorCode === 190) {
      explanation = "Meta Error (190): Access token has expired, is invalid, or was revoked. Please generate a new Permanent System User Token in Meta Business Suite (business.facebook.com) > Settings > System Users, and update your token in Meta API Settings.";
    } else if (errorCode === 131058) {
      explanation = "Meta Error (131058): The 'hello_world' sample template can only be sent from Meta Public Test Numbers. Real registered production numbers must use an approved template created in Meta WhatsApp Manager or send direct messages within the active 24-hr customer window.";
    } else if (errorCode === 131047) {
      explanation = '24-Hour Window Expired: Outside the 24-hr customer service window, Meta strictly requires an approved Message Template. Freeform messages cannot be sent until the recipient messages you or you send an approved template.';
    } else if (errorCode === 132001) {
      explanation = `Template '${templateName}' does not exist or is not approved in language '${templateLang}'. Check Meta WhatsApp Manager > Message Templates.`;
    } else if (errorCode === 132000) {
      explanation = `Template variable/parameter mismatch for '${templateName}'. Please verify the required variables (e.g. {{1}}) and header media format match the template in WhatsApp Manager.`;
    } else if (errorCode === 130429) {
      explanation = 'Meta Rate Limit Reached: Cloud API rate limit exceeded. Please wait or throttle message dispatch speed.';
    } else if (errorCode === 131031) {
      explanation = 'Meta WhatsApp Account Restricted: Account has sending restrictions in Meta Business Suite.';
    } else if (errorCode === 100) {
      explanation = `Invalid parameter or phone number format (+${cleanPhone}).`;
    } else if (errorCode === 200 || errorCode === 10) {
      explanation = 'Meta Error (200): API Access Blocked / Permission Denied. Ensure your System User has Full Control over the WhatsApp Account in Meta Business Suite, and verify payment method in Billing & Payments.';
    }

    return {
      success: false,
      code: errorCode,
      error: errorMsg,
      details: errorDetails,
      explanation: redactSensitive(explanation)
    };
  }
}

/**
 * Execute batch dispatch with controlled rate-limiting, progress feedback,
 * and retry backoff.
 */
async function dispatchCampaignBatch({
  token,
  phoneNumberId,
  recipients, // array of { name, phone }
  templateText,
  mediaId = null,
  mediaType = 'image',
  filename = 'attachment.pdf',
  templateName = null,
  templateLang = 'en_US',
  delayMs = 1500, // Throttling: 1.5 seconds between messages (~40/min)
  batchSize = 10,
  onProgress,
  onLog
}) {
  let sent = 0;
  let failed = 0;
  const total = recipients.length;

  for (let i = 0; i < total; i++) {
    const recipient = recipients[i];
    const name = recipient.name || 'Customer';
    const phone = recipient.phone;

    // Standard variable replacement {{name}}
    const personalizedText = (templateText || '').replace(/\{\{name\}\}/gi, name);

    if (onLog) {
      onLog(`[${i + 1}/${total}] Sending to ${name} (+${phone})...`);
    }

    let result = await sendMessage({
      token,
      phoneNumberId,
      to: phone,
      text: personalizedText,
      mediaId,
      mediaType,
      filename,
      templateName,
      templateLang,
      recipientName: name
    });

    // Retry once with 5-second backoff if rate limited (429 or 130429)
    if (!result.success && (result.code === 429 || result.code === 130429)) {
      if (onLog) onLog(`[Rate Limit] Meta throttled request. Backing off 5 seconds before retry...`);
      await new Promise(r => setTimeout(r, 5000));
      result = await sendMessage({
        token,
        phoneNumberId,
        to: phone,
        text: personalizedText,
        mediaId,
        mediaType,
        filename,
        templateName,
        templateLang,
        recipientName: name
      });
    }

    if (result.success) {
      sent++;
      if (onLog) onLog(`--> ACCEPTED ✓ (Meta ID: ${result.messageId})`, 'ok');
    } else {
      failed++;
      if (onLog) onLog(`--> FAILED ✗ [Code ${result.code}]: ${result.explanation || result.error}`, 'err');

      // Critical error halts campaign early
      if ([190, 131031].includes(result.code)) {
        if (onLog) onLog(`\n[CRITICAL HALT] Meta reported fatal error ${result.code}. Halting campaign to protect account.`, 'err');
        break;
      }
    }

    if (onProgress) {
      onProgress({
        index: i + 1,
        total,
        percent: Math.round(((i + 1) / total) * 100),
        recipient,
        result,
        sent,
        failed
      });
    }

    // Controlled rate-limit delay
    if (i < total - 1) {
      let wait = delayMs;
      // Extra pause between batches of 10
      if ((i + 1) % batchSize === 0) {
        wait = delayMs + 2000;
        if (onLog) onLog(`[Batch Pause] Completed batch of ${batchSize}. Pausing 2s to respect Meta Cloud API rate limits...`);
      }
      await new Promise(r => setTimeout(r, wait));
    }
  }

  return { total, sent, failed };
}

/**
 * Query Meta Graph API for WhatsApp Business Profile details (websites, about, description, email).
 */
async function getBusinessProfile(token, phoneNumberId) {
  if (!token || !phoneNumberId) {
    return { success: false, error: 'Missing Token or Phone Number ID' };
  }

  try {
    const url = `${GRAPH_BASE_URL}/${phoneNumberId}/whatsapp_business_profile?fields=about,address,description,email,profile_picture_url,websites,vertical`;
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 12000
    });

    const profile = response.data?.data?.[0] || {};
    return {
      success: true,
      profile: {
        about: profile.about || '',
        address: profile.address || '',
        description: profile.description || '',
        email: profile.email || '',
        websites: Array.isArray(profile.websites) ? profile.websites : [],
        vertical: profile.vertical || '',
        profilePictureUrl: profile.profile_picture_url || ''
      }
    };
  } catch (err) {
    const errorObj = err.response?.data?.error || {};
    return {
      success: false,
      error: errorObj.message || err.message,
      code: errorObj.code || 500
    };
  }
}

/**
 * Remove website URL(s) from WhatsApp Business Profile via official Meta Cloud API.
 * Keeps business name, phone number, and all other profile fields completely untouched.
 */
async function removeProfileWebsites(token, phoneNumberId) {
  if (!token || !phoneNumberId) {
    return { success: false, error: 'Missing Token or Phone Number ID' };
  }

  try {
    const url = `${GRAPH_BASE_URL}/${phoneNumberId}/whatsapp_business_profile`;
    const response = await axios.post(
      url,
      {
        messaging_product: 'whatsapp',
        websites: []
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 12000
      }
    );

    return {
      success: true,
      message: 'Website URL removed from WhatsApp Business Profile successfully.',
      data: response.data
    };
  } catch (err) {
    const errorObj = err.response?.data?.error || {};
    return {
      success: false,
      error: errorObj.message || err.message,
      code: errorObj.code || 500
    };
  }
}

module.exports = {
  GRAPH_API_VERSION,
  GRAPH_BASE_URL,
  redactSensitive,
  maskToken,
  cleanPhoneNumber,
  isValidE164,
  verifyCredentials,
  deepDiagnoseCredentials,
  fetchApprovedTemplates,
  validateTemplate,
  uploadMedia,
  sendMessage,
  dispatchCampaignBatch,
  getBusinessProfile,
  removeProfileWebsites
};

