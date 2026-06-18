/**
 * server.js
 *
 * Plivo outbound call bot:
 *   POST /make-call  → dials the number
 *   POST /answer     → returns XML (Speak greeting + bidirectional Stream)
 *   WS   /stream     → receives Plivo audio, pipes to Sarvam STT
 *
 * Flow:
 *   call answered → greeting played → stream opens → user speaks
 *   → Sarvam transcribes → handleTranscript() called with text
 *   → (TODO) fetch audio URL from your API → play it back
 */

require("dotenv").config();

const http = require("http");
const WebSocket = require("ws");
const express = require("express");
const plivo = require("plivo");
const CallSession = require("./callSession");
const logger = require("./logger");

// ── Env validation ───────────────────────────────────────────────────────────

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

const WS_STREAM_URL =
  BASE_URL.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://") +
  "/stream";

// ── Express app ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get("/health", (_req, res) =>
  res.json({ status: "ok", uptime: process.uptime().toFixed(0) + "s" }),
);

/**
 * /answer — Plivo calls this when the callee picks up.
 *
 * We play the greeting then open a bidirectional stream.
 * `bidirectional="true"` keeps the call alive while the WS is open.
 * `contentType="audio/x-l16;rate=8000"` is what Plivo sends us.
 */
app.all("/answer", (_req, res) => {
  logger.info(`[HTTP] /answer triggered`);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak voice="Polly.Aditi" language="en-IN">${escapeXml(GREETING_TEXT)}</Speak>
  <Stream
    bidirectional="true"
    keepCallAlive="true"
    contentType="audio/x-mulaw;rate=8000">
    ${WS_STREAM_URL}
  </Stream>
</Response>`;

  logger.info(`[HTTP] Sending XML:\n${xml}`);
  res.set("Content-Type", "text/xml").send(xml);
});

app.post("/hangup", (req, res) => {
  logger.info(`[HTTP] /hangup — CallUUID: ${req.body?.CallUUID}`);
  res.sendStatus(200);
});

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
    logger.info(`[MAKE_CALL] Success — requestUuid: ${result.requestUuid}`);
    res.json(result);
  } catch (err) {
    logger.error(`[MAKE_CALL] ERROR: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── WebSocket server ─────────────────────────────────────────────────────────

const httpServer = http.createServer(app);
const wss = new WebSocket.Server({ server: httpServer, path: "/stream" });

// Plivo times out bidirectional streams if it hears no audio back.
// Send 20ms of μ-law silence every 5s to keep the stream alive.
const MULAW_SILENCE_20MS = Buffer.alloc(160, 0xff);

wss.on("connection", (ws, req) => {
  logger.info(`[WS] New connection from ${req.socket.remoteAddress}`);

  let session = null;
  let streamSid = null;
  let chunkCount = 0;
  let keepAliveTimer = null;

  function startKeepAlive() {
    keepAliveTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN && streamSid) {
        ws.send(
          JSON.stringify({
            event: "playAudio",
            media: {
              contentType: "audio/x-mulaw;rate=8000",
              sampleRate: 8000,
              payload: MULAW_SILENCE_20MS.toString("base64"),
            },
          }),
        );
      }
    }, 5000);
  }

  function stopKeepAlive() {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignore non-JSON frames
    }

    switch (msg.event) {
      // ── Stream opened ─────────────────────────────────────────────────────
      case "start": {
        streamSid =
          msg.start?.streamSid || msg.start?.callId || `call-${Date.now()}`;
        const callUUID = msg.start?.callId || streamSid;

        logger.info(
          `[WS] START — streamSid: ${streamSid}, callUUID: ${callUUID}`,
        );
        logger.info(
          `[WS] Media format: ${JSON.stringify(msg.start?.mediaFormat)}`,
        );

        session = new CallSession({
          callUUID,
          sarvamApiKey: process.env.SARVAM_API_KEY,
          language: LANGUAGE,
          onTranscriptReady: (transcript) =>
            handleTranscript(transcript, callUUID),
        });

        await session.start();
        startKeepAlive();
        logger.info(`[WS] Session ready ✅`);
        break;
      }

      // ── Incoming audio ────────────────────────────────────────────────────
      case "media": {
        if (!session || !msg.media?.payload) return;
        chunkCount++;
        if (chunkCount === 1) logger.info(`[WS] First audio chunk received`);
        if (chunkCount % 500 === 0)
          logger.info(`[WS] Chunks so far: ${chunkCount}`);

        session.handleAudioChunk(msg.media.payload);
        break;
      }

      // ── Call ended ────────────────────────────────────────────────────────
      case "stop": {
        logger.info(`[WS] STOP — total chunks: ${chunkCount}`);
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
    session?.end().catch(() => {});
    session = null;
  });

  ws.on("error", (err) => {
    logger.error(`[WS] Error: ${err.message}`);
    stopKeepAlive();
  });
});

// ── Transcript handler — wire your backend API here ─────────────────────────

async function handleTranscript(transcript, callUUID) {
  logger.info(`\n${"=".repeat(60)}`);
  logger.info(`[TRANSCRIPT] CallUUID : ${callUUID}`);
  logger.info(`[TRANSCRIPT] User said: "${transcript}"`);
  logger.info(`${"=".repeat(60)}\n`);

  // TODO: call your backend API and play back the response audio.
  //
  // Example:
  //   const response = await fetch(process.env.BACKEND_API_URL, {
  //     method: "POST",
  //     headers: { "Content-Type": "application/json" },
  //     body: JSON.stringify({ transcript, callUUID }),
  //   });
  //   const { audioUrl } = await response.json();
  //   playAudioToCall(callUUID, audioUrl);  // implement with Plivo REST API
}

// ── Util ─────────────────────────────────────────────────────────────────────

function escapeXml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ── Start ────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, "0.0.0.0", () => {
  logger.info(`\n🚀 Server running on port ${PORT}`);
  logger.info(`   Answer URL : ${BASE_URL}/answer`);
  logger.info(`   Stream URL : ${WS_STREAM_URL}`);
  logger.info(`   Language   : ${LANGUAGE}`);
  logger.info(`   Greeting   : "${GREETING_TEXT}"`);
});

process.on("SIGINT", () => {
  logger.info(`[SYSTEM] Shutting down...`);
  process.exit(0);
});
