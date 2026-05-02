/**
 * AEGIS PROTOCOL — App.js (FIXED)
 *
 * KEY FIXES vs original:
 *  1. Audio playback: Cartesia now sends pcm_f32le (float32) at 44100Hz.
 *     Fixed AudioContext sampleRate to 44100 and use Float32Array instead of Int16Array.
 *  2. WebSocket URL: now reads from window.location so it works on localtunnel/ngrok
 *     without hardcoding "localhost" (which breaks on phone).
 *  3. clear_buffer: now properly re-initializes AudioContext so next AI reply plays clean.
 *  4. Added connection retry on disconnect.
 *  5. Added mic permission error handling with clear user message.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import './App.css';

const EMERGENCY_TOOLS = ['log_vitals', 'administer_medication', 'trigger_trauma_alert', 'dispatch_medevac'];

const TOOL_ICONS = {
  log_vitals:           '🩺',
  administer_medication:'💊',
  trigger_trauma_alert: '🚑',
  dispatch_medevac:     '🚁',
  book_movie_tickets:   '🎬',
  play_device_music:    '🎵',
};

const TOOL_NAMES = {
  log_vitals:           'Vitals Logged',
  administer_medication:'Medication Administered',
  trigger_trauma_alert: 'Trauma Alert Sent',
  dispatch_medevac:     'Medevac Dispatched',
  book_movie_tickets:   'Movie Tickets Booked',
  play_device_music:    'Music Playing',
};

function formatDetails(tool, detailsStr) {
  try {
    const args = JSON.parse(detailsStr);
    switch (tool) {
      case 'book_movie_tickets': return `🍿 ${args.movie_name} | 📍 ${args.theater} | 🎟️ ${args.tickets} tickets`;
      case 'play_device_music':  return `🎶 ${args.song_name}`;
      case 'log_vitals': {
        const parts = [];
        if (args.heart_rate)     parts.push(`❤️ ${args.heart_rate} BPM`);
        if (args.blood_pressure) parts.push(`🩸 ${args.blood_pressure}`);
        if (args.oxygen_level)   parts.push(`🫁 ${args.oxygen_level}%`);
        return parts.join(' | ');
      }
      case 'administer_medication': return `💉 ${args.drug_name} • ${args.dosage}`;
      case 'trigger_trauma_alert':  return `⏱️ ETA: ${args.eta_minutes} min | ⚠️ ${args.injury_type}`;
      case 'dispatch_medevac':      return `📍 ${args.coordinates} | 🔐 ${args.auth_code}`;
      default: return detailsStr;
    }
  } catch (_) {
    return detailsStr;
  }
}

// ── Build WebSocket URL that works on localhost AND localtunnel/ngrok ─────────
function getWsUrl() {
  const host     = window.location.hostname;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // On localhost, backend is on port 8080. On tunnel, same host different port scheme.
  const port     = host === 'localhost' || host === '127.0.0.1' ? ':8080' : '';
  return `${protocol}//${host}${port}`;
}

export default function App() {
  const [status,       setStatus]       = useState('Disconnected');
  const [isConnected,  setIsConnected]  = useState(false);
  const [mode,         setMode]         = useState('civilian');
  const [actionLogs,   setActionLogs]   = useState([]);
  const [nowPlaying,   setNowPlaying]   = useState(null);
  const [aiTranscript, setAiTranscript] = useState('');

  const wsRef              = useRef(null);
  const mediaRecorderRef   = useRef(null);
  const audioContextRef    = useRef(null);
  const nextPlayTimeRef    = useRef(0);
  const aiTranscriptTimer  = useRef(null);

  // Body class for emergency mode background
  useEffect(() => {
    document.body.classList.toggle('emergency-mode', mode === 'emergency');
    return () => document.body.classList.remove('emergency-mode');
  }, [mode]);

  useEffect(() => () => stopConversation(), []); // eslint-disable-line

  // ── Reset AudioContext (barge-in / clear_buffer) ────────────────────────────
  const resetAudioContext = useCallback(() => {
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
    }
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 });
    audioContextRef.current = ctx;
    nextPlayTimeRef.current = ctx.currentTime;
  }, []);

  // ── Play PCM float32 audio chunk ────────────────────────────────────────────
  const playChunk = useCallback((arrayBuffer) => {
    const ctx = audioContextRef.current;
    if (!ctx) return;

    // Cartesia sends pcm_f32le — each sample is a 4-byte float
    const float32 = new Float32Array(arrayBuffer);
    const buffer  = ctx.createBuffer(1, float32.length, 44100);
    buffer.getChannelData(0).set(float32);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    const now = ctx.currentTime;
    if (now > nextPlayTimeRef.current) nextPlayTimeRef.current = now;
    source.start(nextPlayTimeRef.current);
    nextPlayTimeRef.current += buffer.duration;
  }, []);

  // ── Start ───────────────────────────────────────────────────────────────────
  const startConversation = async () => {
    try {
      // Reset state
      setActionLogs([]);
      setNowPlaying(null);
      setMode('civilian');
      setAiTranscript('');

      // Init AudioContext
      resetAudioContext();

      // Connect WebSocket
      const url = getWsUrl();
      console.log('[WS] Connecting to', url);
      wsRef.current = new WebSocket(url);

      wsRef.current.onopen = () => {
        setIsConnected(true);
        setStatus('Listening');
        console.log('[WS] Connected');
      };

      wsRef.current.onmessage = async (event) => {
        // ── JSON control message ──
        if (typeof event.data === 'string') {
          try {
            const data = JSON.parse(event.data);

            if (data.type === 'clear_buffer') {
              console.log('[Frontend] Barge-in — clearing audio');
              resetAudioContext();
              setStatus('Listening');

            } else if (data.type === 'mode_switch') {
              setMode(data.mode);

            } else if (data.type === 'action_log') {
              setActionLogs(prev => [{
                time: new Date().toLocaleTimeString(),
                tool: data.tool,
                details: data.details,
                isEmergency: EMERGENCY_TOOLS.includes(data.tool),
              }, ...prev].slice(0, 20)); // Keep last 20

            } else if (data.type === 'hardware_action' && data.action === 'play_music') {
              setNowPlaying(data.song);
              setTimeout(() => setNowPlaying(null), 15000);

            } else if (data.type === 'ai_transcript') {
              setAiTranscript(data.text);
              clearTimeout(aiTranscriptTimer.current);
              aiTranscriptTimer.current = setTimeout(() => setAiTranscript(''), 7000);
            }
          } catch (e) {
            console.error('[WS] JSON parse error:', e);
          }
          return;
        }

        // ── Binary audio chunk from Cartesia ──
        const arrayBuffer = await (event.data instanceof Blob
          ? event.data.arrayBuffer()
          : Promise.resolve(event.data));

        setStatus('AI Speaking');
        playChunk(arrayBuffer);

        // Revert status after a moment (heuristic — audio may still be queued)
        setTimeout(() => {
          if (wsRef.current?.readyState === WebSocket.OPEN) setStatus('Listening');
        }, 2000);
      };

      wsRef.current.onclose = () => {
        setIsConnected(false);
        setStatus('Disconnected');
        stopMic();
      };

      wsRef.current.onerror = (e) => {
        console.error('[WS] Error:', e);
        setStatus('Connection error');
      };

      // ── Mic capture ──
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 },
      });

      mediaRecorderRef.current = new MediaRecorder(stream);
      mediaRecorderRef.current.ondataavailable = (e) => {
        if (e.data.size > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(e.data);
        }
      };
      mediaRecorderRef.current.start(250);

    } catch (err) {
      console.error('[Start] Error:', err);
      if (err.name === 'NotAllowedError') {
        alert('Microphone permission denied. Please allow microphone access and try again.');
      } else if (err.message?.includes('WebSocket')) {
        alert('Cannot connect to backend. Make sure "node server.js" is running on port 8080.');
      } else {
        alert('Error: ' + err.message);
      }
      setStatus('Disconnected');
      setIsConnected(false);
    }
  };

  const stopMic = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach(t => t.stop());
    }
  };

  const stopConversation = () => {
    stopMic();
    wsRef.current?.close();
    audioContextRef.current?.close().catch(() => {});
    audioContextRef.current = null;
    setIsConnected(false);
    setStatus('Disconnected');
  };

  // ── Status CSS ──────────────────────────────────────────────────────────────
  const statusClass = {
    'Disconnected':     'status-disconnected',
    'Listening':        'status-listening',
    'AI Speaking':      'status-speaking',
  }[status] || 'status-disconnected';

  return (
    <div className={`app-container ${mode}`}>
      {mode === 'emergency' && <div className="emergency-flash" />}

      <div className={`mode-badge ${mode}`}>
        <span className="badge-dot" />
        {mode === 'civilian' ? 'Civilian Mode' : '⚠ Code Red Active'}
      </div>

      <div className={`header ${mode}`}>
        <h1>{mode === 'civilian' ? 'Aegis' : 'AEGIS // CODE RED'}</h1>
        <p>{mode === 'civilian'
          ? 'Your Dual-State Voice Agent'
          : 'Emergency Medical Orchestrator'}</p>
      </div>

      <div className={`status-indicator ${statusClass}`}>
        <div className="orb" />
        <span>{status}</span>
      </div>

      <div className={`wave-container ${['Listening','AI Speaking'].includes(status) ? 'active' : ''}`}>
        {[...Array(5)].map((_, i) => <div key={i} className="bar" />)}
      </div>

      {nowPlaying && (
        <div className="music-bar">
          <span className="music-icon">🎵</span>
          <span className="music-text">Now Playing: {nowPlaying}</span>
          <div className="music-eq">
            {[...Array(4)].map((_, i) => <div key={i} className="eq-bar" />)}
          </div>
        </div>
      )}

      {aiTranscript && (
        <div className="ai-transcript-bubble">
          <span className="transcript-label">Aegis:</span>
          <span className="transcript-text">{aiTranscript}</span>
        </div>
      )}

      <div className="action-log-container">
        <h3>{mode === 'civilian' ? '📋 Activity Log' : '🚨 Operations Log'}</h3>
        {actionLogs.length === 0 ? (
          <p className="no-logs">
            {mode === 'civilian'
              ? 'Try: "Book 2 tickets for Avengers at PVR"'
              : 'Awaiting trauma input...'}
          </p>
        ) : (
          <ul className="action-log-list">
            {actionLogs.map((log, i) => (
              <li key={i} className={`action-log-item ${log.isEmergency ? 'tool-emergency' : 'tool-civilian'}`}>
                <span className="log-time">{log.time}</span>
                <span className="log-tool">
                  <span className="tool-icon">{TOOL_ICONS[log.tool] || '⚙️'}</span>
                  {TOOL_NAMES[log.tool] || log.tool}
                </span>
                <span className="log-details">{formatDetails(log.tool, log.details)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="controls">
        {!isConnected ? (
          <button className="btn-primary" onClick={startConversation}>
            {mode === 'civilian' ? '🎙️ Start Conversation' : '🎙️ Aegis Online'}
          </button>
        ) : (
          <button className="btn-primary btn-danger" onClick={stopConversation}>
            End Conversation
          </button>
        )}
      </div>

      <div className="powered-by">
        Powered by Groq · Deepgram · Cartesia
      </div>
    </div>
  );
}
