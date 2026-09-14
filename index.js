/**
 * Apex Prime — Dedicated WhatsApp Notification Bot (Cloud / Render Edition)
 * 
 * Lightweight 24/7 notification microservice powered by @whiskeysockets/baileys.
 * Runs seamlessly on Render, Railway, VPS, or local server.
 */

// 1. Polyfill crypto for Node.js
try {
    const nodeCrypto = require('crypto');
    if (!globalThis.crypto) globalThis.crypto = nodeCrypto.webcrypto || nodeCrypto;
    if (!globalThis.crypto.subtle && nodeCrypto.webcrypto?.subtle) {
        globalThis.crypto.subtle = nodeCrypto.webcrypto.subtle;
    }
} catch (e) {}

const path = require('path');
const fs = require('fs');
const http = require('http');
const pino = require('pino');
let QRCode = null;
try { QRCode = require('qrcode'); } catch (e) {}

// Global State
const AUTH_DIR = path.resolve(__dirname, 'auth_info_baileys');
let botStatus = 'starting'; // 'starting' | 'scan_qr' | 'connected' | 'reconnecting'
let connectedPhone = null;
let currentSocket = null;
let currentQrDataUrl = null;
let currentQrRaw = null;
let activePairingCode = null;
let activePairingPhone = null;
let pendingPairingPhone = null;
let pendingPairingResolve = null;
let pendingPairingReject = null;
const activityLogs = [];

function logActivity(msg) {
    const time = new Date().toLocaleTimeString('en-GB');
    const entry = `[${time}] ${msg}`;
    console.log(entry);
    activityLogs.unshift(entry);
    if (activityLogs.length > 50) activityLogs.pop();
}

// 2. Format phone numbers to WhatsApp JID format
function formatWhatsAppJid(phone) {
    let clean = String(phone).replace(/[^0-9]/g, '');
    if (clean.length === 10 && clean.startsWith('0')) {
        clean = '233' + clean.slice(1);
    } else if (clean.length === 9) {
        clean = '233' + clean;
    }
    return clean + '@s.whatsapp.net';
}

// 3. Baileys Dynamic Loader
let makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers;

async function loadBaileys() {
    let baileys;
    try {
        baileys = require('@whiskeysockets/baileys');
    } catch (err) {
        if (err.code === 'ERR_REQUIRE_ESM' || err.message?.includes('ES Module')) {
            baileys = await import('@whiskeysockets/baileys');
        } else {
            throw err;
        }
    }
    makeWASocket = baileys.default?.default || baileys.default || baileys.makeWASocket;
    useMultiFileAuthState = baileys.useMultiFileAuthState;
    DisconnectReason = baileys.DisconnectReason;
    fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion;
    Browsers = baileys.Browsers;
}

// 4. Start WhatsApp Bot
async function startBot() {
    if (!makeWASocket) await loadBaileys();

    if (currentSocket) {
        try {
            currentSocket.ev.removeAllListeners();
            currentSocket.ws?.terminate();
        } catch (e) {}
        currentSocket = null;
    }

    logActivity('Initializing Baileys session...');
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    let version = [2, 3000, 1047444420];
    try {
        if (fetchLatestBaileysVersion) {
            const vInfo = await fetchLatestBaileysVersion();
            if (vInfo?.version) version = vInfo.version;
        }
    } catch (e) {}

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        browser: Browsers ? Browsers.macOS('Desktop') : ['Ubuntu', 'Chrome', '124.0.0.0'],
        syncFullHistory: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        retryRequestDelayMs: 2000
    });

    currentSocket = sock;

    sock.ev.on('creds.update', async () => {
        try { await saveCreds(); } catch (e) {}
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            currentQrRaw = qr;
            botStatus = 'scan_qr';

            // Check if phone pairing was requested
            if (pendingPairingPhone && pendingPairingResolve) {
                const pPhone = pendingPairingPhone;
                const resolve = pendingPairingResolve;
                pendingPairingPhone = null;
                pendingPairingResolve = null;
                pendingPairingReject = null;

                try {
                    logActivity(`Requesting pairing code for +${pPhone}...`);
                    let code = await sock.requestPairingCode(pPhone);
                    code = String(code).trim();
                    if (code.length === 8 && !code.includes('-')) {
                        code = code.slice(0, 4) + '-' + code.slice(4);
                    }
                    activePairingCode = code;
                    activePairingPhone = pPhone;
                    logActivity(`Pairing code generated: ${code}`);
                    resolve(code);
                } catch (err) {
                    logActivity(`Pairing error: ${err.message}`);
                    if (pendingPairingReject) pendingPairingReject(err);
                }
                return;
            }

            // Normal QR generation
            if (QRCode) {
                QRCode.toDataURL(qr, { scale: 8 }, (err, url) => {
                    if (!err && url) currentQrDataUrl = url;
                });
            } else {
                currentQrDataUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=260x260&margin=10&data=' + encodeURIComponent(qr);
            }
            logActivity('New QR Code generated. Scan to connect.');
        }

        if (connection === 'close') {
            botStatus = 'reconnecting';
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            const isRegistered = Boolean(state.creds?.registered);
            logActivity(`Connection closed (code: ${statusCode}, registered: ${isRegistered})`);

            try { await saveCreds(); } catch (e) {}

            const isRestartRequired = (statusCode === DisconnectReason.restartRequired || statusCode === 515);
            const isActualLogout = isRegistered && (statusCode === DisconnectReason.loggedOut) && !isRestartRequired;

            if (isActualLogout) {
                logActivity('Device logged out. Resetting session...');
                try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) {}
                connectedPhone = null;
                currentQrDataUrl = null;
                activePairingCode = null;
                setTimeout(() => startBot().catch(e => console.error(e)), 2000);
            } else {
                const retryDelay = isRestartRequired ? 200 : (statusCode === 440 ? 4000 : 2000);
                setTimeout(() => startBot().catch(e => console.error(e)), retryDelay);
            }
        } else if (connection === 'open') {
            botStatus = 'connected';
            currentQrDataUrl = null;
            currentQrRaw = null;
            activePairingCode = null;
            connectedPhone = sock.user?.id ? sock.user.id.split(':')[0] : 'Online';
            logActivity(`✅ WhatsApp Notification Bot CONNECTED as +${connectedPhone}`);
        }
    });

    return sock;
}

// 5. HTTP Web Dashboard & REST API
function createWebServer() {
    const server = http.createServer(async (req, res) => {
        const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const pathname = urlObj.pathname;
        const method = req.method.toUpperCase();

        // Helper: send JSON response
        const sendJson = (statusCode, data) => {
            res.writeHead(statusCode, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
            });
            res.end(JSON.stringify(data));
        };

        // Handle CORS Pre-flight
        if (method === 'OPTIONS') {
            res.writeHead(204, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
            });
            return res.end();
        }

        // Helper: read POST body
        const readBody = () => {
            return new Promise((resolve) => {
                let body = '';
                req.on('data', chunk => { body += chunk; });
                req.on('end', () => {
                    try { resolve(JSON.parse(body || '{}')); }
                    catch (e) {
                        const q = new URLSearchParams(body);
                        const obj = {};
                        for (const [k, v] of q.entries()) obj[k] = v;
                        resolve(obj);
                    }
                });
            });
        };

        // ── API: Health & Status ──
        if (pathname === '/api/status' && method === 'GET') {
            return sendJson(200, {
                success: true,
                status: botStatus,
                phone: connectedPhone,
                has_qr: Boolean(currentQrDataUrl),
                qr: currentQrDataUrl,
                uptime_seconds: Math.floor(process.uptime())
            });
        }

        // ── API: Send Outbound WhatsApp Notification ──
        if (pathname === '/api/send-message' && method === 'POST') {
            const body = await readBody();
            const rawPhone = body.phone || body.recipient;
            const message = body.message || body.text;

            if (!rawPhone || !message) {
                return sendJson(400, { success: false, message: 'Missing phone or message parameter.' });
            }

            if (botStatus !== 'connected' || !currentSocket) {
                return sendJson(503, {
                    success: false,
                    status: botStatus,
                    message: 'Notification bot is not connected to WhatsApp yet.'
                });
            }

            try {
                const jid = formatWhatsAppJid(rawPhone);
                const sendRes = await currentSocket.sendMessage(jid, { text: String(message).trim() });
                const cleanNum = jid.replace(/@.+/, '');
                logActivity(`Sent message to +${cleanNum} (Msg ID: ${sendRes?.key?.id || 'OK'})`);
                return sendJson(200, {
                    success: true,
                    provider: 'baileys_notification_bot',
                    message_id: sendRes?.key?.id,
                    recipient: cleanNum
                });
            } catch (err) {
                logActivity(`Send error to ${rawPhone}: ${err.message}`);
                return sendJson(500, { success: false, message: err.message });
            }
        }

        // ── API: Request Pairing Code (Link with Phone Number) ──
        if (pathname === '/api/request-pairing-code' && method === 'POST') {
            const body = await readBody();
            let pPhone = String(body.phone || '').replace(/[^0-9]/g, '');
            if (pPhone.startsWith('0') && pPhone.length === 10) pPhone = '233' + pPhone.slice(1);

            if (!pPhone || pPhone.length < 9) {
                return sendJson(400, { success: false, message: 'Invalid phone number.' });
            }

            if (botStatus === 'connected') {
                return sendJson(400, { success: false, message: `Already connected to +${connectedPhone}. Unlink first to re-pair.` });
            }

            if (!currentSocket) {
                return sendJson(503, { success: false, message: 'Bot socket is initializing, please retry in a few seconds.' });
            }

            // If QR code is already available, request pairing code directly
            try {
                logActivity(`Requesting pairing code for +${pPhone}...`);
                let code = await currentSocket.requestPairingCode(pPhone);
                code = String(code).trim();
                if (code.length === 8 && !code.includes('-')) {
                    code = code.slice(0, 4) + '-' + code.slice(4);
                }
                activePairingCode = code;
                activePairingPhone = pPhone;
                return sendJson(200, { success: true, pairing_code: code, phone: pPhone });
            } catch (err) {
                // If not in QR state, queue for next QR update
                return new Promise((resResolve) => {
                    pendingPairingPhone = pPhone;
                    pendingPairingResolve = (code) => resResolve(sendJson(200, { success: true, pairing_code: code, phone: pPhone }));
                    pendingPairingReject = (err) => resResolve(sendJson(500, { success: false, message: err.message }));
                    setTimeout(() => {
                        if (pendingPairingPhone === pPhone) {
                            pendingPairingPhone = null;
                            resResolve(sendJson(504, { success: false, message: 'Timeout waiting for WhatsApp pairing handshake.' }));
                        }
                    }, 30000);
                });
            }
        }

        // ── API: Logout / Unlink ──
        if ((pathname === '/api/logout' && method === 'POST') || pathname === '/unlink') {
            logActivity('Manual unlink requested. Clearing credentials...');
            try {
                if (currentSocket) {
                    currentSocket.ev.removeAllListeners();
                    currentSocket.ws?.terminate();
                }
            } catch (e) {}
            try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) {}
            botStatus = 'starting';
            connectedPhone = null;
            currentQrDataUrl = null;
            activePairingCode = null;
            setTimeout(() => startBot().catch(e => console.error(e)), 1000);

            if (pathname === '/unlink') {
                res.writeHead(302, { 'Location': '/?unlinked=1' });
                return res.end();
            }
            return sendJson(200, { success: true, message: 'Bot unlinked successfully.' });
        }

        // ── WEB DASHBOARD UI (HTML) ──
        if (pathname === '/' && method === 'GET') {
            const isConnected = (botStatus === 'connected' && connectedPhone);
            const qrImageSrc = currentQrDataUrl || '';
            const statusBadgeClass = isConnected ? 'status-connected' : (botStatus === 'scan_qr' ? 'status-scan' : 'status-reconnect');
            const statusText = isConnected ? `ONLINE (+${connectedPhone})` : (botStatus === 'scan_qr' ? 'WAITING FOR SCAN' : botStatus.toUpperCase());

            const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Apex Prime — WhatsApp Notification Bot</title>
    ${!isConnected ? '<meta http-equiv="refresh" content="8">' : ''}
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #0b141a; color: #e9edef; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; min-height: 100vh; padding: 30px 15px; display: flex; justify-content: center; }
        .container { width: 100%; max-width: 620px; }
        .card { background: #111b21; border: 1px solid #202c33; border-radius: 12px; padding: 25px; margin-bottom: 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
        h1 { font-size: 20px; font-weight: 600; color: #e9edef; display: flex; align-items: center; gap: 8px; }
        .badge { padding: 5px 12px; border-radius: 20px; font-size: 11px; font-weight: 700; letter-spacing: 0.5px; text-transform: uppercase; display: inline-flex; align-items: center; gap: 6px; }
        .badge::before { content: ""; width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
        .status-connected { background: rgba(37, 211, 102, 0.15); color: #25d366; }
        .status-connected::before { background: #25d366; box-shadow: 0 0 8px #25d366; }
        .status-scan { background: rgba(245, 158, 11, 0.15); color: #f59e0b; }
        .status-scan::before { background: #f59e0b; }
        .status-reconnect { background: rgba(134, 150, 160, 0.15); color: #8696a0; }
        .status-reconnect::before { background: #8696a0; }
        .btn { display: inline-flex; align-items: center; justify-content: center; padding: 10px 18px; border-radius: 8px; font-size: 13px; font-weight: 600; text-decoration: none; cursor: pointer; border: none; transition: 0.15s; }
        .btn-unlink { background: #dc2626; color: #fff; }
        .btn-unlink:hover { background: #b91c1c; }
        .btn-primary { background: #00a884; color: #fff; }
        .btn-primary:hover { background: #008f6f; }
        .qr-box { text-align: center; padding: 20px 10px; }
        .qr-img { background: #fff; padding: 12px; border-radius: 10px; width: 260px; height: 260px; box-shadow: 0 4px 15px rgba(0,0,0,0.4); margin: 15px 0; }
        .input-group { display: flex; gap: 10px; margin-top: 15px; }
        .input-field { flex: 1; background: #202c33; border: 1px solid #2a3942; border-radius: 8px; padding: 10px 14px; color: #e9edef; font-size: 13px; outline: none; }
        .input-field:focus { border-color: #00a884; }
        .code-display { font-size: 24px; font-weight: 700; color: #25d366; letter-spacing: 4px; background: #202c33; padding: 12px; border-radius: 8px; margin-top: 12px; text-align: center; }
        .log-box { background: #0a1014; border: 1px solid #202c33; border-radius: 8px; padding: 12px; font-family: Consolas, monospace; font-size: 11px; color: #8696a0; max-height: 180px; overflow-y: auto; white-space: pre-wrap; line-height: 1.5; }
        .desc { font-size: 13px; color: #8696a0; line-height: 1.4; margin-bottom: 15px; }
        .alert { background: rgba(37, 211, 102, 0.1); border: 1px solid rgba(37, 211, 102, 0.3); color: #25d366; padding: 12px 16px; border-radius: 8px; margin-bottom: 15px; font-size: 13px; }
    </style>
</head>
<body>
<div class="container">

    <!-- Header Card -->
    <div class="card">
        <div class="header">
            <div>
                <h1>📢 WhatsApp Notification Bot</h1>
                <p style="font-size:12px; color:#8696a0; margin-top:4px;">Apex Prime Dedicated 24/7 Cloud Dispatcher</p>
            </div>
            <div class="badge ${statusBadgeClass}">${statusText}</div>
        </div>
        <p class="desc">This dedicated bot handles customer order delivery notifications, wallet top-up receipts, and transaction updates for <strong>apexprime.club</strong>.</p>
        
        ${isConnected ? `
        <div style="display:flex; justify-content:space-between; align-items:center; background:#202c33; padding:12px 16px; border-radius:8px;">
            <div>
                <div style="font-size:12px; color:#8696a0;">Connected Phone Number</div>
                <div style="font-size:16px; font-weight:700; color:#25d366; margin-top:2px;">+${connectedPhone}</div>
            </div>
            <a href="/unlink" class="btn btn-unlink" onclick="return confirm('Disconnect this WhatsApp account?')">Disconnect Account</a>
        </div>
        ` : ''}
    </div>

    <!-- Connection Card (When not connected) -->
    ${!isConnected ? `
    <div class="card">
        <h2 style="font-size:16px; margin-bottom:10px;">Link Your WhatsApp</h2>
        <p class="desc">Scan the QR code below or generate an 8-digit Pairing Code with your phone number:</p>

        ${qrImageSrc ? `
        <div class="qr-box">
            <img src="${qrImageSrc}" class="qr-img" alt="WhatsApp QR Code">
            <p style="font-size:12px; color:#8696a0;">Open WhatsApp > Linked Devices > Link a Device > Scan QR</p>
        </div>
        ` : `
        <div style="text-align:center; padding:30px; color:#f59e0b;">
            ⏳ Initializing WhatsApp session... Refreshing in a few seconds...
        </div>
        `}

        <div style="border-top:1px solid #202c33; padding-top:20px; margin-top:10px;">
            <div style="font-size:13px; font-weight:600; color:#e9edef;">Or Link with Phone Number (Pairing Code):</div>
            <form onsubmit="requestPairing(event)">
                <div class="input-group">
                    <input type="text" id="pairingPhone" class="input-field" placeholder="E.g. 233204411637 or 0559623850" required>
                    <button type="submit" class="btn btn-primary">Get Pairing Code</button>
                </div>
            </form>
            <div id="pairingResult" style="display:none;" class="code-display"></div>
        </div>
    </div>
    ` : `
    <!-- Test Notification Sender (When connected) -->
    <div class="card">
        <h2 style="font-size:15px; margin-bottom:10px;">Send Test Notification</h2>
        <form onsubmit="sendTest(event)">
            <div style="margin-bottom:10px;">
                <input type="text" id="testPhone" class="input-field" style="width:100%;" placeholder="Recipient Phone (e.g. 0559623850)" required>
            </div>
            <div style="margin-bottom:12px;">
                <textarea id="testMsg" class="input-field" style="width:100%; height:70px;" placeholder="Message text" required>Hello from Apex Prime Notification Bot! 🚀</textarea>
            </div>
            <button type="submit" class="btn btn-primary" style="width:100%;">Dispatch Notification</button>
        </form>
        <div id="testStatus" style="margin-top:10px; font-size:13px;"></div>
    </div>
    `}

    <!-- Activity Log -->
    <div class="card">
        <h2 style="font-size:14px; margin-bottom:10px; color:#8696a0; text-transform:uppercase; letter-spacing:0.5px;">Live Activity Log</h2>
        <div class="log-box">${activityLogs.join('\n') || 'No activity recorded yet.'}</div>
    </div>

</div>

<script>
async function requestPairing(e) {
    e.preventDefault();
    const phone = document.getElementById('pairingPhone').value.trim();
    const resDiv = document.getElementById('pairingResult');
    resDiv.style.display = 'block';
    resDiv.textContent = 'Generating...';
    try {
        const r = await fetch('/api/request-pairing-code', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone })
        });
        const data = await r.json();
        if (data.success) {
            resDiv.textContent = data.pairing_code;
        } else {
            resDiv.textContent = 'Error: ' + data.message;
        }
    } catch (err) {
        resDiv.textContent = 'Error: ' + err.message;
    }
}

async function sendTest(e) {
    e.preventDefault();
    const phone = document.getElementById('testPhone').value.trim();
    const message = document.getElementById('testMsg').value.trim();
    const stDiv = document.getElementById('testStatus');
    stDiv.textContent = 'Sending...';
    try {
        const r = await fetch('/api/send-message', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone, message })
        });
        const data = await r.json();
        if (data.success) {
            stDiv.innerHTML = '<span style="color:#25d366;">✅ Message delivered successfully! (ID: ' + (data.message_id || 'OK') + ')</span>';
        } else {
            stDiv.innerHTML = '<span style="color:#ef4444;">❌ ' + data.message + '</span>';
        }
    } catch (err) {
        stDiv.innerHTML = '<span style="color:#ef4444;">❌ ' + err.message + '</span>';
    }
}
</script>
</body>
</html>`;
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(html);
        }

        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    });

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
        logActivity(`HTTP Notification Server listening on port ${PORT}`);
    });
}

// 6. Bootstrap Bot & Server
async function main() {
    createWebServer();
    try {
        await startBot();
    } catch (err) {
        logActivity(`Startup Error: ${err.message}`);
    }
}

main();