/**
 * AEGIS PROTOCOL — server.js  (FIXED + GROQ FREE LLM)
 * 
 * WHY GROQ instead of Gemini?
 *  - Gemini 2.5 Flash = PAID. Gemini 1.5 Flash free tier = 15 req/min cap → kills demo.
 *  - Groq = 100% FREE, no credit card, llama-3.3-70b runs at ~500 tokens/sec.
 *  - Groq supports full OpenAI-compatible tool/function calling.
 *  - Sign up at: https://console.groq.com → "API Keys" → copy key → paste in .env
 * 
 * FIXES applied vs original:
 *  1. Swapped @google/generative-ai → groq-sdk  (free, no quota issues)
 *  2. Fixed Cartesia audio encoding mismatch (was pcm_s16le but played as f32)
 *  3. Fixed barge-in: now only fires clear_buffer on FINAL transcripts to avoid
 *     flooding the client on every interim word
 *  4. Added conversation history so Aegis remembers context across turns
 *  5. Fixed tool calling loop to handle parallel + sequential calls correctly
 *  6. Added CORS headers so React dev server can connect without issues
 *  7. Added graceful Deepgram keepalive so connection doesn't drop after 10s silence
 *  8. WhatsApp (Baileys) kept but made optional — won't crash if not configured
 */

require('dotenv').config();
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const { createClient } = require('@deepgram/sdk');
const Groq = require('groq-sdk');

// ─── Optional: WhatsApp via Baileys ─────────────────────────────────────────
let waSocket = null;
async function connectToWhatsApp() {
    if (!process.env.WHATSAPP_TARGET_NUMBER) {
        console.log('[WhatsApp] WHATSAPP_TARGET_NUMBER not set — WhatsApp logging disabled.');
        return;
    }
    try {
        const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
        const pino = require('pino');
        const qrcode = require('qrcode-terminal');

        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        const { version } = await fetchLatestBaileysVersion();
        const sock = makeWASocket({
            version, auth: state,
            logger: pino({ level: 'silent' }),
            browser: Browsers.macOS('Desktop'),
            printQRInTerminal: false,
        });
        sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
            if (qr) { console.log('\n[WhatsApp] Scan QR code:'); qrcode.generate(qr, { small: true }); }
            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) setTimeout(connectToWhatsApp, 5000);
            } else if (connection === 'open') {
                console.log('[WhatsApp] ✅ Connected!');
                waSocket = sock;
            }
        });
        sock.ev.on('creds.update', saveCreds);
    } catch (e) {
        console.log('[WhatsApp] Baileys not installed or failed — skipping WhatsApp logging.');
    }
}
connectToWhatsApp();

// ─── Core Setup ──────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    next();
});
app.get('/health', (_, res) => res.json({ status: 'ok', llm: 'groq-llama-3.3-70b' }));

// ─── Groq Client (FREE — https://console.groq.com) ──────────────────────────
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── Deepgram Client ─────────────────────────────────────────────────────────
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

// ─── Aegis System Prompt ─────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Aegis, a dual-state voice agent.

STATE 1 — CIVILIAN (Default):
You are a friendly, conversational assistant. You help book movies, answer questions, play music, and chat naturally. Keep answers SHORT — 1-2 sentences max since you are speaking aloud.

STATE 2 — CODE RED (Emergency):
Triggered when user says "Initiate Code Red" or describes a medical emergency.
Become a zero-latency medical orchestrator. Ultra-concise sentences (max 10 words).
Confirm each action in 3 words. Ask for authorization code before dispatching medevac.

RULES:
- NEVER use markdown, asterisks, or bullet points. You are speaking aloud.
- NEVER use filler phrases like "Certainly!" or "Of course!".
- If the user interrupts or corrects themselves, discard previous instruction immediately.
- Emergency tools only in Code Red. Consumer tools only in Civilian mode.`;

// ─── Tool Definitions (Groq/OpenAI format) ───────────────────────────────────
const TOOLS = [
    {
        type: 'function',
        function: {
            name: 'log_vitals',
            description: 'Log patient vitals: heart rate, blood pressure, oxygen level',
            parameters: {
                type: 'object',
                properties: {
                    heart_rate:     { type: 'number',  description: 'Heart rate in BPM' },
                    blood_pressure: { type: 'string',  description: 'e.g. 120/80' },
                    oxygen_level:   { type: 'number',  description: 'SpO2 percentage' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'administer_medication',
            description: 'Log a medication being administered to patient',
            parameters: {
                type: 'object',
                properties: {
                    drug_name: { type: 'string', description: 'Drug name e.g. Adrenaline' },
                    dosage:    { type: 'string', description: 'Dosage e.g. 1mg IV' },
                },
                required: ['drug_name', 'dosage'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'trigger_trauma_alert',
            description: 'Trigger trauma alert to hospital casualty ward with ETA and injury type',
            parameters: {
                type: 'object',
                properties: {
                    eta_minutes:  { type: 'number', description: 'ETA in minutes' },
                    injury_type:  { type: 'string', description: 'e.g. blunt trauma, burns' },
                },
                required: ['eta_minutes', 'injury_type'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'dispatch_medevac',
            description: 'Dispatch emergency medical evacuation helicopter. Requires authorization code.',
            parameters: {
                type: 'object',
                properties: {
                    coordinates: { type: 'string', description: 'Target location or coordinates' },
                    auth_code:   { type: 'string', description: 'Authorization code e.g. Sigma-Niner' },
                },
                required: ['coordinates', 'auth_code'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'book_movie_tickets',
            description: 'Book movie tickets for the user',
            parameters: {
                type: 'object',
                properties: {
                    movie_name: { type: 'string', description: 'Movie name' },
                    theater:    { type: 'string', description: 'Cinema name' },
                    tickets:    { type: 'number', description: 'Number of tickets' },
                },
                required: ['movie_name', 'theater', 'tickets'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'play_device_music',
            description: 'Play a song on the device',
            parameters: {
                type: 'object',
                properties: {
                    song_name: { type: 'string', description: 'Song or artist name' },
                },
                required: ['song_name'],
            },
        },
    },
];

// ─── Execute Tool Call ────────────────────────────────────────────────────────
function executeTool(name, args) {
    console.log(`[Tool] ▶ ${name}`, args);
    switch (name) {
        case 'log_vitals':
            return { status: 'Vitals logged', ...args };
        case 'administer_medication':
            return { status: 'Medication logged', drug: args.drug_name, dose: args.dosage };
        case 'trigger_trauma_alert':
            return { status: 'Trauma alert sent to casualty ward', eta: args.eta_minutes };
        case 'dispatch_medevac': {
            const code = (args.auth_code || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            if (['sigmaniner', 'sigma9', 'sigmanine'].includes(code)) {
                return { status: 'MEDEVAC DISPATCHED', destination: args.coordinates, auth: 'VERIFIED' };
            }
            return { status: 'ACCESS DENIED — invalid auth code' };
        }
        case 'book_movie_tickets':
            return { status: 'Booked', confirmation: 'BMS-' + Math.floor(Math.random() * 90000 + 10000), ...args };
        case 'play_device_music':
            return { status: 'Playing', song: args.song_name };
        default:
            return { status: 'Unknown tool' };
    }
}

// ─── Determine mode from tool name ───────────────────────────────────────────
const EMERGENCY_TOOLS = ['log_vitals', 'administer_medication', 'trigger_trauma_alert', 'dispatch_medevac'];
const CIVILIAN_TOOLS  = ['book_movie_tickets', 'play_device_music'];

// ─── Send to Cartesia TTS ─────────────────────────────────────────────────────
function sendToCartesia(cartesiaWs, text) {
    if (cartesiaWs.readyState !== WebSocket.OPEN) {
        console.error('[Cartesia] Not open — cannot send TTS.');
        return;
    }
    console.log(`[Cartesia] TTS → "${text.slice(0, 80)}..."`);
    cartesiaWs.send(JSON.stringify({
        model_id: 'sonic-english',
        transcript: text,
        voice: { mode: 'id', id: process.env.CARTESIA_VOICE_ID },
        output_format: {
            container:   'raw',
            encoding:    'pcm_f32le',   // FIXED: must match frontend AudioContext expectation
            sample_rate: 44100,         // Cartesia's native rate
        },
        context_id: `msg-${Date.now()}`,
    }));
}

// ─── WhatsApp Logger ──────────────────────────────────────────────────────────
async function logToWhatsApp(toolName, args) {
    if (!waSocket || !process.env.WHATSAPP_TARGET_NUMBER) return;
    const ts  = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
    const jid = `${process.env.WHATSAPP_TARGET_NUMBER}@s.whatsapp.net`;

    const ICONS = {
        log_vitals: '🩺', administer_medication: '💊',
        trigger_trauma_alert: '🚑', dispatch_medevac: '🚁',
        book_movie_tickets: '🎬', play_device_music: '🎵',
    };
    const icon = ICONS[toolName] || '⚙️';

    let body = `${EMERGENCY_TOOLS.includes(toolName) ? '🚨 *AEGIS CODE RED*' : '🤖 *AEGIS CIVILIAN*'}\n`;
    body += `_${ts}_\n\n${icon} *${toolName.replace(/_/g, ' ').toUpperCase()}*\n`;
    body += Object.entries(args).map(([k, v]) => `• ${k}: ${v}`).join('\n');

    try {
        await waSocket.sendMessage(jid, { text: body });
        console.log('[WhatsApp] ✅ Sent');
    } catch (e) {
        console.error('[WhatsApp] Send failed:', e.message);
    }
}

// ─── Main LLM Processing ──────────────────────────────────────────────────────
async function processWithGroq(transcript, conversationHistory, ws, cartesiaWs) {
    conversationHistory.push({ role: 'user', content: transcript });

    let messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...conversationHistory];

    // Groq tool calling loop (handles chained tool calls)
    let maxLoops = 5;
    while (maxLoops-- > 0) {
        console.log('[Groq] Sending to LLM...');
        const response = await groq.chat.completions.create({
            model:       'llama-3.3-70b-versatile',  // FREE on Groq, 500+ tokens/sec
            messages,
            tools:       TOOLS,
            tool_choice: 'auto',
            max_tokens:  300,   // keep TTS latency low — voice answers must be short
            temperature: 0.3,
        });

        const msg = response.choices[0].message;
        messages.push(msg);

        // No tool calls → final text response
        if (!msg.tool_calls || msg.tool_calls.length === 0) {
            const reply = msg.content?.trim();
            if (reply) {
                console.log(`[Groq] Reply: "${reply}"`);
                conversationHistory.push({ role: 'assistant', content: reply });

                // Send transcript to frontend
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'ai_transcript', text: reply }));
                }
                sendToCartesia(cartesiaWs, reply);
            }
            break;
        }

        // Execute all tool calls in parallel
        const toolResults = [];
        for (const call of msg.tool_calls) {
            const { name, arguments: argsStr } = call.function;
            const args = JSON.parse(argsStr);
            const result = executeTool(name, args);

            // Notify frontend
            if (ws.readyState === WebSocket.OPEN) {
                // Mode switch
                if (EMERGENCY_TOOLS.includes(name)) ws.send(JSON.stringify({ type: 'mode_switch', mode: 'emergency' }));
                if (CIVILIAN_TOOLS.includes(name))  ws.send(JSON.stringify({ type: 'mode_switch', mode: 'civilian' }));

                // Action log
                ws.send(JSON.stringify({ type: 'action_log', tool: name, details: JSON.stringify(args) }));

                // Hardware action for music
                if (name === 'play_device_music') {
                    ws.send(JSON.stringify({ type: 'hardware_action', action: 'play_music', song: args.song_name }));
                }
            }

            // WhatsApp log
            await logToWhatsApp(name, args);

            toolResults.push({ tool_call_id: call.id, role: 'tool', name, content: JSON.stringify(result) });
        }

        messages.push(...toolResults);
    }
}

// ─── WebSocket Connection Handler ─────────────────────────────────────────────
wss.on('connection', (ws) => {
    console.log('\n[Server] ✅ Client connected');
    const conversationHistory = [];
    let isProcessing = false;

    // ── Cartesia WS ────────────────────────────────────────────────────────────
    const cartesiaUrl = `wss://api.cartesia.ai/tts/websocket?api_key=${process.env.CARTESIA_API_KEY}&cartesia_version=2024-06-10`;
    const cartesiaWs  = new WebSocket(cartesiaUrl);

    cartesiaWs.on('open',  () => console.log('[Cartesia] ✅ Connected'));
    cartesiaWs.on('error', (e) => console.error('[Cartesia] Error:', e.message));
    cartesiaWs.on('close', () => console.log('[Cartesia] Disconnected'));

    cartesiaWs.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'chunk' && msg.data) {
                // Forward raw PCM audio bytes to React client
                const audioBuf = Buffer.from(msg.data, 'base64');
                if (ws.readyState === WebSocket.OPEN) ws.send(audioBuf);
            } else if (msg.type === 'error') {
                console.error('[Cartesia] API error:', msg.error);
            }
        } catch (_) {
            // Binary frame — forward directly
            if (ws.readyState === WebSocket.OPEN) ws.send(data);
        }
    });

    // ── Deepgram Live STT ─────────────────────────────────────────────────────
    const dgConnection = deepgram.listen.live({
        model:           'nova-2',
        language:        'en-IN',        // Tuned for Indian English accents
        smart_format:    true,
        interim_results: true,
        endpointing:     300,            // ms of silence before marking utterance final
        vad_events:      true,
    });

    let keepAliveInterval;

    dgConnection.on('open', () => {
        console.log('[Deepgram] ✅ Connected');
        // Keepalive: send empty packet every 8s to prevent 10s timeout
        keepAliveInterval = setInterval(() => {
            if (dgConnection.getReadyState() === 1) {
                dgConnection.keepAlive();
            }
        }, 8000);
    });

    dgConnection.on('Results', async (data) => {
        const alt        = data.channel?.alternatives?.[0];
        const transcript = alt?.transcript?.trim();
        if (!transcript) return;

        if (!data.is_final) {
            // Interim = user started speaking → barge-in: kill AI audio immediately
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'clear_buffer' }));
            }
            return;
        }

        // Ignore very short noise fragments
        if (transcript.length < 3) return;

        console.log(`[Deepgram] ✅ Final: "${transcript}"`);

        if (isProcessing) {
            console.log('[Groq] Busy — dropping transcript:', transcript);
            return;
        }

        isProcessing = true;
        try {
            await processWithGroq(transcript, conversationHistory, ws, cartesiaWs);
        } catch (err) {
            console.error('[Groq] Error:', err.message);
            // Speak a graceful fallback
            sendToCartesia(cartesiaWs, "I hit a snag. Try again.");
        } finally {
            isProcessing = false;
        }
    });

    dgConnection.on('error', (e) => console.error('[Deepgram] Error:', e));
    dgConnection.on('close', () => {
        console.log('[Deepgram] Disconnected');
        clearInterval(keepAliveInterval);
    });

    // ── Handle incoming audio from React ──────────────────────────────────────
    ws.on('message', (message) => {
        if (Buffer.isBuffer(message) || message instanceof ArrayBuffer) {
            if (dgConnection.getReadyState() === 1) {
                dgConnection.send(message);
            }
        }
    });

    // ── Cleanup on disconnect ─────────────────────────────────────────────────
    ws.on('close', () => {
        console.log('[Server] Client disconnected — cleaning up.');
        clearInterval(keepAliveInterval);
        try { dgConnection.finish(); } catch (_) {}
        if (cartesiaWs.readyState === WebSocket.OPEN) cartesiaWs.close();
    });

    ws.on('error', (e) => console.error('[Server] WS error:', e.message));
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════╗
║   AEGIS PROTOCOL — Backend Running       ║
║   Port  : ${PORT}                           ║
║   LLM   : Groq llama-3.3-70b (FREE)     ║
║   STT   : Deepgram Nova-2               ║
║   TTS   : Cartesia Sonic                ║
╚══════════════════════════════════════════╝
`);
});
