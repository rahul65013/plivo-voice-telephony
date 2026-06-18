require("dotenv").config();

const http = require("http");
const WebSocket = require("ws");
const express = require("express");
const plivo = require("plivo");
const CallSession = require("./callSession");
const logger = require("./logger");

const REQUIRED = [
  "PLIVO_AUTH_ID",
  "PLIVO_AUTH_TOKEN",
  "PLIVO_FROM_NUMBER",
  "SARVAM_API_KEY",
  "SERVER_BASE_URL",
];

const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  logger.error(`[BOOT] Missing env vars: ${missing.join(", ")}`);
  process.exit(1);
}

const PORT = parseInt(process.env.PORT || "8080", 10);
const BASE_URL = process.env.SERVER_BASE_URL.replace(/\/$/, "");
const LANGUAGE = process.env.SARVAM_LANGUAGE || "en-IN";
const GREETING_TEXT =
  process.env.GREETING_TEXT ||
  "Hello! Thank you for your time. How can I help you today?";

// wss:// URL for Plivo's <Stream> element
const WS_STREAM_URL =
  BASE_URL.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://") +
  "/stream";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* ───────────────────────── HEALTH ───────────────────────── */
app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime().toFixed(0) + "s" });
});

/* ─────────────────────────────────────────────────────────────────────────────
   /answer  — called by Plivo when the callee picks up.

   KEY DESIGN:
   1. <Speak> plays the greeting. Plivo waits for it to finish.
   2. <Stream bidirectional="true"> opens the WebSocket.
      - bidirectional="true"  →  Plivo keeps the call alive as long as the
        WS connection is open (even with no audio being sent back).
      - Without bidirectional the call is torn down the moment the stream
        element "ends", which is why you saw the call drop after greetings.
   3. The WS server sends a silent keep-alive every 5 s so Plivo never
      times out the stream.
──────────────────────────────────────────────────────────────────────────── */
app.post("/answer", (req, res) => {
  logger.info(`[HTTP] /answer triggered`);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak voice="Polly.Aditi" language="en-IN">${escapeXml(GREETING_TEXT)}</Speak>
  <Stream
    bidirectional="true"
    keepCallAlive="true"
    contentType="audio/x-mulaw;rate=8000"
    audioTrack="inbound">
    ${WS_STREAM_URL}
  </Stream>
</Response>`;

  logger.info(`[HTTP] Sending Answer XML:\n${xml}`);
  res.set("Content-Type", "text/xml");
  res.send(xml);
});

// Plivo may call /answer via GET for outbound — support both
app.get("/answer", (req, res) => {
  req.method = "POST";
  app._router.handle(req, res);
});

/* ───────────────────────── HANGUP ───────────────────────── */
app.post("/hangup", (req, res) => {
  const callUUID = req.body?.CallUUID || "unknown";
  logger.info(`[HTTP] /hangup → CallUUID: ${callUUID}`);
  res.sendStatus(200);
});

/* ───────────────────────── MAKE CALL ───────────────────────── */
app.post("/make-call", async (req, res) => {
  const { toNumber } = req.body;
  if (!toNumber) return res.status(400).json({ error: "toNumber required" });

  logger.info(`[MAKE_CALL] Dialing → ${toNumber}`);

  try {
    const client = new plivo.Client(
      process.env.PLIVO_AUTH_ID,
      process.env.PLIVO_AUTH_TOKEN,
    );

    const result = await client.calls.create(
      process.env.PLIVO_FROM_NUMBER,
      toNumber,
      `${BASE_URL}/answer`,
      {
        answerMethod: "POST",
        hangupUrl: `${BASE_URL}/hangup`,
        hangupMethod: "POST",
      },
    );

    logger.info(`[MAKE_CALL] Success → requestUuid: ${result.requestUuid}`);
    res.json(result);
  } catch (err) {
    logger.error(`[MAKE_CALL] ERROR: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   WebSocket server — /stream
──────────────────────────────────────────────────────────────────────────── */
const httpServer = http.createServer(app);
const wss = new WebSocket.Server({ server: httpServer, path: "/stream" });

// Silent mulaw frame — 20 ms of silence at 8 kHz = 160 bytes of 0xFF (mulaw silence)
const MULAW_SILENCE_20MS = Buffer.alloc(160, 0xff);

wss.on("connection", (ws, req) => {
  logger.info(`\n=============== WS CONNECTED ===============`);
  logger.info(`[WS] IP: ${req.socket.remoteAddress}`);

  let session = null;
  let chunkCount = 0;
  let streamSid = null;
  let keepAliveTimer = null;

  /* ── Keep-alive: send silent audio every 5 s so Plivo never times out ── */
  function startKeepAlive() {
    keepAliveTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN && streamSid) {
        const silenceMsg = JSON.stringify({
          event: "playAudio",
          media: {
            contentType: "audio/x-mulaw;rate=8000",
            sampleRate: 8000,
            payload: MULAW_SILENCE_20MS.toString("base64"),
          },
        });
        ws.send(silenceMsg);
      }
    }, 5000);
  }

  function stopKeepAlive() {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
  }

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      logger.warn(`[WS] Non-JSON frame ignored`);
      return;
    }

    switch (msg.event) {
      /* ── start ────────────────────────────────────────────────────── */
      case "start": {
        streamSid =
          msg.start?.streamSid || msg.start?.callId || `call-${Date.now()}`;
        const callUUID = msg.start?.callId || streamSid;

        logger.info(`\n[WS START] streamSid: ${streamSid}`);
        logger.info(`[WS START] callUUID:  ${callUUID}`);
        logger.info(
          `[WS START] Format:    ${JSON.stringify(msg.start?.mediaFormat)}`,
        );

        session = new CallSession({
          callUUID,
          sarvamApiKey: process.env.SARVAM_API_KEY,
          language: LANGUAGE,
          onTranscriptReady: async (transcript) => {
            // ── This is where you call your external API with the transcript ──
            logger.info(`\n[TRANSCRIPT READY] "${transcript}"`);
            await handleTranscript(transcript, callUUID);
          },
        });

        await session.start();
        startKeepAlive();

        logger.info(`[WS START] Session initialized ✅`);
        break;
      }

      /* ── media ────────────────────────────────────────────────────── */
      case "media": {
        if (!session) return;
        chunkCount++;
        if (chunkCount === 1)
          logger.info(`[WS MEDIA] First audio chunk received`);
        if (chunkCount % 200 === 0)
          logger.info(`[WS MEDIA] Chunks: ${chunkCount}`);

        session.handleAudioChunk(msg.media?.payload);
        break;
      }

      /* ── stop ─────────────────────────────────────────────────────── */
      case "stop": {
        logger.info(`\n[WS STOP] Call ended. Total chunks: ${chunkCount}`);
        stopKeepAlive();
        if (session) {
          await session.end();
          session = null;
        }
        chunkCount = 0;
        break;
      }

      default:
        logger.warn(`[WS] Unknown event: ${msg.event}`);
    }
  });

  ws.on("close", () => {
    logger.info(`[WS] Connection closed`);
    stopKeepAlive();
    if (session) {
      session.end().catch(() => {});
      session = null;
    }
  });

  ws.on("error", (err) => {
    logger.error(`[WS ERROR] ${err.message}`);
    stopKeepAlive();
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   handleTranscript — replace with your actual API call logic
──────────────────────────────────────────────────────────────────────────── */
async function handleTranscript(transcript, callUUID) {
  try {
    logger.info(`[TRANSCRIPT_HANDLER] CallUUID: ${callUUID}`);
    logger.info(`[TRANSCRIPT_HANDLER] Transcript: "${transcript}"`);

    // TODO: replace this with your actual API call
    // Example:
    // const response = await fetch(process.env.BACKEND_API_URL, {
    //   method: "POST",
    //   headers: { "Content-Type": "application/json" },
    //   body: JSON.stringify({ transcript, callUUID }),
    // });
    // const { audioUrl } = await response.json();
    // logger.info(`[TRANSCRIPT_HANDLER] Got audio URL: ${audioUrl}`);
    // Then you can stream that audio back via the WS if needed
  } catch (err) {
    logger.error(`[TRANSCRIPT_HANDLER] Error: ${err.message}`);
  }
}

/* ───────────────────────── UTILS ───────────────────────── */
function escapeXml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/* ───────────────────────── START ───────────────────────── */
httpServer.listen(PORT, "0.0.0.0", () => {
  logger.info(`\n🚀 SERVER STARTED`);
  logger.info(`   Port:    ${PORT}`);
  logger.info(`   Answer:  ${BASE_URL}/answer`);
  logger.info(`   Stream:  ${WS_STREAM_URL}`);
  logger.info(`   Greeting: "${GREETING_TEXT}"`);
});

process.on("SIGINT", () => {
  logger.info(`[SYSTEM] SIGINT — shutting down`);
  process.exit(0);
});
