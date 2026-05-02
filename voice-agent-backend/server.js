/**
 * AEGIS PROTOCOL — server.js (v3 — Llama 3 on Local Ollama)
 * 
 * LLM: Llama 3 via Ollama on local network (http://10.59.197.186:11434)
 * STT: Deepgram Nova-2
 * TTS: Cartesia Sonic
 * 
 * KEY FIXES in this version:
 *  1. Switched to Llama 3 on local Ollama (free, no API key needed, fast)
 *  2. Fixed Cartesia audio encoding: pcm_f32le @ 44100Hz (matches frontend Float32Array)
 *  3. Added Deepgram keepalive (prevents 10s silence timeout)
 *  4. Deepgram tuned for Indian English (en-IN) with endpointing
 *  5. WhatsApp made fully optional — won't crash if Baileys not installed
 *  6. Keyword intent engine kept for instant tool triggers (bypasses LLM latency)
 *  7. Reduced verbose audio chunk logging to prevent console flooding
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const { createClient } = require('@deepgram/sdk');

// ─── Ollama Configuration (Llama 3 on second PC) ────────────────────────────
const OLLAMA_HOST = process.env.OLLAMA_HOST || '10.59.197.186';
const OLLAMA_PORT = process.env.OLLAMA_PORT || '11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3';
const OLLAMA_URL = `http://${OLLAMA_HOST}:${OLLAMA_PORT}/api/chat`;

console.log(`[Ollama] Brain: ${OLLAMA_URL} (Model: ${OLLAMA_MODEL})`);

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
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Ensure required env vars
['DEEPGRAM_API_KEY', 'CARTESIA_API_KEY', 'CARTESIA_VOICE_ID'].forEach(v => {
    if (!process.env[v]) console.warn(`[WARNING] Missing env var: ${v}`);
});

// CORS
app.use((req, res, next) => { res.header('Access-Control-Allow-Origin', '*'); next(); });

// Serve static frontend build
app.use(express.static(path.join(__dirname, '../voice-agent-frontend/build')));
app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, '../voice-agent-frontend/build', 'index.html'));
});

// Health endpoint
app.get('/health', (_, res) => res.json({ status: 'ok', llm: `ollama/${OLLAMA_MODEL}` }));

// ─── Deepgram Client ─────────────────────────────────────────────────────────
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

// ─── System Prompt (Optimized for Llama 3) ───────────────────────────────────
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
- Emergency tools only in Code Red. Consumer tools only in Civilian mode.
- Keep every reply under 2 sentences. You are a voice agent, not a chatbot.`;

// ─── Ollama API Helper ───────────────────────────────────────────────────────
async function queryOllama(messages) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout

    try {
        const response = await fetch(OLLAMA_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: OLLAMA_MODEL,
                messages: messages,
                stream: false,
                options: {
                    temperature: 0.3,    // Lower = more focused for voice
                    num_predict: 150,    // Short replies for voice
                    top_p: 0.9,
                    repeat_penalty: 1.1
                }
            }),
            signal: controller.signal
        });

        clearTimeout(timeout);

        if (!response.ok) {
            throw new Error(`Ollama ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        return data.message?.content || '';
    } catch (error) {
        clearTimeout(timeout);
        if (error.name === 'AbortError') {
            console.error('[Ollama] Request timed out (30s)');
            return 'Sorry, I took too long. Please try again.';
        }
        throw error;
    }
}

// ─── Tool Classification ─────────────────────────────────────────────────────
const EMERGENCY_TOOLS = ['log_vitals', 'administer_medication', 'trigger_trauma_alert', 'dispatch_medevac', 'activate_camera_triage'];
const CIVILIAN_TOOLS = ['book_movie_tickets', 'play_device_music', 'book_cab', 'schedule_appointment', 'check_discharge_status'];

// ─── WhatsApp Logger ─────────────────────────────────────────────────────────
async function logToWhatsApp(toolName, args) {
    if (!waSocket || !process.env.WHATSAPP_TARGET_NUMBER) return;
    const ts = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
    const jid = `${process.env.WHATSAPP_TARGET_NUMBER}@s.whatsapp.net`;

    const ICONS = {
        log_vitals: '🩺', administer_medication: '💊',
        trigger_trauma_alert: '🚑', dispatch_medevac: '🚁',
        book_movie_tickets: '🎬', play_device_music: '🎵',
        book_cab: '🚕', schedule_appointment: '📋',
        check_discharge_status: '🏥', activate_camera_triage: '📸'
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

// ─── WebSocket Connection Handler ─────────────────────────────────────────────
wss.on('connection', (ws) => {
    console.log('\n[Server] ✅ Client connected');

    const conversationHistory = [];
    let isProcessing = false;

    // ── Cartesia WS (TTS) ────────────────────────────────────────────────────
    const cartesiaUrl = `wss://api.cartesia.ai/tts/websocket?api_key=${process.env.CARTESIA_API_KEY}&cartesia_version=2024-06-10`;
    let cartesiaWs = new WebSocket(cartesiaUrl);

    function connectCartesia() {
        cartesiaWs = new WebSocket(cartesiaUrl);
        cartesiaWs.on('open', () => console.log('[Cartesia] ✅ Connected'));
        cartesiaWs.on('error', (e) => console.error('[Cartesia] Error:', e.message));
        cartesiaWs.on('close', () => {
            console.log('[Cartesia] Disconnected. Reconnecting in 2s...');
            if (ws.readyState === WebSocket.OPEN) setTimeout(connectCartesia, 2000);
        });

        cartesiaWs.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'chunk' && msg.data) {
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
    }
    connectCartesia();

    // ── Send to Cartesia TTS ──────────────────────────────────────────────────
    function sendToCartesia(text) {
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
                container: 'raw',
                encoding: 'pcm_f32le',   // MUST match frontend Float32Array expectation
                sample_rate: 44100,       // Cartesia's native rate
            },
            context_id: `msg-${Date.now()}`,
        }));
    }

    // ── Tool Execution Engine ─────────────────────────────────────────────────
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
            case 'book_cab': {
                const eta = Math.floor(Math.random() * 8) + 3;
                return { status: 'Cab booked', eta_minutes: eta, destination: args.destination };
            }
            case 'schedule_appointment':
                return { status: 'Appointment scheduled', id: 'APT-' + Math.floor(Math.random() * 90000 + 10000) };
            case 'check_discharge_status':
                return {
                    status: 'Retrieved', pipeline: {
                        billing: { status: 'Cleared', amount: '₹12,450' },
                        insurance: { status: 'Pending', note: '2 patients ahead' },
                        pharmacy: { status: 'Ready', note: 'Counter 3' },
                        lab: { status: 'Cleared', note: 'Reports uploaded' }
                    }
                };
            case 'activate_camera_triage':
                return { status: 'Camera activated' };
            default:
                return { status: 'Unknown tool' };
        }
    }

    // ── Execute tool and send all notifications ──────────────────────────────
    async function executeToolAndRespond(call) {
        const result = executeTool(call.name, call.args);

        // Mode switch
        if (ws.readyState === WebSocket.OPEN) {
            if (EMERGENCY_TOOLS.includes(call.name)) ws.send(JSON.stringify({ type: 'mode_switch', mode: 'emergency' }));
            if (CIVILIAN_TOOLS.includes(call.name)) ws.send(JSON.stringify({ type: 'mode_switch', mode: 'civilian' }));

            // Action log
            ws.send(JSON.stringify({ type: 'action_log', tool: call.name, details: JSON.stringify(call.args) }));

            // Hardware actions for frontend
            if (call.name === 'play_device_music') {
                ws.send(JSON.stringify({ type: 'hardware_action', action: 'play_music', song: call.args.song_name }));
            } else if (call.name === 'book_cab') {
                ws.send(JSON.stringify({ type: 'hardware_action', action: 'cab_booked', eta: result.eta_minutes, destination: call.args.destination }));
            } else if (call.name === 'book_movie_tickets') {
                ws.send(JSON.stringify({ type: 'hardware_action', action: 'movie_booked', movie: call.args.movie_name }));
            } else if (call.name === 'schedule_appointment') {
                ws.send(JSON.stringify({ type: 'hardware_action', action: 'appointment_booked', doctor: call.args.doctor_type, hospital: 'Partner Hospital' }));
            } else if (call.name === 'check_discharge_status') {
                ws.send(JSON.stringify({ type: 'discharge_update', statuses: result.pipeline }));
            } else if (call.name === 'activate_camera_triage') {
                ws.send(JSON.stringify({ type: 'activate_camera', reason: call.args.reason }));
            }
        }

        // WhatsApp log
        await logToWhatsApp(call.name, call.args);

        // Voice confirmation
        const confirmations = {
            play_device_music: `Playing ${call.args.song_name} for you now!`,
            book_cab: `Your cab to ${call.args.destination} is booked! Arriving in about ${result.eta_minutes} minutes.`,
            book_movie_tickets: `Done! Booked ${call.args.tickets || 2} tickets for ${call.args.movie_name}.`,
            schedule_appointment: `Your ${call.args.doctor_type} appointment has been scheduled.`,
            check_discharge_status: `Discharge status: Billing cleared, insurance pending, pharmacy ready at counter 3, lab reports cleared.`,
            log_vitals: `Vitals logged. Heart rate ${call.args.heart_rate} BPM, BP ${call.args.blood_pressure}, oxygen ${call.args.oxygen_level} percent.`,
            trigger_trauma_alert: `Trauma alert sent. ETA ${call.args.eta_minutes} minutes for ${call.args.injury_type}.`,
            activate_camera_triage: `Camera triage activated. Point your camera at the injury.`,
            dispatch_medevac: `Medevac dispatched to ${call.args.coordinates}.`,
            administer_medication: `${call.args.drug_name} ${call.args.dosage} administered and logged.`
        };

        const voiceReply = confirmations[call.name] || `Done. ${call.name} completed.`;
        console.log(`[Voice] "${voiceReply}"`);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ai_transcript', text: voiceReply }));
        sendToCartesia(voiceReply);
    }

    // ── Keyword Intent Engine (instant, bypasses LLM) ─────────────────────────
    function detectIntent(text) {
        const lower = text.toLowerCase();

        // Play music
        if ((lower.includes('play') || lower.includes('song') || lower.includes('music')) && !lower.includes('code red')) {
            let songName = text.replace(/^.*?(play|put on|start|listen to)\s*/i, '').replace(/\s*(on youtube|on spotify|please|for me|in the youtube|in youtube|on my phone|songs?|music).*$/gi, '').trim();
            if (!songName || songName.length < 2 || ['a', 'some', 'the', 'my'].includes(songName.toLowerCase())) {
                songName = 'Arijit Singh top songs';
            }
            return { name: 'play_device_music', args: { song_name: songName } };
        }
        // Book cab
        if (lower.includes('cab') || lower.includes('uber') || lower.includes('ola') || lower.includes('taxi') || lower.includes('ride')) {
            const dest = text.replace(/^.*?(to|for|towards)\s*/i, '').replace(/\s*(please|now|quickly).*$/i, '').trim() || 'Nearest location';
            return { name: 'book_cab', args: { destination: dest, cab_type: 'economy' } };
        }
        // Book movie
        if (lower.includes('movie') || lower.includes('ticket') || lower.includes('cinema') || lower.includes('book my show')) {
            const movie = text.replace(/^.*?(for|of|to see|watch)\s*/i, '').replace(/\s*(please|at|in|ticket).*$/i, '').trim() || 'Latest Movie';
            return { name: 'book_movie_tickets', args: { movie_name: movie, theater: 'Nearest Theater', tickets: 2 } };
        }
        // Schedule appointment
        if (lower.includes('appointment') || lower.includes('schedule') || (lower.includes('doctor') && lower.includes('book'))) {
            const docType = lower.includes('cardio') ? 'Cardiologist' : lower.includes('ortho') ? 'Orthopedic' : 'General Physician';
            return { name: 'schedule_appointment', args: { doctor_type: docType, preferred_date: 'Next available' } };
        }
        // Discharge status
        if (lower.includes('discharge') || lower.includes('billing') || lower.includes('insurance') || lower.includes('pharmacy status')) {
            return { name: 'check_discharge_status', args: {} };
        }
        // Code Red
        if (lower.includes('code red') || lower.includes('initiate code red')) {
            return '__CODE_RED__';
        }
        // Log vitals
        if (lower.includes('vitals') || lower.includes('heart rate') || lower.includes('blood pressure') || lower.includes('oxygen')) {
            return { name: 'log_vitals', args: { heart_rate: 82, blood_pressure: '120/80', oxygen_level: 97 } };
        }
        // Trauma alert
        if (lower.includes('trauma') || lower.includes('accident') || lower.includes('crash')) {
            return { name: 'trigger_trauma_alert', args: { eta_minutes: 8, injury_type: 'Road traffic accident' } };
        }
        // Camera triage
        if (lower.includes('camera') || lower.includes('triage') || lower.includes('see the injury') || lower.includes('wound')) {
            return { name: 'activate_camera_triage', args: { reason: 'Visual injury assessment' } };
        }

        return null; // No keyword match → send to LLM
    }

    // ── Main LLM Processing ──────────────────────────────────────────────────
    async function processTranscript(transcript) {
        if (isProcessing) {
            console.log(`[Server] Busy — dropped: "${transcript}"`);
            return;
        }

        isProcessing = true;
        try {
            // 1. Check keyword intent first (instant, no LLM needed)
            const intent = detectIntent(transcript);

            if (intent === '__CODE_RED__') {
                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'mode_switch', mode: 'emergency' }));
                const reply = 'Code Red activated. I am now in emergency mode. Report the situation.';
                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ai_transcript', text: reply }));
                sendToCartesia(reply);
                return;
            }

            if (intent) {
                console.log(`[Intent] Detected: "${intent.name}" from keywords`);
                await executeToolAndRespond(intent);
                return;
            }

            // 2. No keyword match → send to Llama 3 for conversational reply
            conversationHistory.push({ role: 'user', content: transcript });

            // Keep history manageable
            if (conversationHistory.length > 12) {
                conversationHistory.splice(0, conversationHistory.length - 6);
            }

            const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...conversationHistory];

            console.log(`[Ollama] Sending to ${OLLAMA_MODEL}: "${transcript}"`);
            let response = await queryOllama(messages);

            // Clean up any thinking tags (just in case)
            response = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

            if (!response || response.length === 0) {
                response = "I'm here! How can I help you? I can play music, book cabs, or check your discharge status.";
            }

            console.log(`[Ollama] Reply: "${response}"`);
            conversationHistory.push({ role: 'assistant', content: response });

            // Send to frontend
            if (ws.readyState === WebSocket.OPEN) {
                const lowerReply = response.toLowerCase();
                if (lowerReply.includes('code red') || lowerReply.includes('emergency')) {
                    ws.send(JSON.stringify({ type: 'mode_switch', mode: 'emergency' }));
                }
                ws.send(JSON.stringify({ type: 'ai_transcript', text: response }));
            }
            sendToCartesia(response);

        } catch (error) {
            console.error('[LLM] Error:', error.message);
            const fallback = "I hit a snag. Try again.";
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ai_transcript', text: fallback }));
            sendToCartesia(fallback);
        } finally {
            isProcessing = false;
        }
    }

    // ── Deepgram Live STT ─────────────────────────────────────────────────────
    const dgConnection = deepgram.listen.live({
        model: 'nova-2',
        language: 'en-IN',           // Indian English accent tuning
        smart_format: true,
        interim_results: true,
        endpointing: 300,            // ms of silence before marking utterance final
        vad_events: true,
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
        const alt = data.channel?.alternatives?.[0];
        const transcript = alt?.transcript?.trim();
        if (!transcript) return;

        if (!data.is_final) {
            // Interim = user started speaking → barge-in: kill AI audio
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'clear_buffer' }));
            }
            return;
        }

        // Ignore very short noise fragments
        if (transcript.length < 3) return;

        console.log(`[Deepgram] ✅ Final: "${transcript}"`);
        await processTranscript(transcript);
    });

    dgConnection.on('error', (e) => console.error('[Deepgram] Error:', e));
    dgConnection.on('close', () => {
        console.log('[Deepgram] Disconnected');
        clearInterval(keepAliveInterval);
    });

    // ── Handle incoming audio from React ──────────────────────────────────────
    let audioChunkCount = 0;
    ws.on('message', (message) => {
        if (Buffer.isBuffer(message) || message instanceof ArrayBuffer) {
            // Log every 20th chunk to avoid console flooding
            audioChunkCount++;
            if (audioChunkCount % 20 === 0) {
                console.log(`[Audio] ${audioChunkCount} chunks received (${message.byteLength} bytes latest)`);
            }
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
const PORT = process.env.PORT || 8081;
server.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════╗
║   AEGIS PROTOCOL — Backend Running       ║
║   Port  : ${PORT}                           ║
║   LLM   : Ollama ${OLLAMA_MODEL} (LOCAL)            ║
║   STT   : Deepgram Nova-2               ║
║   TTS   : Cartesia Sonic                ║
╚══════════════════════════════════════════╝
`);
});
