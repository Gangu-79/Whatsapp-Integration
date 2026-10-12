const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const multer = require('multer');
const QRCode = require('qrcode');

const app = express();
app.use(express.json({ limit: '50mb' }));

// Multer storage: Excel goes to recipients.xlsx, image goes to campaign.jpg
const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, __dirname),
  filename: (req, file, cb) => {
    if (req.path.includes('excel')) cb(null, 'recipients.xlsx');
    else if (req.path.includes('image')) cb(null, 'campaign.jpg');
    else cb(null, file.originalname);
  }
});
const upload = multer({ storage: uploadStorage });

let sock = null;
let connectionState = 'close';
let pairingCodeRequested = false;
let currentPairingCode = null;
let currentQR = null;
let connectionMode = 'phone'; // 'phone' or 'qr'
let reconnectTimer = null;
const authDir = path.join(__dirname, 'auth_info_baileys');

// Helper to read .env
function getEnv(key) {
    try {
        const envContent = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
        for (const line of envContent.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.startsWith(key + '=')) {
                return trimmed.substring(key.length + 1).trim();
            }
        }
    } catch (e) {}
    return process.env[key] || '';
}

// Helper to update a key in .env
function setEnv(key, value) {
    try {
        const envPath = path.join(__dirname, '.env');
        let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
        const regex = new RegExp(`^${key}=.*$`, 'm');
        if (regex.test(content)) {
            content = content.replace(regex, `${key}=${value}`);
        } else {
            content += `\n${key}=${value}`;
        }
        fs.writeFileSync(envPath, content, 'utf8');
    } catch (e) {
        console.error('Failed to update .env:', e);
    }
}

// Initial phone from .env
let pairingPhone = getEnv('SENDER_PHONE_NUMBER') || '917093359709';
pairingPhone = pairingPhone.replace(/[^\d]/g, '');

async function closeCurrentSocket() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (sock) {
        try {
            sock.ev.removeAllListeners();
            sock.end(undefined);
        } catch (e) {}
        sock = null;
    }
}

function clearAuthDir() {
    try {
        if (fs.existsSync(authDir)) {
            fs.rmSync(authDir, { recursive: true, force: true });
        }
    } catch (e) {}
    try {
        fs.mkdirSync(authDir, { recursive: true });
    } catch (e) {}
}

async function connectToWhatsApp() {
    await closeCurrentSocket();

    if (!fs.existsSync(authDir)) {
        fs.mkdirSync(authDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    
    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        defaultQueryTimeoutMs: 60000
    });

    sock.ev.on('creds.update', async () => {
        try {
            if (!fs.existsSync(authDir)) {
                fs.mkdirSync(authDir, { recursive: true });
            }
            await saveCreds();
        } catch (e) {}
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // Capture QR code if in QR mode
        if (qr && connectionMode === 'qr') {
            try {
                currentQR = await QRCode.toDataURL(qr, { width: 280, margin: 2 });
                console.log('[WhatsApp Gateway] QR code generated.');
            } catch (e) { console.error('[QR Error]:', e.message); }
        }

        // If not registered and pairing phone exists, request pairing code
        if (pairingPhone && !sock.authState.creds.registered && !pairingCodeRequested) {
            pairingCodeRequested = true;
            setTimeout(async () => {
                try {
                    if (sock && !sock.authState.creds.registered) {
                        const code = await sock.requestPairingCode(pairingPhone);
                        currentPairingCode = code;
                        console.log(`[Pairing Code Generated]: ${code} for ${pairingPhone}`);
                    }
                } catch (err) {
                    console.error('[Pairing Error]:', err.message);
                    pairingCodeRequested = false;
                }
            }, 1500);
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            const isLoggedOut = statusCode === DisconnectReason.loggedOut;
            connectionState = 'close';
            
            console.log(`[WhatsApp Gateway] Disconnected (Code: ${statusCode}).`);
            if (isLoggedOut || statusCode === 401) {
                console.log('[WhatsApp Gateway] Session invalid or logged out. Resetting auth credentials...');
                clearAuthDir();
                currentPairingCode = null;
                pairingCodeRequested = false;
            }

            // Reconnect if not replaced (Fast 500ms delay for 515 restartRequired)
            if (statusCode !== DisconnectReason.connectionReplaced) {
                const delay = statusCode === DisconnectReason.restartRequired ? 500 : 2500;
                reconnectTimer = setTimeout(() => connectToWhatsApp(), delay);
            }
        } else if (connection === 'open') {
            connectionState = 'open';
            currentPairingCode = null;
            currentQR = null;
            pairingCodeRequested = false;
            console.log(`[WhatsApp Gateway] [OK] WhatsApp Connected Successfully as ${sock?.user?.id || 'User'}!`);
        }
    });
}

// API: Connect via QR code
app.post('/api/connect-qr', async (req, res) => {
    connectionMode = 'qr';
    pairingCodeRequested = false;
    currentPairingCode = null;
    currentQR = null;
    connectionState = 'close';

    await closeCurrentSocket();
    try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (e) {}
    await connectToWhatsApp();

    // Wait up to 8 seconds for QR to generate
    let elapsed = 0;
    const interval = setInterval(() => {
        elapsed += 400;
        if (currentQR || elapsed >= 8000) {
            clearInterval(interval);
            res.json({ success: true, qr: currentQR });
        }
    }, 400);
});

// API: Get current QR code
app.get('/api/qr', async (req, res) => {
    res.json({ qr: currentQR, connected: connectionState === 'open' && !!(sock && sock.user) });
});

// Serve Frontend UI
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API: Get current status & pairing code
app.get('/api/status', (req, res) => {
    // Verified connected ONLY if state is open AND sock.user exists
    const isReallyConnected = connectionState === 'open' && !!(sock && sock.user);
    res.json({
        state: isReallyConnected ? 'open' : 'close',
        connected: isReallyConnected,
        code: currentPairingCode,
        phone: pairingPhone
    });
});

// API: User sets/changes mobile number and requests code
app.post('/api/connect', async (req, res) => {
    let phone = (req.body.phone || '').replace(/[^\d]/g, '');
    if (!phone) {
        return res.status(400).json({ error: 'Please enter a valid phone number.' });
    }
    if (phone.length === 10) {
        phone = '91' + phone; // Auto prepend India country code
    }

    pairingPhone = phone;
    setEnv('SENDER_PHONE_NUMBER', phone);
    pairingCodeRequested = false;
    currentPairingCode = null;
    connectionState = 'close';

    // Reset auth credentials for fresh clean pairing
    await closeCurrentSocket();
    try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (e) {}
    await connectToWhatsApp();

    // Poll for the pairing code up to 6 seconds
    let elapsed = 0;
    const checkInterval = setInterval(() => {
        elapsed += 500;
        if (currentPairingCode || (connectionState === 'open' && sock && sock.user) || elapsed >= 6000) {
            clearInterval(checkInterval);
            return res.json({
                success: true,
                phone: pairingPhone,
                code: currentPairingCode,
                state: connectionState
            });
        }
    }, 500);
});

// API: Re-link / reset session explicitly
app.post('/api/reset', async (req, res) => {
    await closeCurrentSocket();
    connectionState = 'close';
    currentPairingCode = null;
    pairingCodeRequested = false;
    try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (e) {}
    await connectToWhatsApp();

    let elapsed = 0;
    const checkInterval = setInterval(() => {
        elapsed += 500;
        if (currentPairingCode || elapsed >= 6000) {
            clearInterval(checkInterval);
            return res.json({ success: true, code: currentPairingCode });
        }
    }, 500);
});

// API: Streaming Campaign Dispatcher (Server-Sent Events)
app.get('/api/stream-campaign', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const isReallyConnected = connectionState === 'open' && !!(sock && sock.user);
    if (!isReallyConnected) {
        res.write(`data: ${JSON.stringify({ type: 'error', text: '[Error] WhatsApp is NOT connected! Please enter your phone number above and link it with the pairing code.' })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'finish', exitCode: 1 })}\n\n`);
        return res.end();
    }

    res.write(`data: ${JSON.stringify({ type: 'log', text: 'Starting campaign dispatch process...' })}\n\n`);

    const pythonCmd = process.platform === 'win32' ? 'python' : (process.env.PYTHON_CMD || 'python3');
    const py = spawn(pythonCmd, ['-u', 'send_campaign.py'], {
        cwd: __dirname,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }
    });

    py.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        res.write(`data: ${JSON.stringify({ type: 'log', text })}\n\n`);
    });

    py.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        res.write(`data: ${JSON.stringify({ type: 'error', text })}\n\n`);
    });

    py.on('close', (exitCode) => {
        res.write(`data: ${JSON.stringify({ type: 'finish', exitCode })}\n\n`);
        res.end();
    });
});

// Backward compatibility endpoints for send_campaign.py
app.get('/instance/pairingCode', (req, res) => {
    const isReallyConnected = connectionState === 'open' && !!(sock && sock.user);
    res.json({ state: isReallyConnected ? 'open' : 'close', code: currentPairingCode, phone: pairingPhone });
});
app.get('/instance/fetchInstances', (req, res) => {
    res.json([{ name: 'campaign_instance' }]);
});
app.post('/instance/create', (req, res) => {
    res.json({ instance: { name: 'campaign_instance' } });
});
app.get('/instance/connectionState/:instanceName', (req, res) => {
    const isReallyConnected = connectionState === 'open' && !!(sock && sock.user);
    res.json({ instance: { state: isReallyConnected ? 'open' : 'close' } });
});

app.post('/message/sendMedia/:instanceName', async (req, res) => {
    const { number, caption, media, fileName } = req.body;
    if (connectionState !== 'open' || !sock || !sock.user) {
        return res.status(400).json({ error: 'WhatsApp session is not active. Please re-link your device.' });
    }

    try {
        const cleanNum = number.replace(/[^\d]/g, '');
        const jid = `${cleanNum}@s.whatsapp.net`;
        const buffer = Buffer.from(media, 'base64');
        const sentMsg = await sock.sendMessage(jid, {
            image: buffer,
            caption: caption || '',
            fileName: fileName || 'campaign.jpg'
        });
        res.json({ key: { id: sentMsg.key.id } });
    } catch (err) {
        console.error('[Error sending message]:', err);
        res.status(500).json({ error: err.message });
    }
});

// API: Upload Excel recipients file
app.post('/api/upload/excel', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    res.json({ success: true, filename: req.file.originalname, saved: 'recipients.xlsx' });
});

// API: Delete Excel recipients file
app.delete('/api/delete-excel', (req, res) => {
    try {
        const exPath = path.join(__dirname, 'recipients.xlsx');
        if (fs.existsSync(exPath)) fs.unlinkSync(exPath);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// API: Check status of files
app.get('/api/files-status', (req, res) => {
    const exPath = path.join(__dirname, 'recipients.xlsx');
    const imPath = path.join(__dirname, 'campaign.jpg');
    res.json({
        excelExists: fs.existsSync(exPath),
        imageExists: fs.existsSync(imPath)
    });
});

// API: Send text message when image is not attached
app.post('/message/sendText/:instanceName', async (req, res) => {
    const { number, text } = req.body;
    if (connectionState !== 'open' || !sock || !sock.user) {
        return res.status(400).json({ error: 'WhatsApp session is not active. Please re-link your device.' });
    }

    try {
        const cleanNum = number.replace(/[^\d]/g, '');
        const jid = `${cleanNum}@s.whatsapp.net`;
        const sentMsg = await sock.sendMessage(jid, { text: text || '' });
        res.json({ key: { id: sentMsg.key.id } });
    } catch (err) {
        console.error('[Error sending text message]:', err);
        res.status(500).json({ error: err.message });
    }
});

// API: Upload campaign image
app.post('/api/upload/image', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    res.json({ success: true, filename: req.file.originalname, saved: 'campaign.jpg' });
});

// API: Save message text
app.post('/api/save-message', (req, res) => {
    const { message } = req.body;
    if (typeof message !== 'string') return res.status(400).json({ error: 'Invalid message.' });
    fs.writeFileSync(path.join(__dirname, 'message.txt'), message, 'utf8');
    res.json({ success: true });
});

// API: Get current message text
app.get('/api/get-message', (req, res) => {
    try {
        const msg = fs.readFileSync(path.join(__dirname, 'message.txt'), 'utf8');
        res.json({ message: msg });
    } catch (e) {
        res.json({ message: 'Hello {{name}},\n' });
    }
});

// API: Get campaign image as base64 for preview
app.get('/api/preview-image', (req, res) => {
    try {
        const imgPath = path.join(__dirname, 'campaign.jpg');
        if (!fs.existsSync(imgPath)) return res.json({ image: null });
        const data = fs.readFileSync(imgPath);
        res.json({ image: 'data:image/jpeg;base64,' + data.toString('base64') });
    } catch (e) {
        res.json({ image: null });
    }
});

// API: Delete campaign image
app.delete('/api/delete-image', (req, res) => {
    try {
        const imgPath = path.join(__dirname, 'campaign.jpg');
        if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 8085;
app.listen(PORT, () => {
    console.log(`[WhatsApp Gateway] Server running on port ${PORT}`);
    connectToWhatsApp();
});
