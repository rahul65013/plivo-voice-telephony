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
  "BACKEND_API_URL",
];

const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  logger.error(`[BOOT] Missing env vars: ${missing.join(", ")}`);
  process.exit(1);
}

const PORT = parseInt(process.env.PORT || "8080", 10);
const BASE_URL = process.env.SERVER_BASE_URL.replace(/\/$/, "");
const LANGUAGE = process.env.SARVAM_LANGUAGE || "en-IN";

const WS_STREAM_URL =
  BASE_URL.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://") +
  "/stream";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* ───────────────────────── HEALTH ───────────────────────── */
app.get("/health", (req, res) => {
  logger.info(`[HTTP] /health hit`);
  res.json({ status: "ok", uptime: process.uptime().toFixed(0) + "s" });
});

/* ───────────────────────── ANSWER ───────────────────────── */
app.get("/answer", (req, res) => {
  logger.info(`[HTTP] /answer triggered`);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Stream
    bidirectional="false"
    keepCallAlive="true">
    ${WS_STREAM_URL}
  </Stream>
</Response>`;

  logger.info(`[HTTP] Sending STREAM ONLY XML`);

  res.set("Content-Type", "text/xml");
  res.send(xml);
});

/* ───────────────────────── MAKE CALL ───────────────────────── */
app.post("/make-call", async (req, res) => {
  const { toNumber } = req.body;

  logger.info(`[MAKE_CALL] Request received → ${toNumber}`);

  if (!toNumber) {
    logger.warn(`[MAKE_CALL] Missing toNumber`);
    return res.status(400).json({ error: "toNumber required" });
  }

  try {
    const client = new plivo.Client(
      process.env.PLIVO_AUTH_ID,
      process.env.PLIVO_AUTH_TOKEN,
    );

    logger.info(`[MAKE_CALL] Dialing → ${toNumber}`);

    const result = await client.calls.create(
      process.env.PLIVO_FROM_NUMBER,
      toNumber,
      `${BASE_URL}/answer`,
      {
        answerMethod: "GET",
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

/* ───────────────────────── WS ───────────────────────── */
const httpServer = http.createServer(app);
const wss = new WebSocket.Server({ server: httpServer, path: "/stream" });

const sessions = new Map();

wss.on("connection", (ws, req) => {
  logger.info(`\n=============== WS CONNECTED ===============`);
  logger.info(`[WS] Remote IP: ${req.socket.remoteAddress}`);

  let session = null;
  let chunkCount = 0;

  ws.on("message", async (raw) => {
    let msg;

    try {
      msg = JSON.parse(raw.toString());
    } catch {
      logger.warn(`[WS] Non-JSON frame ignored`);
      return;
    }

    logger.info(`[WS EVENT] ${msg.event}`);

    switch (msg.event) {
      case "start": {
        const callUUID = msg.start?.callId || `call-${Date.now()}`;

        logger.info(`\n[WS START] CallUUID: ${callUUID}`);
        logger.info(
          `[WS START] Format: ${JSON.stringify(msg.start?.mediaFormat)}`,
        );

        session = new CallSession({
          callUUID,
          sarvamApiKey: process.env.SARVAM_API_KEY,
          language: LANGUAGE,
        });

        sessions.set(callUUID, session);

        await session.start();

        logger.info(`[WS START] Session initialized`);

        break;
      }

      case "media": {
        if (!session) return;

        chunkCount++;

        if (chunkCount === 1) {
          logger.info(`[WS MEDIA] First chunk received`);
        }

        if (chunkCount % 100 === 0) {
          logger.info(`[WS MEDIA] Chunk count: ${chunkCount}`);
        }

        session.handleAudioChunk(msg.media?.payload);
        break;
      }

      case "stop": {
        const callUUID = msg.stop?.callId;

        logger.info(`\n[WS STOP] Call ended → ${callUUID}`);
        logger.info(`[WS STOP] Total chunks: ${chunkCount}`);

        if (session) {
          await session.end();
          sessions.delete(callUUID);
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
    logger.info(`[WS CLOSED] Connection closed`);
    if (session) session.end();
  });

  ws.on("error", (err) => {
    logger.error(`[WS ERROR] ${err.message}`);
  });
});

httpServer.listen(PORT, "0.0.0.0", () => {
  logger.info(`\n🚀 SERVER STARTED`);
  logger.info(`Port: ${PORT}`);
  logger.info(`Answer: ${BASE_URL}/answer`);
  logger.info(`Stream: ${WS_STREAM_URL}`);
});

/* ───────────────────────── SHUTDOWN ───────────────────────── */
process.on("SIGINT", () => {
  logger.info(`[SYSTEM] SIGINT received`);
  process.exit(0);
});
