# WhatsApp Campaign Engine
> **Enterprise-Grade Bulk Messaging Platform with Dynamic Web Studio, Multi-Device WhatsApp Pairing & Cloud Deployment**

[![GitHub Repository](https://img.shields.io/badge/GitHub-Whatsapp--Integration-blue?logo=github)](https://github.com/Gangu-79/Whatsapp-Integration)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![Python Version](https://img.shields.io/badge/python-%3E%3D3.10-blue.svg)](https://python.org/)

A 100% free, automated outreach engine that allows you to broadcast personalized marketing campaigns (rich media image + dynamic personalized caption) directly through your existing **WhatsApp Business** or **Personal WhatsApp** account.

---

## ✨ Key Features

- **🚀 100% Free Forever:** Zero Meta API fees, zero per-conversation charges, and no third-party subscription fees.
- **📱 100% Fully Responsive UI:** Flawlessly formatted across desktop monitors, laptops, tablets, and mobile smartphones.
- **🎨 Ultra-Premium Web Studio:** Modern glassmorphic interface accessible at `http://localhost:8085` or via cloud deployment.
- **📲 Dual Pairing Methods:** Link WhatsApp instantly via **8-digit Phone Pairing Code** or **QR Code scan**.
- **📁 Drag-and-Drop Asset Upload:** Upload Excel contact sheets (`.xlsx`, `.xls`) and campaign images (`.jpg`, `.png`, `.webp`) directly from the browser with an embedded preview and one-click remove.
- **✍️ Dynamic Message Composer:** Real-time auto-saving message template editor supporting `{{name}}` variable personalization.
- **📊 Live Streaming Terminal:** Real-time execution logs streamed directly into the browser via Server-Sent Events (SSE).
- **🛡️ Built-in Anti-Spam Throttling:** Automatic configurable delay intervals between messages to keep your WhatsApp account safe from bans.
- **🤖 Optional Claude AI Personalization:** Automatically crafts customized variations per contact to maximize engagement.
- **☁️ Cloud-Ready:** Pre-configured with `render.yaml` for 1-click deployment on Render.com and `vercel.json` for Vercel.

---

## 🏗️ System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                 WEB STUDIO (http://localhost:8085)          │
│   [01 Connect]      [02 Assets]     [03 Compose]  [04 Launch]│
└──────────────────────────────┬──────────────────────────────┘
                               │
            ┌──────────────────┴──────────────────┐
            ▼                                     ▼
┌───────────────────────────┐         ┌───────────────────────────┐
│   Node.js Gateway Server  │         │     send_campaign.py      │
│   (Baileys Multi-Device)  │ ◀────── │  (Excel parser & dispatch)│
└───────────┬───────────────┘         └───────────────────────────┘
            │
            ▼
┌───────────────────────────┐
│  WhatsApp Network Servers │
│  (Delivered to Contacts)  │
└───────────────────────────┘
```

---

## 📂 Project Structure

```
.
├── public/
│   └── index.html          # Responsive Web Studio UI (HTML5, CSS3, Vanilla JS)
├── gateway.js              # Express & Baileys WhatsApp Gateway (Port 8085 / Cloud PORT)
├── send_campaign.py        # Python dispatch engine (Excel, Claude AI, Throttle)
├── recipients.xlsx         # Contacts spreadsheet (Columns: Name, Phone No)
├── campaign.jpg            # Campaign image attachment
├── message.txt             # Saved message copy template
├── requirements.txt        # Python dependencies
├── package.json            # Node.js dependencies
├── render.yaml             # Render.com blueprint configuration
├── vercel.json             # Vercel deployment configuration
├── .gitignore              # Git ignore rules (auth credentials, node_modules)
├── .env.example            # Environment variables template
└── README.md               # Documentation
```

---

## ⚡ Quick Start Guide

### 1. Prerequisites
- **Node.js**: v18.x or higher installed ([Download](https://nodejs.org/))
- **Python**: 3.10 or higher installed ([Download](https://python.org/))
- **WhatsApp**: Installed and active on your mobile phone

### 2. Installation
Open your terminal in the project directory and run:

```bash
# 1. Install Node.js dependencies
npm install

# 2. Install Python dependencies
pip install -r requirements.txt
```

### 3. Launch the Web Studio Locally
Start the WhatsApp Gateway Server:

```bash
node gateway.js
```

Open your browser and navigate to:
👉 **`http://localhost:8085`**

---

## 📱 How to Use the Web Studio

### Step 01: Connect WhatsApp
Choose your preferred linking method:
- **Phone Code:** Enter your phone number with country code (e.g., `919876543210`) and click **Get Code**. Enter the 8-digit code in WhatsApp under **Settings → Linked Devices → Link a Device → Link with phone number instead**.
- **Scan QR:** Click **Generate QR Code** and scan it using your WhatsApp scanner.

### Step 02: Upload Assets
- **Contacts Sheet:** Drag and drop your `recipients.xlsx` file. Ensure it contains columns named `Name` and `Phone No`.
- **Campaign Image:** Drag and drop your promotional image. The preview appears directly inside the drop zone with a delete button (`✕`) for easy swaps.

### Step 03: Compose Message
Type your announcement message. Use `{{name}}` anywhere in the text to automatically replace it with each recipient's actual name from your spreadsheet. All edits are automatically saved in real time.

### Step 04: Launch Campaign
Click **Launch Bulk Campaign Now**. The live terminal below will stream individual delivery status in real-time until all contacts are reached.

---

## ⚙️ Configuration (`.env`)

To customize advanced settings, copy `.env.example` to `.env`:

```env
# ==========================================
# 1. WHATSAPP SENDER CONFIGURATION
# ==========================================
SENDER_PHONE_NUMBER=919876543210

# ==========================================
# 2. LOCAL GATEWAY CONFIGURATION
# ==========================================
EVOLUTION_API_URL=http://localhost:8085
EVOLUTION_API_KEY=my_secret_api_key_12345
EVOLUTION_INSTANCE_NAME=campaign_instance

# ==========================================
# 3. CAMPAIGN THROTTLING & TESTING
# ==========================================
# Comma-separated test numbers (leave empty for full campaign)
TEST_PHONE_NUMBERS=

# Delay between messages in seconds (recommended: 2.5 to 5.0)
MESSAGE_DELAY_SECONDS=3.0

# ==========================================
# 4. OPTIONAL CLAUDE AI PERSONALIZATION
# ==========================================
USE_CLAUDE=false
ANTHROPIC_API_KEY=your_anthropic_api_key_here
CLAUDE_MODEL=claude-3-5-sonnet-latest
```

---

## 🛡️ Anti-Spam & Deliverability Best Practices

| Audience Type | Recommended Daily Volume | Throttling Delay |
|---|---|---|
| **Existing Customers / Active Leads** | 300 – 600 messages / day | `2.0` – `3.0` seconds |
| **Mixed Contact Lists** | 200 – 400 messages / day | `3.0` – `5.0` seconds |
| **New / Cold Contacts** | 50 – 150 messages / day | `5.0` – `8.0` seconds |

1. **Always Keep Throttling Enabled:** Keep `MESSAGE_DELAY_SECONDS` at `2.5` or higher to prevent automated traffic blocks.
2. **Include an Opt-Out Line:** Adding `"Reply STOP to unsubscribe"` dramatically reduces the likelihood of users clicking "Report Spam".
3. **Warm Up New Numbers:** If using a newly registered WhatsApp number, start with 20–30 messages per day and gradually increase volume over two weeks.

---

## 🌐 Cloud Deployment Guide

### Deploying to Render.com (Recommended Free 24/7 Hosting)
Because WhatsApp Baileys requires a persistent WebSocket server:
1. Fork or push this repository to **GitHub**: `https://github.com/Gangu-79/Whatsapp-Integration`
2. Go to **[Render.com](https://render.com)** and create a **New Web Service**.
3. Connect your repository.
4. Set:
   - **Environment:** `Node`
   - **Build Command:** `npm install && pip install -r requirements.txt`
   - **Start Command:** `node gateway.js`
   - **Instance Type:** `Free`
5. Click **Deploy Web Service** to get a live public URL.

### Deploying Frontend to Vercel
1. A `vercel.json` file is already included in this repository.
2. Run:
   ```bash
   npx vercel --prod
   ```

---

## 📄 License
This project is licensed under the MIT License.
