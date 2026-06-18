/**
 * server.js — Main entry point
 *
 * Runs HTTP and WebSocket on the SAME port (8080).
 * Nginx (on EC2) terminates SSL and reverse-proxies to this port.
 *
 * Routes:
 *   GET  /health  → 200 OK  (Nginx / monitoring health check)
 *   GET  /answer  → Plivo XML  (called when callee picks up)
 *   POST /hangup  → 200 OK  (called when call ends)
 *   WS   /stream  → Plivo audio stream  (persistent per call)
 */

/**
 * server.js — Main entry point with FULL DEBUG LOGGING
 * Every step logs so you can see exactly where the pipeline breaks
 */

require("dotenv").config();

const http = require("http");
const WebSocket = require("ws");
const express = require("express");
const plivo = require("plivo");
const CallSession = require("./callSession");
const logger = require("./logger");

// ── Validate required env vars on startup ─────────────────────────────────────
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
  logger.error(`Missing required env vars: ${missing.join(", ")}`);
  process.exit(1);
}

const PORT = parseInt(process.env.PORT || "8080", 10);
const BASE_URL = process.env.SERVER_BASE_URL.replace(/\/$/, "");
const SARVAM_API_KEY = process.env.SARVAM_API_KEY;
const LANGUAGE = process.env.SARVAM_LANGUAGE || "en-IN";

const WS_STREAM_URL =
  BASE_URL.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://") +
  "/stream";

// ── Express app ────────────────────────────────────────────────────────────────
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime().toFixed(0) + "s" });
});

app.get("/answer", (req, res) => {
  const callUUID = req.query.CallUUID || "unknown";
  logger.info(`[HTTP] /answer — CallUUID: ${callUUID}`);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Stream keepCallAlive="true" bidirectional="false">
    ${WS_STREAM_URL}
  </Stream>
</Response>`;

  logger.info(`[HTTP] Sending XML:\n${xml}`);
  res.set("Content-Type", "text/xml");
  res.send(xml);
});

app.post("/hangup", (req, res) => {
  logger.info(
    `[HTTP] /hangup — CallUUID: ${req.body.CallUUID} | Cause: ${req.body.HangupCause}`,
  );
  res.sendStatus(200);
});

app.post("/make-call", async (req, res) => {
  const { toNumber } = req.body;
  if (!toNumber) return res.status(400).json({ error: "toNumber is required" });
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
        answerMethod: "GET",
        hangupUrl: `${BASE_URL}/hangup`,
        hangupMethod: "POST",
        callTimeout: "60",
      },
    );
    logger.info(
      `[HTTP] Call initiated to ${toNumber} — requestUuid: ${result.requestUuid}`,
    );
    res.json({ success: true, requestUuid: result.requestUuid });
  } catch (err) {
    logger.error(`[HTTP] make-call failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── HTTP + WebSocket server ────────────────────────────────────────────────────
const httpServer = http.createServer(app);
const wss = new WebSocket.Server({ server: httpServer, path: "/stream" });
const sessions = new Map();

wss.on("connection", (ws, req) => {
  logger.info(`\n${"=".repeat(60)}`);
  logger.info(`[WS] ✅ PLIVO CONNECTED — from IP: ${req.socket.remoteAddress}`);
  logger.info(`[WS] This means Plivo opened the WebSocket successfully`);
  logger.info(`${"=".repeat(60)}`);

  let session = null;
  let chunkCount = 0; // track chunks at server level for debug

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      logger.warn(`[WS] Received non-JSON frame — ignoring`);
      return;
    }

    // ── Log EVERY event type so we know what Plivo is sending ────────────────
    if (msg.event !== "media") {
      // Don't log every media chunk — too noisy. Log everything else.
      logger.info(`[WS] Event received: "${msg.event}"`);
    }

    switch (msg.event) {
      case "connected": {
        // Plivo sends this immediately on WebSocket open
        logger.info(
          `[WS] Plivo handshake complete — protocol: ${msg.protocol}`,
        );
        break;
      }

      case "start": {
        const callUUID = msg.start?.callId || `call-${Date.now()}`;
        const fmt = msg.start?.mediaFormat || {};
        logger.info(`[WS] CALL STARTED — ${callUUID}`);
        logger.info(
          `[WS] encoding: ${fmt.encoding} | sampleRate: ${fmt.sampleRate}`,
        );

        session = new CallSession({
          callUUID,
          sarvamApiKey: SARVAM_API_KEY,
          language: LANGUAGE,
        });
        sessions.set(callUUID, session);

        // Start STT first
        session
          .start()
          .catch((err) =>
            logger.error(`[WS] Session start failed: ${err.message}`),
          );

        // Play greeting immediately after stream opens
        // Small delay to let STT connect first
        setTimeout(() => {
          session
            .playGreeting()
            .catch((err) =>
              logger.error(`[WS] Greeting failed: ${err.message}`),
            );
        }, 1000);

        break;
      }

      case "media": {
        if (!session) {
          logger.warn(`[WS] Got media chunk but no session — ignoring`);
          return;
        }

        chunkCount++;

        // Log every 50th chunk so you can see audio IS flowing
        // without flooding logs
        if (chunkCount % 50 === 0) {
          logger.info(
            `[WS] Audio flowing — chunk #${chunkCount} received from Plivo`,
          );
        }

        // Log the very first chunk specially
        if (chunkCount === 1) {
          logger.info(
            `[WS] ✅ First audio chunk received! Audio is flowing from Plivo`,
          );
          logger.info(
            `[WS]    payload length: ${msg.media?.payload?.length} chars (base64)`,
          );
          logger.info(`[WS]    timestamp: ${msg.media?.timestamp}ms`);
        }

        session.handleAudioChunk(msg.media?.payload);
        break;
      }

      case "stop": {
        const callUUID = msg.stop?.callId;
        logger.info(`\n[WS] CALL STREAM STOPPED — callUUID: ${callUUID}`);
        logger.info(`[WS] Total audio chunks received: ${chunkCount}`);

        if (session) {
          await session.end().catch(() => {});
          sessions.delete(callUUID);
          session = null;
          chunkCount = 0;
        }
        break;
      }

      default:
        logger.info(
          `[WS] Unknown event: ${msg.event} — full msg: ${JSON.stringify(msg)}`,
        );
    }
  });

  ws.on("close", (code, reason) => {
    logger.info(
      `[WS] Plivo WebSocket closed — code: ${code} reason: ${reason?.toString()}`,
    );
    logger.info(`[WS] Total chunks before close: ${chunkCount}`);
    if (session) {
      session.end().catch(() => {});
      session = null;
    }
  });

  ws.on("error", (err) => {
    logger.error(`[WS] ❌ WebSocket error: ${err.message}`);
  });
});

// ── Start ──────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, "0.0.0.0", () => {
  logger.info(`╔═══════════════════════════════════════════════╗`);
  logger.info(`║   Plivo + Sarvam AI — DEBUG MODE              ║`);
  logger.info(`╚═══════════════════════════════════════════════╝`);
  logger.info(`  Port        : ${PORT}`);
  logger.info(`  Health      : ${BASE_URL}/health`);
  logger.info(`  Answer URL  : ${BASE_URL}/answer`);
  logger.info(`  Stream URL  : ${WS_STREAM_URL}`);
  logger.info(`  Language    : ${LANGUAGE}`);
  logger.info(
    `  Sarvam key  : ${SARVAM_API_KEY ? SARVAM_API_KEY.slice(0, 6) + "..." : "❌ MISSING"}`,
  );
  logger.info(`  Backend URL : ${process.env.BACKEND_API_URL}`);
});

// ── Graceful shutdown ──────────────────────────────────────────────────────────
const shutdown = async (signal) => {
  logger.info(`[Main] ${signal} received — shutting down`);
  for (const [callUUID, session] of sessions.entries()) {
    await session.end().catch(() => {});
  }
  sessions.clear();
  httpServer.close(() => {
    logger.info("[Main] Closed");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", (err) =>
  logger.error(`Uncaught: ${err.message}`),
);
process.on("unhandledRejection", (reason) =>
  logger.error(`Unhandled: ${reason}`),
);
