# Official Meta WhatsApp Cloud API Campaign Engine
> **Enterprise Bulk Messaging Platform powered by the Official Meta WhatsApp Business Platform, Opt-In Safeguards, and Dynamic Personalization**

[![GitHub Repository](https://img.shields.io/badge/GitHub-Whatsapp--Integration-blue?logo=github)](https://github.com/Gangu-79/Whatsapp-Integration)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![Python Version](https://img.shields.io/badge/python-%3E%3D3.10-blue.svg)](https://python.org/)

An official, policy-compliant WhatsApp Campaign Studio that broadcasts marketing and transactional campaigns through the **Official Meta WhatsApp Cloud API (Graph API)**. Built to permanently eliminate account bans, device restriction warnings, and unapproved web socket automations.

---

## 🚨 Why Unofficial Automation Leads to Account Restrictions

If you attempted to send bulk messages through personal numbers or linked WhatsApp Web sessions (using libraries like Baileys or browser scripts), WhatsApp's automated abuse detection detects:
1. **Unregistered Bulk Traffic**: High outgoing message frequency on a standard consumer or WhatsApp Business app account.
2. **Missing Opt-In Verification**: Sending to users who do not have you saved in their contacts triggers spam reports.
3. **Automated Linked Sessions**: WhatsApp monitors linked device traffic for automated socket scripts. Arbitrary pauses (2–3 seconds) do **not** bypass spam detection.

**The Solution:** Use Meta's **Official WhatsApp Business Platform (Cloud API)**. Messages sent through the official API are authorized by Meta, never risk device bans, deliver at high speed, and comply with international telecommunication standards.

---

## ✨ Features

- **🛡️ Official Meta Cloud API:** 100% policy-compliant server-side Graph API integration. No pairing codes, no QR codes, no device bans.
- **📱 Responsive Glassmorphic Studio:** Modern dark-theme web interface accessible at `http://localhost:8085` or via Render.
- **📁 Excel Contact Processor:** 
  - Robust column detection (`Name`, `Phone`, `Consent`).
  - Automatic international E.164 phone normalization.
  - Automatic duplicate contact detection.
  - **Opt-In / Consent Verification**: Validates recipient consent before dispatch.
  - **Permanent Opt-Out Suppression (`optouts.json`)**: Automatically excludes opted-out contacts.
- **📋 Meta Message Template Support:** Supports approved Business Templates for outreach outside the 24-hour service window.
- **🖼️ Rich Media Attachment:** Uploads campaign imagery directly to Meta's Media API.
- **✍️ Personalized Messaging:** Replaces dynamic tags (e.g., `{{name}}`) or uses Anthropic Claude AI.
- **🔔 Live Delivery & Webhook Support:**
  - `GET /api/webhook`: Webhook subscription verification.
  - `POST /api/webhook`: Real-time delivery receipts (`sent`, `delivered`, `read`) and automatic opt-out keyword handling (`STOP`, `UNSUBSCRIBE`).
- **🛑 Failsafe Quality Controls:** Automatically halts execution if Meta reports account restrictions, invalid tokens, or template mismatches.

---

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                 WEB STUDIO (http://localhost:8085)          │
│   [01 Meta Setup]   [02 Assets]     [03 Compose]  [04 Launch]│
└──────────────────────────────┬──────────────────────────────┘
                               │
             ┌─────────────────┴─────────────────┐
             ▼                                   ▼
┌───────────────────────────┐       ┌───────────────────────────┐
│   Node.js Gateway Server  │       │     send_campaign.py      │
│   (Express & Meta Config) │ ◀──── │  (Excel & Meta Graph API) │
└────────────┬──────────────┘       └─────────────┬─────────────┘
             │                                    │
             │ Webhooks & Auth                    │ Official Outbound API
             ▼                                    ▼
┌───────────────────────────────────────────────────────────────┐
│                META WHATSAPP CLOUD API (Graph v21.0)           │
│         https://graph.facebook.com/v21.0/{PHONE_ID}/messages   │
└──────────────────────────────┬────────────────────────────────┘
                               │
                               ▼
┌───────────────────────────────────────────────────────────────┐
│                    VERIFIED CUSTOMER DEVICES                  │
└───────────────────────────────────────────────────────────────┘
```

---

## 🔑 Meta WhatsApp Cloud API Setup Guide

Follow these beginner-friendly steps to obtain your official Meta credentials:

### Step 1: Create a Meta Developer App
1. Go to [developers.facebook.com](https://developers.facebook.com/) and log in with your Facebook/Meta account.
2. Click **My Apps** > **Create App**.
3. Select **Other** > **Next**, then choose **Business** as the app type.
4. Name your app (e.g. `WhatsApp Campaign Engine`) and link your Meta Business Account.

### Step 2: Set Up WhatsApp Product
1. On your App Dashboard, find **WhatsApp** and click **Set up**.
2. Go to **WhatsApp** > **API Setup** in the left menu.
3. You will see:
   - **Temporary Access Token** (valid for 24 hours for testing)
   - **Phone Number ID** (e.g. `104829104812345`)
   - **WhatsApp Business Account ID** (WABA ID)
   - **Test Phone Number** provided by Meta to send test messages to your personal number.

### Step 3: Create a Permanent System User Token
1. Open [Meta Business Suite](https://business.facebook.com/settings).
2. Go to **Business Settings** > **Users** > **System Users**.
3. Click **Add**, name the user (e.g. `whatsapp-gateway`), and select the role **Admin**.
4. Click **Generate New Token**, select your WhatsApp App, and enable permissions:
   - `whatsapp_business_messaging`
   - `whatsapp_business_management`
5. Copy the generated permanent token (starts with `EAAG...`).

### Step 4: Create an Approved Message Template
WhatsApp requires an approved message template for business-initiated conversations outside the 24-hour service window:
1. In Meta WhatsApp Manager, navigate to **Account Tools** > **Message Templates**.
2. Click **Create Template**.
3. Choose Category: **Marketing** or **Utility**.
4. Name: `campaign_update` (matching `WHATSAPP_TEMPLATE_NAME`).
5. Body: `Hello {{1}}, excited to share our latest offer with you!`
6. Submit for review (approval usually takes under 5 minutes).

---

## ⚡ Local Installation & Quick Start

### 1. Prerequisites
- **Node.js**: v18.x or v20+ ([Download Node.js](https://nodejs.org/))
- **Python**: 3.10 or higher ([Download Python](https://python.org/))

### 2. Install Dependencies
```bash
# Install Node.js packages
npm install

# Install Python packages
pip install -r requirements.txt
```

### 3. Configure Environment Variables
Copy `.env.example` to `.env` and fill in your Meta Cloud API details:
```ini
WHATSAPP_TOKEN=EAAG...your_permanent_access_token_here
WHATSAPP_PHONE_NUMBER_ID=104829104812345
WHATSAPP_BUSINESS_ACCOUNT_ID=109283019283
WHATSAPP_TEMPLATE_NAME=campaign_update
WHATSAPP_TEMPLATE_LANG=en_US
WEBHOOK_VERIFY_TOKEN=whatsapp_campaign_verify_token_123
```

### 4. Start the Application
```bash
node gateway.js
```
Open your browser at:
👉 **`http://localhost:8085`**

---

## 📋 Excel Contact File Format (.xlsx / .xls)

Your spreadsheet should contain standard contact columns. The engine automatically detects flexible header names:

| Name | Phone | Consent |
| :--- | :--- | :--- |
| Alice Smith | +91 98765 43210 | Yes |
| Bob Jones | 919876543211 | Yes |
| Charlie Brown | 919876543212 | Yes |

- **Name Column**: `Name`, `Full Name`, `Recipient`, `Contact Name`
- **Phone Column**: `Phone`, `Mobile`, `Number`, `PhNo`
- **Consent Column (Recommended)**: `Consent`, `OptIn`, `Subscribed`, `Permission`
  - Values: `Yes`, `True`, `1`, `Agreed`, `Opted_In`

---

## 🛑 Opt-Out Handling & Webhooks

### 1. Automatic Opt-Out Keyword Detection
When users reply with:
`STOP`, `UNSUBSCRIBE`, `CANCEL`, or `OPTOUT`
The webhook automatically records their phone number in `optouts.json` and suppresses them permanently from all future campaigns.

### 2. Configuring Webhook in Meta
1. In Meta Developers Console, go to **WhatsApp** > **Configuration**.
2. Under **Webhook**, click **Edit**.
3. **Callback URL**: `https://your-app-domain.onrender.com/api/webhook`
4. **Verify Token**: `whatsapp_campaign_verify_token_123` (matching `WEBHOOK_VERIFY_TOKEN`).
5. Click **Verify and Save**.
6. Subscribe to **messages**.

---

## ☁️ Deploying to Render

1. Commit and push your code to GitHub:
   ```bash
   git add .
   git commit -m "Official Meta WhatsApp Cloud API integration"
   git push origin main
   ```
2. In your [Render Dashboard](https://dashboard.render.com/), open your Web Service.
3. In **Environment**, configure the following environment variables:
   - `WHATSAPP_TOKEN`: Your Meta Permanent Access Token
   - `WHATSAPP_PHONE_NUMBER_ID`: Your Meta Phone Number ID
   - `WHATSAPP_BUSINESS_ACCOUNT_ID`: Your WABA ID
   - `WHATSAPP_TEMPLATE_NAME`: `campaign_update` (or your approved template name)
   - `WEBHOOK_VERIFY_TOKEN`: `whatsapp_campaign_verify_token_123`
4. Trigger **Manual Deploy** > **Deploy latest commit**.
5. Once live, access your secure WhatsApp Campaign Studio.
