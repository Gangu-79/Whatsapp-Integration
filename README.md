# Official Meta WhatsApp Cloud API Campaign Engine & Live Inbox

> **Enterprise WhatsApp Business Platform with Single & Bulk Excel Messaging, PDF/Image Attachments, Real-Time 2-Way Inbox, Audio Notifications, Persistent Backup & Recovery, and User Authentication.**

[![Production Deployment](https://img.shields.io/badge/Render-Live%20Application-success?logo=render)](https://whatsapp-integration-wylm.onrender.com/)
[![GitHub Repository](https://img.shields.io/badge/GitHub-Whatsapp--Integration-blue?logo=github)](https://github.com/Gangu-79/Whatsapp-Integration)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![Python Version](https://img.shields.io/badge/python-%3E%3D3.10-blue.svg)](https://python.org/)

---

## 🚀 Live Production URL

- **Web Application**: [https://whatsapp-integration-wylm.onrender.com/](https://whatsapp-integration-wylm.onrender.com/)
- **Default Administrator Credentials**:
  - **Username**: `admin`
  - **Password**: `admin123`

---

## 🌟 Key Capabilities & Requirements Implemented

### 1. Modern Responsive Interface
- **Universal Device Support**: Tailored for Smartphones (iPhone, Android, 360px–480px), Tablets (iPad, 768px–1024px), Laptops, and Desktops.
- **Glassmorphic UI**: Ultra-clean dark theme with ambient lighting, gradient typography, and micro-interactions.
- **Mobile Bottom Navigation**: Native-like app navigation bar on mobile devices for easy one-thumb operation.

### 2. User Registration, Login & Session Security
- **Secure Authentication**: Built-in user registration, login, session tokens, and logout.
- **Password Protection**: Uses industry-standard **PBKDF2** with 10,000 iterations and cryptographic salts (`crypto` built-in module; zero native compilation dependencies).
- **Session Isolation**: Active sessions stored securely with 7-day expiration without disconnecting the background WhatsApp webhook listener.

### 3. Single Person & Bulk Excel Messaging
- **Single Person Mode**:
  - Country code dropdown with auto-formatting (+91, +1, +44, +971, +966, etc.).
  - Support for custom recipient names and personalized templates.
  - Media attachment for images (JPG, PNG, JPEG) and PDF documents with instant preview.
- **Bulk Excel Mode**:
  - Drag-and-drop Excel (`.xlsx`, `.xls`) contact file upload.
  - Automatic column recognition (`Name`, `Phone`, `Consent`).
  - Automatic international E.164 normalization.
  - Automatic duplicate removal and opted-out recipient suppression.

### 4. Official Meta Cloud API Integration & Error 200 Diagnostic Fixer
- **Zero Account Bans**: Direct official Graph API v21.0 integration. Does NOT use unofficial web scrapers, browser automation, or QR code pairing.
- **Deep Multi-Probe Diagnostics (`/api/meta/diagnose`)**: Probes token validity, permission scopes, Phone Number ID authorization, and WABA ID connectivity.
- **Server-Side Security**: Permanent tokens are stored securely in backend storage and are **never** exposed in frontend responses.

### 5. 2-Way Persistent Live Inbox & Fast Replies
- **Real-Time Customer Messaging**: Displays incoming messages with contact profile name, phone number, timestamp, and unread badges.
- **24-Hour Customer Care Window Tracker**: Visual countdown indicator (🟢 Active / 🔴 Expired) showing whether freeform replies or approved templates are required.
- **Instant Replies**: Reply directly to customer inquiries from the inbox modal.

### 6. Audio Notification Chimes & Browser Alerts
- **Synthesized Dual-Tone Chime**: Built-in Web Audio API synthesizer sounds a pleasant double-bell chime when a new incoming message is received.
- **Sound Toggle**: Instant **🔔 Sound: ON / 🔕 Sound: OFF** toggle button in the topbar.
- **Browser Push Notifications**: Supports native browser notifications when permitted.

### 7. Message Storage & Database Backup / Recovery
- **Pure-JS Persistent Database (`data/whatsapp_store.json`)**: Auto-recovering schema with zero native C++ compilation dependencies (guarantees 100% build reliability on Render and Linux containers).
- **One-Click Export Backup**: Downloads full database archive in JSON format containing settings, contacts, conversations, messages, and campaign logs.
- **One-Click Restore**: Upload an existing backup file to restore all records with zero data loss.

### 8. Live Campaign Status Tracking
- **Meta Webhook Integration**: Real-time delivery status updates:
  - ⏳ **Pending**: Scheduled in queue.
  - 🚀 **Sending**: Dispatched to Meta Graph API.
  - 📤 **Sent**: Accepted by Meta Cloud API servers.
  - 📬 **Delivered**: Reached recipient's handset.
  - 👁️ **Read**: Opened by recipient (blue ticks).
  - ❌ **Failed**: Detailed error code and actionable advice recorded.

### 9. Delivery Reports & Audit Logs
- **Reach Analytics**: Dispatched count, delivered rate, read rate, and failure breakdown.
- **Downloadable CSV Report**: One-click download of timestamped campaign delivery records.

### 10. Enterprise Reliability & Safeguards
- **Controlled Batching**: Intelligent throttling (1.5s delay + 2s batch pause) to comply with Meta Cloud API rate limits.
- **Automatic Opt-Out Suppression**: Inbound keywords (`STOP`, `UNSUBSCRIBE`, `CANCEL`) immediately add contacts to `optouts.json`.

---

## ⚠️ Why Does Meta Error 200 ("API access blocked") Occur?

If you encounter **`Meta API Error (200): API access blocked / Permission denied`**, this is an **asset or payment authorization hold in your Meta Business Suite**, not a bug in the code.

### The 3 Causes & Fixes:

#### 1. Asset Not Assigned to System User (90% of cases)
When creating a System User and generating a permanent token in Meta Business Suite, Meta does **not** automatically grant the user access to your WhatsApp Business Account (WABA).
- **Fix**:
  1. Open [Meta Business Settings > System Users](https://business.facebook.com/settings/system-users).
  2. Select your System User from the left list.
  3. Click **"Add Assets"**.
  4. Select **"WhatsApp Accounts"** on the left.
  5. Check your WhatsApp account name.
  6. On the right, toggle **"Manage WhatsApp account (Full control)"** to **ON**.
  7. Click **"Save Changes"**.
  8. Click **"Generate new token"**, select your App, ensure `whatsapp_business_messaging` and `whatsapp_business_management` are checked, and copy the new token into Settings.

#### 2. Payment Method / Billing Hold
Meta Cloud API requires an active payment method on file. If you recently added a bank card, Meta places a security hold on API traffic until the card authorization clears.
- **Fix**:
  1. Open [Meta Billing & Payments](https://business.facebook.com/billing_hub).
  2. Verify that your card is marked as **Active / Default** with no unpaid hold.

#### 3. App Mode (Development vs. Live)
If your Meta App in [developers.facebook.com](https://developers.facebook.com/) is in **Development Mode**, Meta blocks API messages to any phone number not explicitly added to the Allowed Test Numbers list.
- **Fix**:
  1. Go to your App Dashboard and switch the top toggle from **Development** to **Live**.
  2. Alternatively, add your recipient phone number under **WhatsApp > API Setup > To (Allowed Test Numbers)**.

---

## 🛠️ Step-by-Step Meta Cloud API Setup

### Step 1: Create a Meta Developer App
1. Go to [developers.facebook.com](https://developers.facebook.com/) and sign in.
2. Click **My Apps** > **Create App**.
3. Select **Other** > **Next**, then select **Business**.
4. Name your app (e.g. `WhatsApp Messaging Engine`) and link your Meta Business Portfolio.

### Step 2: Add WhatsApp Product
1. In your App Dashboard, find **WhatsApp** and click **Set Up**.
2. Go to **WhatsApp > API Setup** in the left sidebar.
3. Note your **Phone Number ID** (e.g. `1337215722817983`) and **WhatsApp Business Account ID** (WABA ID).

### Step 3: Create a Permanent System User Token
1. Open [Meta Business Settings](https://business.facebook.com/settings).
2. Go to **Users > System Users** and click **Add**.
3. Set Role to **Admin** and click **Create System User**.
4. Click **Add Assets** > **WhatsApp Accounts** > Select your WABA > Enable **Manage WhatsApp account (Full control)** > Save.
5. Click **Generate New Token**, select your App, and enable:
   - `whatsapp_business_messaging`
   - `whatsapp_business_management`
6. Copy the generated permanent token (starts with `EAAG...`).

### Step 4: Approved Message Template (For Outreach Outside 24h Window)
1. In [WhatsApp Manager](https://business.facebook.com/wa/manage/home/), navigate to **Message Templates**.
2. Click **Create Template**:
   - **Category**: Marketing or Utility
   - **Name**: `campaign_update`
   - **Language**: English (US) - `en_US`
   - **Body**: `Hello {{1}}, thank you for reaching out to us!`
3. Click **Submit**. Approval usually takes 1 to 5 minutes.

### Step 5: Webhook Configuration
1. In Meta Developer Console, go to **WhatsApp > Configuration**.
2. Under **Webhook**, click **Edit**:
   - **Callback URL**: `https://whatsapp-integration-wylm.onrender.com/api/webhook`
   - **Verify Token**: `whatsapp_campaign_verify_token_123`
3. Click **Verify and Save**.
4. Under **Webhook fields**, click **Manage** and subscribe to **`messages`**.

---

## 💻 Local Installation & Setup

### 1. Prerequisites
- **Node.js**: v18.0.0 or higher ([Download Node.js](https://nodejs.org/))
- **Python**: v3.10 or higher ([Download Python](https://python.org/))
- **Git**: Installed on your system

### 2. Clone & Install
```bash
# Clone the repository
git clone https://github.com/Gangu-79/Whatsapp-Integration.git
cd "Whatsapp-Integration"

# Install Node dependencies
npm install

# Install Python dependencies
pip install -r requirements.txt
```

### 3. Environment Configuration (`.env`)
Create a `.env` file in the root folder (or use `.env.example` as a template):
```ini
PORT=8085
WHATSAPP_TOKEN=EAAG...your_permanent_system_user_token_here
WHATSAPP_PHONE_NUMBER_ID=1337215722817983
WHATSAPP_BUSINESS_ACCOUNT_ID=1704639724550656
WHATSAPP_TEMPLATE_NAME=campaign_update
WHATSAPP_TEMPLATE_LANG=en_US
WEBHOOK_VERIFY_TOKEN=whatsapp_campaign_verify_token_123
```

### 4. Start the Application
```bash
node gateway.js
```

Open your web browser at:
👉 **`http://localhost:8085`**

Sign in with the default admin account:
- **Username**: `admin`
- **Password**: `admin123`

---

## 📊 Excel File Format Guide (`.xlsx` / `.xls`)

When using **Bulk Excel Upload**, make sure your spreadsheet has standard headers. The engine automatically detects flexible column names:

| Name | Phone | Consent |
| :--- | :--- | :--- |
| Rahul Sharma | +91 98765 43210 | Yes |
| Priya Patel | 9966559211 | True |
| John Doe | +1 (555) 234-5678 | 1 |

- **Name Column**: `Name`, `Full Name`, `Customer Name`, `Recipient`
- **Phone Column**: `Phone`, `Mobile`, `Number`, `WhatsApp Number`, `PhNo`
- **Consent Column**: `Consent`, `OptIn`, `Subscribed`, `Permission` (Values: `Yes`, `True`, `1`, `Agreed`)

---

## ☁️ Deploying Updates to Render

This repository is configured for automated CI/CD deployment on [Render](https://render.com/).

Whenever you commit and push to the `main` branch, Render automatically redeploys:

```bash
git add .
git commit -m "Your descriptive commit message"
git push origin main
```

### Render Environment Variables Checklist:
In your [Render Dashboard](https://dashboard.render.com/) > Your Service > **Environment**:
- `WHATSAPP_TOKEN`: Permanent System User Token
- `WHATSAPP_PHONE_NUMBER_ID`: Phone Number ID
- `WHATSAPP_BUSINESS_ACCOUNT_ID`: WABA ID
- `WHATSAPP_TEMPLATE_NAME`: *(Optional - leave empty for direct customized messaging, or specify your approved template name)*
- `WHATSAPP_TEMPLATE_LANG`: `en_US`
- `WEBHOOK_VERIFY_TOKEN`: `whatsapp_campaign_verify_token_123`
- `NODE_VERSION`: `20.10.0`

---

## 📄 License

This project is licensed under the MIT License - feel free to use and customize it for your business needs.
