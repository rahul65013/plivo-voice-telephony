# Plivo Configuration Guide
# How to configure Plivo to connect to your EC2 server

## Step 1 — Get a Plivo Number

1. Log in to https://console.plivo.com
2. Go to: Phone Numbers → Buy Numbers
3. Buy a number (US, India, or wherever you're calling from)
4. Note the number — this is your PLIVO_FROM_NUMBER in .env

## Step 2 — Create an Application

1. Go to: Voice → Applications → New Application
2. Fill in:

   App Name:      Plivo Sarvam STT
   Answer URL:    https://YOUR_DOMAIN/answer     ← Method: GET
   Hangup URL:    https://YOUR_DOMAIN/hangup     ← Method: POST

3. Click Save
4. Note the App ID

## Step 3 — Assign Number to Application

1. Go to: Phone Numbers → Your Numbers
2. Click your number
3. Set: Voice Application → select "Plivo Sarvam STT"
4. Click Update

## Step 4 — Test the Setup

Test your answer URL is reachable:
  curl https://YOUR_DOMAIN/answer
  # Should return XML like:
  # <?xml version="1.0"?><Response><Stream ...>wss://...</Stream>...

Test health:
  curl https://YOUR_DOMAIN/health
  # Should return: {"status":"ok","uptime":"..."}

Trigger an outbound call:
  curl -X POST https://YOUR_DOMAIN/make-call \
    -H "Content-Type: application/json" \
    -d '{"toNumber": "+91XXXXXXXXXX"}'
  # Returns: {"success":true,"requestUuid":"..."}

## Step 5 — Watch Live Transcripts

SSH into EC2 and run:
  pm2 logs plivo-server

You'll see output like:
  [callUUID] ─────────────────────────────────────
  [callUUID] USER SAID   : "Hello, who is this?"
  [callUUID] FULL SO FAR : "Hello, who is this?"
  [callUUID] ─────────────────────────────────────
  [callUUID] 🚀 Calling backend: https://your-backend.com/api/call-response
  [callUUID] 🔊 Got audioUrl: https://...
  [callUUID] ✅ Audio playing to caller

## What Plivo Sends to Your WebSocket

When the callee picks up and Plivo opens a WebSocket to wss://YOUR_DOMAIN/stream,
it sends a sequence of JSON messages:

### 1. "start" — once, when stream begins
{
  "event": "start",
  "start": {
    "callId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",   ← this is CallUUID
    "streamId": "...",
    "accountId": "...",
    "tracks": ["inbound"],
    "mediaFormat": {
      "encoding": "audio/x-mulaw",   ← always mulaw
      "sampleRate": 8000,            ← always 8000 Hz
      "channels": 1                  ← always mono
    }
  }
}

### 2. "media" — ~50 per second, the actual audio
{
  "event": "media",
  "media": {
    "chunk": 1,                         ← sequence number
    "timestamp": "20",                  ← ms from call start
    "payload": "f8f8f8f8f8f8..."        ← base64 μ-law bytes  ← THIS IS THE AUDIO
  }
}

### 3. "stop" — once, when call ends
{
  "event": "stop",
  "stop": {
    "callId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  }
}

## What Your Backend API Must Return

POST https://your-backend.com/api/call-response
Body:
{
  "callUUID": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "userText": "Hello, who is this?",
  "fullTranscript": "Hello, who is this?"
}

Expected response:
{
  "audioUrl": "https://your-cdn.com/response-audio.mp3"
}

The audioUrl must be:
- Publicly accessible (Plivo fetches it directly)
- MP3 or WAV format
- Respond quickly — if your backend takes > 10s, this turn is skipped

## Plivo Auth IDs

Find them at: https://console.plivo.com/dashboard/
  Auth ID:    MAXXXXXXXXXXXXXXXXXX
  Auth Token: XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
