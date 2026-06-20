// /**
//  * server.js
//  *
//  * Plivo outbound call bot:
//  *   POST /make-call  → dials the number
//  *   POST /answer     → returns XML (Speak greeting + bidirectional Stream)
//  *   WS   /stream     → receives Plivo audio, pipes to Sarvam STT
//  *
//  * Flow:
//  *   call answered → greeting played → stream opens → user speaks
//  *   → Sarvam transcribes → handleTranscript() called with text
//  *   → (TODO) fetch audio URL from your API → play it back
//  */

require("dotenv").config();

const http = require("http");
const WebSocket = require("ws");
const express = require("express");
const plivo = require("plivo");
const CallSession = require("./callSession");
const ConversationManager = require("./conversationManager");
const logger = require("./logger");

const REQUIRED = [
  "PLIVO_AUTH_ID",
  "PLIVO_AUTH_TOKEN",
  "PLIVO_FROM_NUMBER",
  "SARVAM_API_KEY",
  "SERVER_BASE_URL",
  "GREETING_AUDIO_URL",
];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  logger.error(`Missing env vars: ${missing.join(", ")}`);
  process.exit(1);
}

const PORT = parseInt(process.env.PORT || "8080", 10);
const BASE_URL = process.env.SERVER_BASE_URL.replace(/\/$/, "");
const LANGUAGE = process.env.SARVAM_LANGUAGE || "en-IN";
const GREETING_AUDIO_URL = process.env.GREETING_AUDIO_URL; // your wav/mp3 with greeting + language question
const WS_STREAM_URL =
  BASE_URL.replace(/^https/, "wss").replace(/^http/, "ws") + "/stream";

const plivoClient = new plivo.Client(
  process.env.PLIVO_AUTH_ID,
  process.env.PLIVO_AUTH_TOKEN,
);

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get("/health", (_req, res) =>
  res.json({ status: "ok", uptime: process.uptime().toFixed(0) + "s" }),
);

/**
 * /answer — plays greeting audio (which already includes the language question),
 * then opens the bidirectional stream to receive caller audio.
 */
app.all("/answer", (_req, res) => {
  logger.info(`[HTTP] /answer`);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${GREETING_AUDIO_URL}</Play>
  <Stream
    bidirectional="true"
    keepCallAlive="true"
    contentType="audio/x-mulaw;rate=8000">
    ${WS_STREAM_URL}
  </Stream>
</Response>`;

  logger.info(`[HTTP] XML:\n${xml}`);
  res.set("Content-Type", "text/xml").send(xml);
});

app.post("/hangup", (req, res) => {
  logger.info(`[HTTP] /hangup — ${req.body?.CallUUID}`);
  res.sendStatus(200);
});

app.post("/make-call", async (req, res) => {
  const { toNumber } = req.body;
  if (!toNumber) return res.status(400).json({ error: "toNumber required" });

  try {
    const result = await plivoClient.calls.create(
      process.env.PLIVO_FROM_NUMBER,
      toNumber,
      `${BASE_URL}/answer`,
      {
        answerMethod: "POST",
        hangupUrl: `${BASE_URL}/hangup`,
        hangupMethod: "POST",
      },
    );
    logger.info(`[MAKE_CALL] Success — ${result.requestUuid}`);
    res.json(result);
  } catch (err) {
    logger.error(`[MAKE_CALL] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── WebSocket /stream ─────────────────────────────────────────────────────────
const httpServer = http.createServer(app);
const wss = new WebSocket.Server({ server: httpServer, path: "/stream" });

const MULAW_SILENCE = Buffer.alloc(160, 0xff);

wss.on("connection", (ws, req) => {
  logger.info(`[WS] Connected from ${req.socket.remoteAddress}`);

  let session = null;
  let conv = null;
  let callUUID = null;
  let chunkCount = 0;
  let keepAlive = null;
  let isPlayingAudio = false;

  const startKeepAlive = () => {
    keepAlive = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            event: "playAudio",
            media: {
              contentType: "audio/x-mulaw;rate=8000",
              sampleRate: 8000,
              payload: MULAW_SILENCE.toString("base64"),
            },
          }),
        );
      }
    }, 5000);
  };

  const stopKeepAlive = () => {
    clearInterval(keepAlive);
    keepAlive = null;
  };

  const playAudioUrl = async (audioUrl) => {
    if (!audioUrl || !callUUID) return;
    if (isPlayingAudio) {
      logger.warn(`[${callUUID}] Already playing — skipping`);
      return;
    }
    isPlayingAudio = true;
    try {
      logger.info(`[${callUUID}] 🔊 Playing: ${audioUrl}`);
      await plivoClient.calls.playMusic(callUUID, audioUrl); // ← only change
    } catch (err) {
      logger.error(`[${callUUID}] play error: ${err.message}`);
    } finally {
      setTimeout(() => {
        isPlayingAudio = false;
      }, 3000);
    }
  };

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.event) {
      case "start": {
        callUUID =
          msg.start?.callId || msg.start?.streamSid || `call-${Date.now()}`;
        logger.info(`[WS] START — callUUID: ${callUUID}`);

        conv = new ConversationManager(callUUID);
        session = new CallSession({
          callUUID,
          sarvamApiKey: process.env.SARVAM_API_KEY,
          language: LANGUAGE,
          onTranscriptReady: (transcript) => onTranscript(transcript),
        });

        await session.start();
        startKeepAlive();
        // No extra audio to play here — greeting + language question
        // was already played by <Play> in the /answer XML before stream opened
        logger.info(`[WS] Session ready ✅`);
        break;
      }

      case "media": {
        if (!session || !msg.media?.payload) return;
        chunkCount++;
        if (chunkCount === 1) logger.info(`[WS] First audio chunk`);
        if (chunkCount % 500 === 0) logger.info(`[WS] Chunks: ${chunkCount}`);
        session.handleAudioChunk(msg.media.payload);
        break;
      }

      case "stop": {
        logger.info(`[WS] STOP — total chunks: ${chunkCount}`);
        stopKeepAlive();
        if (session) {
          await session.end();
          session = null;
        }
        break;
      }

      default:
        break; // ignore "incorrectPayload" and other housekeeping events
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

  async function onTranscript(transcript) {
    logger.info(`\n${"─".repeat(60)}`);
    logger.info(`[TRANSCRIPT] "${transcript}"`);
    logger.info(`${"─".repeat(60)}\n`);

    if (!conv) return;

    try {
      const { audioUrl, done, language } =
        await conv.handleTranscript(transcript);
      if (language) logger.info(`[CONV] Language: ${language}`);

      if (audioUrl) {
        await playAudioUrl(audioUrl);

        if (done) {
          // Estimate audio duration from env, default 6s — set GOODBYE_AUDIO_DURATION_MS in .env
          // to match the length of your longest goodbye audio file
          const delay = parseInt(
            process.env.GOODBYE_AUDIO_DURATION_MS || "9000",
            10,
          );
          logger.info(
            `[CONV] done=true — hanging up in ${delay}ms after goodbye audio`,
          );
          setTimeout(async () => {
            try {
              await plivoClient.calls.hangup(callUUID);
              logger.info(`[CONV] ✅ Call hung up`);
            } catch (err) {
              // Call may have already ended by the time we hang up — that's fine
              logger.warn(
                `[CONV] Hangup skipped (call likely already ended): ${err.message}`,
              );
            }
          }, delay);
        }
      } else if (done) {
        // No audio to play — hang up immediately
        logger.info(`[CONV] done=true, no audio — hanging up now`);
        try {
          await plivoClient.calls.hangup(callUUID);
          logger.info(`[CONV] ✅ Call hung up`);
        } catch (err) {
          logger.warn(`[CONV] Hangup skipped: ${err.message}`);
        }
      }
    } catch (err) {
      logger.error(`[TRANSCRIPT] Handler error: ${err.message}`);
    }
  }
});

httpServer.listen(PORT, "0.0.0.0", () => {
  logger.info(`\n🚀 Server running on port ${PORT}`);
  logger.info(`   Answer  : ${BASE_URL}/answer`);
  logger.info(`   Stream  : ${WS_STREAM_URL}`);
  logger.info(`   Greeting: ${GREETING_AUDIO_URL}`);
});

process.on("SIGINT", () => {
  logger.info(`Shutting down`);
  process.exit(0);
});