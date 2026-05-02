import React, { useState, useEffect, useRef } from 'react';
import './App.css';

const EMERGENCY_TOOLS = ['log_vitals', 'administer_medication', 'trigger_trauma_alert', 'dispatch_medevac'];
const CIVILIAN_TOOLS = ['book_movie_tickets', 'play_device_music'];

const TOOL_ICONS = {
  log_vitals: '🩺',
  administer_medication: '💊',
  trigger_trauma_alert: '🚑',
  dispatch_medevac: '🚁',
  book_movie_tickets: '🎬',
  play_device_music: '🎵',
};

function App() {
  const [status, setStatus] = useState('Disconnected');
  const [isConnected, setIsConnected] = useState(false);
  const [mode, setMode] = useState('civilian'); // 'civilian' or 'emergency'
  const [actionLogs, setActionLogs] = useState([]);
  const [nowPlaying, setNowPlaying] = useState(null);
  const [aiTranscript, setAiTranscript] = useState('');

  const wsRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioContextRef = useRef(null);
  const nextPlayTimeRef = useRef(0);
  const musicRef = useRef(null);

  // Apply emergency class to body for background transition
  useEffect(() => {
    if (mode === 'emergency') {
      document.body.classList.add('emergency-mode');
    } else {
      document.body.classList.remove('emergency-mode');
    }
    return () => document.body.classList.remove('emergency-mode');
  }, [mode]);

  useEffect(() => {
    return () => {
      stopConversation();
    };
  }, []);

  const startConversation = async () => {
    try {
      wsRef.current = new WebSocket(`ws://${window.location.hostname}:8080`);

      wsRef.current.onopen = () => {
        setIsConnected(true);
        setStatus('Listening');
      };

      wsRef.current.onmessage = async (event) => {
        if (typeof event.data === 'string') {
          try {
            const data = JSON.parse(event.data);
            
            if (data.type === 'clear_buffer') {
              console.log('[Frontend] Barge-in detected, clearing audio buffer...');
              if (audioContextRef.current) {
                audioContextRef.current.close();
                audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)({
                  sampleRate: 16000
                });
                nextPlayTimeRef.current = audioContextRef.current.currentTime;
              }
              setStatus('Listening');
            } 
            
            else if (data.type === 'mode_switch') {
              console.log(`[Frontend] Mode switch: ${data.mode}`);
              setMode(data.mode);
              // Kill music if switching to emergency
              if (data.mode === 'emergency' && musicRef.current) {
                musicRef.current.pause();
                musicRef.current = null;
                setNowPlaying(null);
              }
            }
            
            else if (data.type === 'action_log') {
              console.log(`[Frontend] Action Log Received:`, data);
              setActionLogs((prev) => [{
                time: new Date().toLocaleTimeString(),
                tool: data.tool,
                details: data.details,
                isEmergency: EMERGENCY_TOOLS.includes(data.tool)
              }, ...prev]);
            }
            
            else if (data.type === 'hardware_action') {
              if (data.action === 'play_music') {
                console.log(`[Frontend] Playing music: ${data.song}`);
                setNowPlaying(data.song);
                // Play actual audio using HTML5 Audio
                try {
                  if (musicRef.current) {
                    musicRef.current.pause();
                  }
                  // Use a royalty-free ambient track
                  musicRef.current = new Audio('https://cdn.pixabay.com/audio/2022/05/27/audio_1808fbf07a.mp3');
                  musicRef.current.loop = true;
                  musicRef.current.volume = 0.4;
                  musicRef.current.play().catch(e => console.log('[Music] Autoplay blocked:', e));
                } catch(e) {
                  console.log('[Music] Playback error:', e);
                }
              }
            }

            else if (data.type === 'ai_transcript') {
              setAiTranscript(data.text);
              // Clear after 6 seconds
              setTimeout(() => setAiTranscript(''), 6000);
            }

          } catch (e) {
            console.error('Error parsing WebSocket message:', e);
          }
        }
        else if (event.data instanceof Blob) {
          setStatus('AI Speaking');
          const arrayBuffer = await event.data.arrayBuffer();
          playSeamlessAudio(arrayBuffer);
          
          setTimeout(() => {
            if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
              setStatus('Listening');
            }
          }, 1500);
        }
      };

      wsRef.current.onclose = () => {
        setIsConnected(false);
        setStatus('Disconnected');
        setActionLogs([]);
        setNowPlaying(null);
        setMode('civilian');
        stopConversation();
      };

      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 16000
      });
      nextPlayTimeRef.current = audioContextRef.current.currentTime;

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorderRef.current = new MediaRecorder(stream);

      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(event.data);
        }
      };

      mediaRecorderRef.current.start(250);

    } catch (error) {
      console.error('Error starting conversation:', error);
      alert('Failed to access microphone or connect to server.');
      setStatus('Disconnected');
      setIsConnected(false);
    }
  };

  const stopConversation = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
    }
    if (wsRef.current) {
      wsRef.current.close();
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (musicRef.current) {
      musicRef.current.pause();
      musicRef.current = null;
    }
    setIsConnected(false);
    setStatus('Disconnected');
    setNowPlaying(null);
    setMode('civilian');
  };

  const playSeamlessAudio = (arrayBuffer) => {
    if (!audioContextRef.current) return;

    const int16Array = new Int16Array(arrayBuffer);
    const float32Array = new Float32Array(int16Array.length);
    
    for (let i = 0; i < int16Array.length; i++) {
      float32Array[i] = int16Array[i] / 32768.0;
    }

    const audioBuffer = audioContextRef.current.createBuffer(1, float32Array.length, 16000);
    audioBuffer.getChannelData(0).set(float32Array);

    const source = audioContextRef.current.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContextRef.current.destination);

    const currentTime = audioContextRef.current.currentTime;
    if (currentTime > nextPlayTimeRef.current) {
      nextPlayTimeRef.current = currentTime;
    }
    
    source.start(nextPlayTimeRef.current);
    nextPlayTimeRef.current += audioBuffer.duration;
  };

  const getStatusClass = () => {
    if (status === 'Disconnected') return 'status-disconnected';
    if (status === 'Listening') return 'status-listening';
    if (status === 'AI Speaking') return 'status-speaking';
    return '';
  };

  const getToolIcon = (toolName) => TOOL_ICONS[toolName] || '⚙️';

  const getToolDisplayName = (toolName) => {
    const names = {
      log_vitals: 'Vitals Logged',
      administer_medication: 'Medication',
      trigger_trauma_alert: 'Trauma Alert',
      dispatch_medevac: 'Medevac Dispatch',
      book_movie_tickets: 'Movie Booking',
      play_device_music: 'Music Player',
    };
    return names[toolName] || toolName;
  };

  const formatLogDetails = (tool, detailsStr) => {
    try {
      const args = JSON.parse(detailsStr);
      switch(tool) {
        case 'book_movie_tickets':
          return `🍿 ${args.movie_name} | 📍 ${args.theater} | 🎟️ ${args.tickets} tickets`;
        case 'play_device_music':
          return `🎶 ${args.song_name}`;
        case 'log_vitals': {
          const parts = [];
          if (args.heart_rate) parts.push(`❤️ ${args.heart_rate} BPM`);
          if (args.blood_pressure) parts.push(`🩸 ${args.blood_pressure}`);
          if (args.oxygen_level) parts.push(`🫁 ${args.oxygen_level}%`);
          return parts.join(' | ');
        }
        case 'administer_medication':
          return `💉 ${args.drug_name} • ${args.dosage}`;
        case 'trigger_trauma_alert':
          return `⏱️ ETA: ${args.eta_minutes} min | ⚠️ ${args.injury_type}`;
        case 'dispatch_medevac':
          return `📍 ${args.coordinates} | 🔐 ${args.auth_code}`;
        default:
          return detailsStr;
      }
    } catch(e) {
      return detailsStr;
    }
  };

  return (
    <div className={`app-container ${mode}`}>
      {/* Emergency flash overlay */}
      {mode === 'emergency' && <div className="emergency-flash" />}

      {/* Mode Badge */}
      <div className={`mode-badge ${mode}`}>
        <span className="badge-dot" />
        {mode === 'civilian' ? 'Civilian Mode' : '⚠ Code Red Active'}
      </div>

      {/* Header */}
      <div className={`header ${mode}`}>
        <h1>{mode === 'civilian' ? 'Aegis' : 'AEGIS // CODE RED'}</h1>
        <p>{mode === 'civilian' 
          ? 'Your Dual-State Voice Agent' 
          : 'Emergency Medical Orchestrator'}</p>
      </div>

      {/* Status Indicator */}
      <div className={`status-indicator ${getStatusClass()}`}>
        <div className="orb"></div>
        <span>{status}</span>
      </div>

      {/* Waveform */}
      <div className={`wave-container ${status === 'Listening' || status === 'AI Speaking' ? 'active' : ''}`}>
        <div className="bar"></div>
        <div className="bar"></div>
        <div className="bar"></div>
        <div className="bar"></div>
        <div className="bar"></div>
      </div>

      {/* Music Player Bar (Civilian Only) */}
      {nowPlaying && (
        <div className="music-bar">
          <span className="music-icon">🎵</span>
          <span className="music-text">Now Playing: {nowPlaying}</span>
          <div className="music-eq">
            <div className="eq-bar"></div>
            <div className="eq-bar"></div>
            <div className="eq-bar"></div>
            <div className="eq-bar"></div>
          </div>
        </div>
      )}

      {/* AI Transcript Bubble */}
      {aiTranscript && (
        <div className="ai-transcript-bubble">
          <span className="transcript-label">Aegis:</span>
          <span className="transcript-text">{aiTranscript}</span>
        </div>
      )}

      {/* Live Action Log */}
      <div className="action-log-container">
        <h3>{mode === 'civilian' ? '📋 Activity Log' : '🚨 Operations Log'}</h3>
        {actionLogs.length === 0 ? (
          <p className="no-logs">
            {mode === 'civilian' 
              ? 'Say "Book 2 tickets for Marvel at Orion Mall"' 
              : 'Awaiting trauma input...'}
          </p>
        ) : (
          <ul className="action-log-list">
            {actionLogs.map((log, i) => (
              <li key={i} className={`action-log-item ${log.isEmergency ? 'tool-emergency' : 'tool-civilian'}`}>
                <span className="log-time">{log.time}</span>
                <span className="log-tool">
                  <span className="tool-icon">{getToolIcon(log.tool)}</span>
                  {getToolDisplayName(log.tool)}
                </span>
                <span className="log-details">{formatLogDetails(log.tool, log.details)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Controls */}
      <div className="controls">
        {!isConnected ? (
          <button className="btn-primary" onClick={startConversation}>
            Start Conversation
          </button>
        ) : (
          <button className="btn-primary btn-danger" onClick={stopConversation}>
            End Conversation
          </button>
        )}
      </div>
    </div>
  );
}

export default App;
