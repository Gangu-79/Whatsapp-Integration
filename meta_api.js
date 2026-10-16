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
async function verifyCredentials(token, phoneNumberId) {
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
      timeout: 10000
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
    const errorMsg = errorObj.message || err.message;
    const errorType = errorObj.type || 'ApiException';
    const errorSubcode = errorObj.error_subcode || null;

    let userAdvice = 'Check your Access Token and Phone Number ID in Meta Developers Console.';
    if (errorCode === 190) {
      userAdvice = 'Access Token has expired or is invalid. Please generate a new Permanent System User Token in Meta Business Suite > System Users.';
    } else if (errorCode === 100) {
      userAdvice = 'Phone Number ID does not exist or does not belong to this Meta App.';
    } else if (errorCode === 200 || errorCode === 10) {
      userAdvice = 'Permission denied. Ensure your token has "whatsapp_business_messaging" and "whatsapp_business_management" permissions.';
    }

    return {
      valid: false,
      code: errorCode,
      subcode: errorSubcode,
      type: errorType,
      error: errorMsg,
      advice: userAdvice
    };
  }
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
  recipientName = ''
}) {
  const cleanPhone = cleanPhoneNumber(to);
  if (!isValidE164(cleanPhone)) {
    return {
      success: false,
      code: 400,
      error: `Invalid E.164 phone number: '${to}'. Must contain 10-15 digits.`
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
        language: { code: templateLang || 'en_US' },
        components: []
      }
    };

    // Header component if media attachment is present
    if (mediaId) {
      if (mediaType === 'document') {
        payload.template.components.push({
          type: 'header',
          parameters: [
            { type: 'document', document: { id: mediaId, filename: filename || 'attachment.pdf' } }
          ]
        });
      } else {
        payload.template.components.push({
          type: 'header',
          parameters: [
            { type: 'image', image: { id: mediaId } }
          ]
        });
      }
    }

    // Body component with dynamic name variable if present
    if (recipientName && recipientName.trim()) {
      payload.template.components.push({
        type: 'body',
        parameters: [
          { type: 'text', text: recipientName.trim() }
        ]
      });
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
    const errorMsg = errorObj.message || err.message;
    const errorDetails = errorObj.error_data?.details || '';

    let explanation = errorMsg;
    if (errorCode === 131047) {
      explanation = '24-Hour Window Expired: Meta requires an approved Message Template (e.g. campaign_update) to initiate conversations with contacts outside the 24-hr window.';
    } else if (errorCode === 132001) {
      explanation = `Template '${templateName}' does not exist or is not approved in language '${templateLang}'. Check Meta WhatsApp Manager > Message Templates.`;
    } else if (errorCode === 130429) {
      explanation = 'Meta Rate Limit Reached: Cloud API rate limit exceeded. Please wait or throttle message dispatch speed.';
    } else if (errorCode === 131031) {
      explanation = 'Meta WhatsApp Account Restricted: Account has sending restrictions in Meta Business Suite.';
    } else if (errorCode === 100) {
      explanation = `Invalid parameter or phone number format (+${cleanPhone}).`;
    }

    return {
      success: false,
      code: errorCode,
      error: errorMsg,
      details: errorDetails,
      explanation
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

module.exports = {
  GRAPH_API_VERSION,
  GRAPH_BASE_URL,
  cleanPhoneNumber,
  isValidE164,
  verifyCredentials,
  uploadMedia,
  sendMessage,
  dispatchCampaignBatch
};
