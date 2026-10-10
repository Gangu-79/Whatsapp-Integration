# Automated WhatsApp Campaign Engine
### Excel-Driven Personalized Image & Message Broadcasting via Local WhatsApp Business Gateway & Claude AI

A lightweight, automated, and **100% free** enterprise pipeline designed to broadcast personalized media campaigns (Image + Custom Caption) directly through your existing **WhatsApp Business Account**.

---

## 🌟 Key Highlights & Advantages

- **Zero Meta / Facebook Dependency:** No Facebook Developer Console, no Business Manager verification, no Facebook accounts, and no document submissions.
- **100% Free Forever (₹0 per message):** Avoid expensive Meta conversation fees (~₹0.50–₹0.80 per message) and third-party subscription charges.
- **No Waiting for Template Approvals:** Send dynamic images and custom messages immediately without Meta's 24–48 hour template review process.
- **AI-Powered Personalization:** Integrates Anthropic Claude to craft customized, professional messages based on recipient data while preventing hallucination.
- **Direct Mobile Chat Sync:** Customer replies land directly inside the WhatsApp Business app on your mobile phone, allowing immediate two-way communication.
- **Display Official Business Identity:** Messages arrive from your registered WhatsApp Business profile (verified business name, profile photo, catalog, and description).

---

## 🔄 System Architecture & Data Flow

```
┌─────────────────────────────────┐
│         recipients.xlsx         │ ──▶ 1. Ingests Name & Phone Number records
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│           message.txt           │ ──▶ 2. Reads base message template
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│       Anthropic Claude AI       │ ──▶ 3. Personalizes message per contact
│  (or built-in template engine)  │        (strictly fact-accurate, 50–100 words)
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│     Local WhatsApp Gateway      │ ──▶ 4. Attaches campaign.jpg + custom caption
│      (http://localhost:8085)    │        and routes via authenticated session
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│     WhatsApp Business Delivery  │ ──▶ 5. Delivered directly to recipient's phone
└─────────────────────────────────┘
```

---

## 📁 Repository Structure

```
.
├── recipients.xlsx       # Recipient dataset (Columns: 'Name', 'Phone No')
├── message.txt           # Base message template with {{name}} placeholder
├── campaign.jpg          # Campaign promotional/announcement image
├── gateway.js            # Standalone Node.js WhatsApp Business Gateway (port 8085)
├── send_campaign.py      # Core automation orchestrator (Excel → Claude → WhatsApp)
├── requirements.txt      # Python dependencies (pandas, requests, anthropic, etc.)
├── package.json          # Node.js gateway dependencies (@whiskeysockets/baileys, etc.)
├── .env                  # Configuration & API credentials (Private)
├── .env.example          # Sample environment configuration template
└── README.md             # Complete technical & operational guide
```

---

## ⚙️ Prerequisites & Installation

### 1. Requirements
- **Python:** 3.10 or higher
- **Node.js:** v18 or higher
- **WhatsApp Business App** active on your mobile phone

### 2. Install Dependencies

Install Node.js gateway modules:
```bash
npm install
```

Install Python dependencies:
```bash
pip install -r requirements.txt
```

---

## 🔑 Configuration (`.env`)

Configure your environment settings in [`.env`](file:///c:/Users/shanm/Downloads/What'sapp%20integration/.env):

```env
# ==========================================
# 1. ANTHROPIC CLAUDE CONFIGURATION
# ==========================================
ANTHROPIC_API_KEY=your_anthropic_api_key_here
CLAUDE_MODEL=claude-3-5-sonnet-latest

# Set to 'false' if you want direct variable replacement without Claude API
USE_CLAUDE=true

# ==========================================
# 2. LOCAL WHATSAPP GATEWAY CONFIG
# ==========================================
EVOLUTION_API_URL=http://localhost:8085
EVOLUTION_API_KEY=my_secret_api_key_12345
EVOLUTION_INSTANCE_NAME=campaign_instance

# ==========================================
# 3. CAMPAIGN & THROTTLING SETTINGS
# ==========================================
# Specify comma-separated phone numbers for testing (e.g. +919876543210, +919876543211)
# Leave empty to send to all valid Excel recipients.
TEST_PHONE_NUMBERS=

# Safe throttle delay in seconds between messages (Recommended: 2.0 to 5.0)
MESSAGE_DELAY_SECONDS=2.0
```

---

## 🚀 Step-by-Step Execution Guide

### Step 1: Start the Local WhatsApp Gateway
Open a terminal window and run:
```bash
node gateway.js
```
* **First-Time Setup (Phone Pairing Code):** If not yet linked, the gateway will display an 8-character pairing code on screen. In your mobile WhatsApp Business app, go to **Settings (or 3 dots) ➔ Linked Devices ➔ Link a Device ➔ "Link with phone number instead"**, and enter the code.
* **Subsequent Runs:** Your session credentials are saved locally in `auth_info_baileys/`. The gateway will automatically reconnect in seconds without requiring pairing again.

### Step 2: Prepare Your Campaign Data
1. **Contacts:** Add your target contacts in [`recipients.xlsx`](file:///c:/Users/shanm/Downloads/What'sapp%20integration/recipients.xlsx). The engine automatically recognizes standard column variations (`Name`, `Phone No`, `Mobile`, `Contact`).
2. **Template:** Customize [`message.txt`](file:///c:/Users/shanm/Downloads/What'sapp%20integration/message.txt) with your announcement and the `{{name}}` tag.
3. **Media:** Place your marketing graphic as [`campaign.jpg`](file:///c:/Users/shanm/Downloads/What'sapp%20integration/campaign.jpg).

### Step 3: Run Campaign Verification (Dry Run)
Before sending live messages, simulate the pipeline to verify formatting and variable replacements:
```bash
python send_campaign.py --dry-run
```

### Step 4: Dispatch the Live Campaign
Open a second terminal window (leaving the gateway running) and execute:
```bash
python send_campaign.py
```

The script will log individual delivery confirmations and provide a final campaign summary:
```
=================== DISPATCHING MESSAGES ===================

Peddi Gangothri
+917093359709
Message: Hello Peddi Gangothri, we are happy to share an important update with you. Please check the attached image for complete details. Thank you for your continued support!
Status: SENT

====================== CAMPAIGN SUMMARY ======================
Total Processed: 3
Successful:      3
Failed:          0
==============================================================
```

---

## 📊 Volume Capacities & Anti-Spam Safety Guide

### Recommended Daily Sending Limits
Because this engine connects directly through your WhatsApp Business profile, daily delivery limits depend on account maturity and recipient engagement:

| Audience Segment | Recommended Daily Volume | Throttle Delay (`MESSAGE_DELAY_SECONDS`) |
|---|---|---|
| **Known Customers & Active Leads** | **300 – 600 messages / day** | `2.0` – `3.0` seconds |
| **Mixed Contact Lists** | **200 – 400 messages / day** | `3.0` – `5.0` seconds |
| **Cold Outreach (New Contacts)** | **50 – 150 messages / day** | `5.0` – `8.0` seconds |

### Essential Anti-Spam Rules
1. **Never Zero Out Throttling:** Always maintain at least a 2–3 second delay between messages in `.env` to prevent robotic traffic flags.
2. **Batch Large Distributions:** When distributing campaigns to 300+ recipients, split the dispatch into multiple tranches (e.g., 100 in the morning, 100 in the afternoon, 100 in the evening).
3. **Include an Opt-Out Mechanism:** Append a brief opt-out line at the end of your template in [`message.txt`](file:///c:/Users/shanm/Downloads/What'sapp%20integration/message.txt):
   > *"If you prefer not to receive updates, please reply STOP."*
   Honoring opt-out requests avoids recipients tapping WhatsApp's "Report Spam" button.
4. **Leverage AI Variation:** Keep `USE_CLAUDE=true` enabled so messages avoid rigid identical phrasing, which enhances deliverability.

---

## 🔧 Troubleshooting & FAQ

#### 1. What if port 8080 or 8085 is already in use?
The gateway is configured on port `8085` to avoid common database listener conflicts (such as Oracle TNS on `8080`). If you ever need to change the port, update `PORT` in [`gateway.js`](file:///c:/Users/shanm/Downloads/What'sapp%20integration/gateway.js) and `EVOLUTION_API_URL` in [`.env`](file:///c:/Users/shanm/Downloads/What'sapp%20integration/.env).

#### 2. Does my computer need to remain awake during campaign dispatches?
Yes. Both `gateway.js` and `send_campaign.py` run locally, so your computer must remain online and connected to the internet while messages are being sent.

#### 3. How do I switch between test mode and full live mode?
- **Test Mode:** Populate `TEST_PHONE_NUMBERS=+919876543210, +919876543211` in [`.env`](file:///c:/Users/shanm/Downloads/What'sapp%20integration/.env). Only those contacts will be processed.
- **Full Campaign:** Clear the variable (`TEST_PHONE_NUMBERS=`) and save. The script will dispatch to the entire Excel list.
