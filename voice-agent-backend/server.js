require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const { createClient } = require('@deepgram/sdk');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

// =============================================
// OLLAMA CONFIGURATION (Local LLM on second PC)
// =============================================
const OLLAMA_HOST = process.env.OLLAMA_HOST || '10.59.197.94';
const OLLAMA_PORT = process.env.OLLAMA_PORT || '11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'deepseek-r1:1.5b';
const OLLAMA_URL = `http://${OLLAMA_HOST}:${OLLAMA_PORT}/api/chat`;

console.log(`[Ollama] Brain configured at: ${OLLAMA_URL} (Model: ${OLLAMA_MODEL})`);

// Ensure all environment variables are present
const requiredEnvVars = [
    'DEEPGRAM_API_KEY',
    'CARTESIA_API_KEY',
    'CARTESIA_VOICE_ID'
];

requiredEnvVars.forEach(envVar => {
    if (!process.env[envVar]) {
        console.warn(`[WARNING] Missing environment variable: ${envVar}`);
    }
});

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve Static Frontend Build
app.use(express.static(path.join(__dirname, '../voice-agent-frontend/build')));

// Fallback to index.html for SPA routing (using Regex to bypass strict parsing)
app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, '../voice-agent-frontend/build', 'index.html'));
});

// Initialize WhatsApp (Baileys)
let waSocket = null;
async function connectToWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`[WhatsApp] Using WA v${version.join('.')}, isLatest: ${isLatest}`);
        
        const sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: "silent" }),
            browser: Browsers.macOS('Desktop'),
            printQRInTerminal: false
        });

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                console.log('\n[WhatsApp] 🚨 Scan the QR code below with your WhatsApp to link the bot!');
                qrcode.generate(qr, { small: true });
            }
            if (connection === 'close') {
                const error = lastDisconnect?.error;
                const statusCode = error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(`[WhatsApp] Connection closed. Status: ${statusCode}. Reconnecting: ${shouldReconnect}`);
                if (shouldReconnect) {
                    setTimeout(connectToWhatsApp, 5000);
                }
            } else if (connection === 'open') {
                console.log('[WhatsApp] Connected and ready to send messages!');
                waSocket = sock;
            }
        });

        sock.ev.on('creds.update', saveCreds);
    } catch (error) {
        console.error('[WhatsApp] Error initializing Baileys:', error);
    }
}
connectToWhatsApp();

// Initialize Deepgram Client
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

// =============================================
// SYSTEM PROMPT (Optimized for DeepSeek R1 1.5B)
// =============================================
const SYSTEM_PROMPT = `You are Aegis, a dual-state voice assistant.

CIVILIAN MODE (default): Friendly assistant. Help book cabs, movies, play music, check discharge status, schedule appointments. Be conversational and brief.

CODE RED MODE: If user says "code red" or describes a medical emergency, switch to emergency mode. Be ultra-concise (max 10 words per sentence). Log vitals, administer meds, trigger trauma alerts.

TOOLS: When you need to perform an action, output EXACTLY this format (nothing else before or after):
[TOOL_CALL]{"name":"TOOL_NAME","args":{ARGUMENTS}}[/TOOL_CALL]

Available tools:
- log_vitals: args: heart_rate(number), blood_pressure(string), oxygen_level(number)
- administer_medication: args: drug_name(string), dosage(string)
- trigger_trauma_alert: args: eta_minutes(number), injury_type(string)
- dispatch_medevac: args: coordinates(string), auth_code(string)
- activate_camera_triage: args: reason(string)
- book_movie_tickets: args: movie_name(string), theater(string), tickets(number)
- play_device_music: args: song_name(string)
- book_cab: args: destination(string), cab_type(string)
- schedule_appointment: args: doctor_type(string), preferred_date(string), hospital(string)
- check_discharge_status: args: patient_id(string), check_type(string)

RULES:
- Keep responses SHORT (1-2 sentences max) since this is voice
- If calling a tool, output ONLY the [TOOL_CALL] block
- Never use markdown formatting
- Respond naturally as a voice assistant`;

// =============================================
// OLLAMA API HELPER
// =============================================
async function queryOllama(messages) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
        const response = await fetch(OLLAMA_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: OLLAMA_MODEL,
                messages: messages,
                stream: false,
                options: {
                    temperature: 0.7,
                    num_predict: 256,
                    top_p: 0.9
                }
            }),
            signal: controller.signal
        });

        clearTimeout(timeout);

        if (!response.ok) {
            throw new Error(`Ollama responded with ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        return data.message?.content || '';
    } catch (error) {
        clearTimeout(timeout);
        if (error.name === 'AbortError') {
            console.error('[Ollama] Request timed out (30s)');
            return 'I need a moment. Please try again.';
        }
        throw error;
    }
}

// Strip DeepSeek R1 thinking tags <think>...</think>
function stripThinking(text) {
    return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

// Parse tool calls from model output
function parseToolCall(text) {
    const match = text.match(/\[TOOL_CALL\]([\s\S]*?)\[\/TOOL_CALL\]/);
    if (match) {
        try {
            const parsed = JSON.parse(match[1].trim());
            return { name: parsed.name, args: parsed.args || {} };
        } catch (e) {
            console.error('[Ollama] Failed to parse tool call JSON:', e.message);
            return null;
        }
    }
    return null;
}

// =============================================
// WEBSOCKET CONNECTION HANDLER
// =============================================
wss.on('connection', (ws) => {
    console.log('[Client] New React client connected.');

    let dgConnection = null;
    let isDeepgramReady = false;

    // Per-connection conversation history
    const conversationHistory = [
        { role: 'system', content: SYSTEM_PROMPT }
    ];

    // 1. Initialize Cartesia Connection First (so it's ready to receive)
    const cartesiaUrl = `wss://api.cartesia.ai/tts/websocket?api_key=${process.env.CARTESIA_API_KEY}&cartesia_version=2024-06-10`;
    const cartesiaWs = new WebSocket(cartesiaUrl);

    cartesiaWs.on('open', () => {
        console.log('[Cartesia] WebSocket connection opened.');
    });

    cartesiaWs.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            if (message.type === 'chunk') {
                const audioBuffer = Buffer.from(message.data, 'base64');
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(audioBuffer);
                }
            } else if (message.type === 'done') {
                console.log(`[Cartesia] Finished streaming audio for context: ${message.context_id}`);
            } else if (message.type === 'error') {
                console.error('[Cartesia] Error from API:', message.error);
            }
        } catch (error) {
            console.error('[Cartesia] Error parsing message:', error);
        }
    });

    cartesiaWs.on('error', (error) => {
        console.error('[Cartesia] WebSocket error:', error);
    });

    cartesiaWs.on('close', () => {
        console.log('[Cartesia] WebSocket connection closed.');
    });

    // 2. LLM Processing (Ollama / DeepSeek R1)
    let isProcessingLLM = false;

    async function processWithLLM(text) {
        if (isProcessingLLM) {
            console.log(`[Backend] Blocked concurrent LLM request. Dropped: "${text}"`);
            return;
        }
        
        isProcessingLLM = true;
        try {
            // Add user message to history
            conversationHistory.push({ role: 'user', content: text });

            // Keep history manageable (system + last 10 exchanges)
            if (conversationHistory.length > 21) {
                const system = conversationHistory[0];
                conversationHistory.splice(1, conversationHistory.length - 11);
                conversationHistory[0] = system;
            }

            console.log(`[Ollama] Sending to ${OLLAMA_MODEL}: "${text}"`);
            let rawResponse = await queryOllama(conversationHistory);
            console.log(`[Ollama] Raw response: "${rawResponse}"`);

            // Strip <think>...</think> reasoning blocks
            let response = stripThinking(rawResponse);
            console.log(`[Ollama] Clean response: "${response}"`);

            // Check for tool calls
            const toolCall = parseToolCall(response);

            if (toolCall) {
                console.log(`[Ollama] Tool call detected: "${toolCall.name}" with args:`, toolCall.args);
                
                let toolResult = {};
                const call = toolCall;

                // Execute the tool
                if (call.name === 'log_vitals') {
                    toolResult = { status: "Vitals logged successfully" };
                } else if (call.name === 'administer_medication') {
                    toolResult = { status: "Medication administered and logged" };
                } else if (call.name === 'trigger_trauma_alert') {
                    toolResult = { status: "Trauma alert sent to casualty ward" };
                } else if (call.name === 'book_movie_tickets') {
                    toolResult = { status: "Tickets booked successfully", confirmation_code: "BMS-" + Math.floor(Math.random() * 90000 + 10000) };
                    // Open BookMyShow on the phone
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'hardware_action',
                            action: 'movie_booked',
                            movie: call.args.movie_name
                        }));
                    }
                } else if (call.name === 'play_device_music') {
                    toolResult = { status: "Music playback initiated on device hardware" };
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'hardware_action',
                            action: 'play_music',
                            song: call.args.song_name
                        }));
                    }
                } else if (call.name === 'book_cab') {
                    const eta = Math.floor(Math.random() * 8) + 3;
                    toolResult = { status: "Cab booked successfully", provider: "Uber", eta_minutes: eta, destination: call.args.destination, cab_type: call.args.cab_type || 'economy' };
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'hardware_action', action: 'cab_booked', eta: eta, destination: call.args.destination }));
                    }
                } else if (call.name === 'schedule_appointment') {
                    const apptId = 'APT-' + Math.floor(Math.random() * 90000 + 10000);
                    toolResult = { status: "Appointment scheduled", appointment_id: apptId, doctor: call.args.doctor_type, date: call.args.preferred_date || 'Next available slot', hospital: call.args.hospital || 'Nearest partner hospital' };
                    // Open Google Calendar on the phone
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'hardware_action',
                            action: 'appointment_booked',
                            doctor: call.args.doctor_type,
                            hospital: call.args.hospital || 'Nearest partner hospital'
                        }));
                    }
                } else if (call.name === 'check_discharge_status') {
                    const statuses = {
                        billing: { status: 'Cleared', amount: '₹12,450' },
                        insurance: { status: 'Pending', note: 'Awaiting TPA approval. 2 patients ahead.' },
                        pharmacy: { status: 'Ready', note: 'Prescriptions packed at Counter 3' },
                        lab: { status: 'Cleared', note: 'All reports uploaded to patient portal' }
                    };
                    toolResult = { status: "Discharge status retrieved", pipeline: statuses };
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'discharge_update', statuses: statuses }));
                    }
                } else if (call.name === 'dispatch_medevac') {
                    const authCode = (call.args.auth_code || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                    if (authCode === 'sigmaniner' || authCode === 'sigma9' || authCode === 'sigmanine') {
                        toolResult = { status: "Medevac dispatched", destination: call.args.coordinates, authorization: "VERIFIED" };
                        console.log(`[MEDEVAC] 🚁 DISPATCHED to ${call.args.coordinates} - Auth: VERIFIED`);
                    } else {
                        toolResult = { status: "ACCESS DENIED", reason: "Invalid authorization code" };
                        console.log(`[MEDEVAC] ❌ ACCESS DENIED - Invalid auth code: ${call.args.auth_code}`);
                    }
                } else if (call.name === 'activate_camera_triage') {
                    toolResult = { status: "Camera triage activated on user device", reason: call.args.reason };
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'activate_camera', reason: call.args.reason }));
                    }
                } else {
                    toolResult = { status: "Unknown tool called" };
                }

                console.log(`[Ollama] Tool result:`, toolResult);

                // Detect mode and send mode_switch to frontend
                const emergencyTools = ['log_vitals', 'administer_medication', 'trigger_trauma_alert', 'dispatch_medevac', 'activate_camera_triage'];
                const civilianTools = ['book_movie_tickets', 'play_device_music', 'book_cab', 'schedule_appointment', 'check_discharge_status'];
                if (ws.readyState === WebSocket.OPEN) {
                    if (emergencyTools.includes(call.name)) {
                        ws.send(JSON.stringify({ type: 'mode_switch', mode: 'emergency' }));
                    } else if (civilianTools.includes(call.name)) {
                        ws.send(JSON.stringify({ type: 'mode_switch', mode: 'civilian' }));
                    }
                }
                
                // Send real-time action log to the React Frontend
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'action_log',
                        tool: call.name,
                        details: JSON.stringify(call.args)
                    }));
                }

                // Send to WhatsApp via Baileys (Structured Format)
                if (waSocket && process.env.WHATSAPP_TARGET_NUMBER) {
                    const targetJid = `${process.env.WHATSAPP_TARGET_NUMBER}@s.whatsapp.net`;
                    const timestamp = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
                    
                    let formattedDetails = '';
                    let header = '🚨 *AEGIS PROTOCOL ACTIVATED* 🚨';
                    
                    if (call.name === 'log_vitals') {
                        formattedDetails = `🩺 *Vitals Update*\n`;
                        if (call.args.heart_rate) formattedDetails += `❤️ Heart Rate: ${call.args.heart_rate} BPM\n`;
                        if (call.args.blood_pressure) formattedDetails += `🩸 BP: ${call.args.blood_pressure}\n`;
                        if (call.args.oxygen_level) formattedDetails += `🫁 SpO2: ${call.args.oxygen_level}%\n`;
                    } else if (call.name === 'administer_medication') {
                        formattedDetails = `💊 *Medication Administered*\n💉 Drug: ${call.args.drug_name}\n⚖️ Dosage: ${call.args.dosage}`;
                    } else if (call.name === 'trigger_trauma_alert') {
                        formattedDetails = `🚑 *TRAUMA ALERT TRIGGERED*\n⏱️ ETA: ${call.args.eta_minutes} mins\n⚠️ Injury: ${call.args.injury_type}`;
                    } else if (call.name === 'book_movie_tickets') {
                        header = '🎟️ *AEGIS CIVILIAN ASSISTANT* 🎟️';
                        formattedDetails = `🎬 *Movie Tickets Confirmed*\n🍿 Movie: ${call.args.movie_name}\n📍 Theater: ${call.args.theater}\n🎟️ Tickets: ${call.args.tickets}`;
                    } else if (call.name === 'play_device_music') {
                        header = '🎵 *AEGIS CIVILIAN ASSISTANT* 🎵';
                        formattedDetails = `🎧 *Playing Music*\n🎶 Track: ${call.args.song_name}`;
                    } else if (call.name === 'book_cab') {
                        header = '🚕 *AEGIS CIVILIAN ASSISTANT* 🚕';
                        formattedDetails = `🚗 *Cab Booked*\n📍 To: ${call.args.destination}\n🚘 Type: ${call.args.cab_type || 'Economy'}\n⏱️ ETA: ${toolResult.eta_minutes} mins`;
                    } else if (call.name === 'schedule_appointment') {
                        header = '🏥 *AEGIS CIVILIAN ASSISTANT* 🏥';
                        formattedDetails = `📋 *Appointment Scheduled*\n👨‍⚕️ Doctor: ${call.args.doctor_type}\n📅 Date: ${call.args.preferred_date || 'Next available'}\n🏥 Hospital: ${call.args.hospital || 'Partner hospital'}`;
                    } else if (call.name === 'check_discharge_status') {
                        header = '🏥 *AEGIS DISCHARGE UPDATE* 🏥';
                        formattedDetails = `📊 *Discharge Pipeline*\n💰 Billing: Cleared (₹12,450)\n🛡️ Insurance: Pending TPA\n💊 Pharmacy: Ready at Counter 3\n🔬 Lab: All reports cleared`;
                    } else if (call.name === 'dispatch_medevac') {
                        formattedDetails = `🚁 *MEDEVAC DISPATCHED*\n📍 Target: ${call.args.coordinates}\n🔐 Auth: ${call.args.auth_code}\n✅ Status: AIRBORNE`;
                    } else if (call.name === 'activate_camera_triage') {
                        formattedDetails = `📸 *VISUAL TRIAGE ACTIVATED*\n🔍 Reason: ${call.args.reason}\n📱 Camera feed active on patient device`;
                    }

                    const textMsg = `${header}\n_Time: ${timestamp}_\n\n${formattedDetails}\n\n_Status: System Logging Active_`;
                    
                    try {
                        await waSocket.sendMessage(targetJid, { text: textMsg });
                        console.log(`[WhatsApp] Sent formatted log to ${process.env.WHATSAPP_TARGET_NUMBER}`);
                    } catch (err) {
                        console.error('[WhatsApp] Failed to send message:', err);
                    }
                }

                // Add tool call + result to conversation history, then get a follow-up response
                conversationHistory.push({ role: 'assistant', content: response });
                conversationHistory.push({ role: 'user', content: `Tool "${call.name}" returned: ${JSON.stringify(toolResult)}. Now give a brief voice response confirming the action to the user.` });

                // Get follow-up response from LLM
                let followUp = await queryOllama(conversationHistory);
                followUp = stripThinking(followUp);
                console.log(`[Ollama] Follow-up after tool: "${followUp}"`);

                // Remove any accidental tool calls from follow-up
                followUp = followUp.replace(/\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\]/g, '').trim();

                if (followUp && followUp.length > 0) {
                    conversationHistory.push({ role: 'assistant', content: followUp });
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'ai_transcript', text: followUp }));
                    }
                    sendToCartesia(followUp);
                }

            } else {
                // No tool call — plain text response
                if (response && response.trim().length > 0) {
                    conversationHistory.push({ role: 'assistant', content: response });

                    // Detect mode from AI's spoken response text
                    const lowerReply = response.toLowerCase();
                    if (ws.readyState === WebSocket.OPEN) {
                        if (lowerReply.includes('code red') || lowerReply.includes('emergency') || lowerReply.includes('trauma')) {
                            ws.send(JSON.stringify({ type: 'mode_switch', mode: 'emergency' }));
                            console.log('[Mode] Switched to EMERGENCY based on AI response text.');
                        } else if (lowerReply.includes('civilian') || lowerReply.includes('stand down') || lowerReply.includes('normal mode')) {
                            ws.send(JSON.stringify({ type: 'mode_switch', mode: 'civilian' }));
                            console.log('[Mode] Switched to CIVILIAN based on AI response text.');
                        }
                        // Send transcript to frontend for display
                        ws.send(JSON.stringify({ type: 'ai_transcript', text: response }));
                    }
                    sendToCartesia(response);
                }
            }

        } catch (error) {
            console.error('[Ollama] Error during LLM processing:', error);
            // Fallback response if Ollama is unreachable
            const fallback = "I'm having trouble connecting to my brain. Please check the Ollama server.";
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'ai_transcript', text: fallback }));
            }
            sendToCartesia(fallback);
        } finally {
            isProcessingLLM = false;
        }
    }

    function sendToCartesia(text) {
        if (cartesiaWs.readyState === WebSocket.OPEN) {
            console.log(`[Cartesia] Sending text for TTS: "${text}"`);
            const request = {
                model_id: "sonic-english",
                transcript: text,
                voice: {
                    mode: "id",
                    id: process.env.CARTESIA_VOICE_ID
                },
                output_format: {
                    container: "raw",
                    encoding: "pcm_s16le",
                    sample_rate: 16000
                },
                context_id: `msg-${Date.now()}`
            };
            cartesiaWs.send(JSON.stringify(request));
        } else {
            console.error('[Cartesia] WebSocket is not open to send text.');
        }
    }

    // 3. Initialize Deepgram Connection
    try {
        dgConnection = deepgram.listen.live({
            model: 'nova-2',
            language: 'en',
            smart_format: true,
            interim_results: true
        });

        dgConnection.on('open', () => {
            console.log('[Deepgram] WebSocket connection opened.');
            isDeepgramReady = true;
        });

        dgConnection.on('Results', async (data) => {
            const transcript = data.channel?.alternatives[0]?.transcript;
            
            if (transcript && transcript.trim().length > 0) {
                if (data.is_final) {
                    // OPTIMIZATION: Ignore very short background noises
                    if (transcript.trim().length < 5) return;
                    
                    console.log(`[Deepgram] Final Transcript: "${transcript}"`);
                    await processWithLLM(transcript);
                } else {
                    // Interim result - User is currently speaking (barge-in)
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: "clear_buffer" }));
                    }
                }
            }
        });

        dgConnection.on('error', (error) => {
            console.error('[Deepgram] Error:', error);
        });

        dgConnection.on('close', () => {
            console.log('[Deepgram] WebSocket connection closed.');
            isDeepgramReady = false;
        });
    } catch (err) {
        console.error('[Deepgram] Initialization failed:', err);
    }

    // 4. Handle incoming messages from React Client
    ws.on('message', (message) => {
        if (Buffer.isBuffer(message) || message instanceof ArrayBuffer) {
            console.log(`[Client -> Deepgram] Streaming audio chunk: ${message.byteLength} bytes`);
            if (dgConnection && isDeepgramReady) {
                dgConnection.send(message);
            }
        } else {
            console.log('[Client] Received non-binary message:', message.toString());
        }
    });

    ws.on('close', () => {
        console.log('[Client] Connection closed by client. Cleaning up...');
        if (dgConnection) {
            dgConnection.requestClose ? dgConnection.requestClose() : dgConnection.finish && dgConnection.finish();
        }
        if (cartesiaWs.readyState === WebSocket.OPEN) {
            cartesiaWs.close();
        }
    });

    ws.on('error', (error) => {
        console.error('[Client] WebSocket error:', error);
    });
});

const PORT = process.env.PORT || 8081;
server.listen(8081, () => {
    console.log(`[Server] WebSocket server is listening on port 8081`);
});
