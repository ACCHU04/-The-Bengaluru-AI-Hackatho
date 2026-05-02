# AEGIS PROTOCOL — Run Instructions

## Step 1 — Get your FREE Groq API key (2 minutes)
1. Go to: https://console.groq.com
2. Sign up (free, no credit card)
3. Click "API Keys" → "Create API Key"
4. Copy the key

## Step 2 — Add it to the .env file
Open `voice-agent-backend/.env` and replace `your_groq_key_here` with your Groq key.
Your Deepgram and Cartesia keys are already filled in.

## Step 3 — Install backend dependencies
```
cd voice-agent-backend
npm install
```

## Step 4 — Start the backend
```
node server.js
```
You should see: "AEGIS PROTOCOL — Backend Running on port 8080"

## Step 5 — Start the frontend (new terminal)
```
cd voice-agent-frontend
npm install
npm start
```
Opens at http://localhost:3000

## Step 6 — Test on your phone (for demo)
In a 3rd terminal:
```
npx localtunnel --port 3000
```
It gives you a URL like `https://xyz.loca.lt`
Open that URL on your phone → tap "Start Conversation"

---

## Demo Commands to try

**Civilian Mode:**
- "Book 2 tickets for Avengers at PVR Koramangala"
- "Play Blinding Lights by The Weeknd"
- "What is Aegis?"

**Switch to Emergency:**
- "Initiate Code Red"

**Emergency Mode:**
- "Patient is 35-year-old male, blunt trauma, heart rate 130, oxygen 88"
- "Administer 1mg adrenaline IV"
- "ETA 6 minutes, severe burns"
- "Dispatch medevac to sector 4, authorization Sigma-Niner"

---

## Why Groq instead of Gemini?
- Gemini 2.5 Flash = PAID tier
- Gemini 1.5 Flash free = 15 requests/minute cap (kills a live demo)
- Groq = 100% free, llama-3.3-70b, ~500 tokens/second (fastest available)
- Full tool/function calling support
