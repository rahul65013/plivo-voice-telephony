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
const BASE_URL = process.env.SERVER_BASE_URL.replace(/\/$/, ""); // trim trailing slash
const SARVAM_API_KEY = process.env.SARVAM_API_KEY;
const LANGUAGE = process.env.SARVAM_LANGUAGE || "en-IN";

// WebSocket URL that Plivo will connect to
// BASE_URL is https:// → replace with wss://
const WS_STREAM_URL =
  BASE_URL.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://") +
  "/stream";

// ── Express app (HTTP routes) ──────────────────────────────────────────────────
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Health check — used by Nginx and monitoring
app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime().toFixed(0) + "s" });
});

// Plivo calls this when the callee answers the outbound call
app.get("/answer", (req, res) => {
  const callUUID = req.query.CallUUID || "unknown";

  const response = new plivo.Response();

  // 1. PLAY greeting first
  response.addSpeak("Hello, I am your AI assistant. How can I help you today?");

  // OR if you want audio file:
  // response.addPlay("https://your-domain/welcome.mp3");

  // 2. START STREAM after greeting
  response.addStream(WS_STREAM_URL, {
    bidirectional: "false",
    audioTrack: "inbound",
    streamTimeout: "86400",
    keepCallAlive: "true",
  });

  // 3. keep call alive
  response.addWait({ length: "7200" });

  res.set("Content-Type", "text/xml");
  res.send(response.toXML());
});

// Plivo calls this when the call ends
app.post("/hangup", (req, res) => {
  logger.info(
    `[HTTP] /hangup → CallUUID: ${req.body.CallUUID} | Cause: ${req.body.HangupCause}`,
  );
  res.sendStatus(200);
});

// Trigger an outbound call manually via REST
// POST /make-call  { "toNumber": "+919876543210" }
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
      `[HTTP] Outbound call initiated → ${toNumber} | requestUuid: ${result.requestUuid}`,
    );
    res.json({ success: true, requestUuid: result.requestUuid });
  } catch (err) {
    logger.error(`[HTTP] make-call failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── HTTP server (shared with WebSocket server) ────────────────────────────────
const httpServer = http.createServer(app);

// ── WebSocket server — attached to same httpServer, path /stream ──────────────
const wss = new WebSocket.Server({ server: httpServer, path: "/stream" });

// Active sessions map: callUUID → CallSession
const sessions = new Map();

wss.on("connection", (ws, req) => {
  const remoteIp = req.socket.remoteAddress;
  logger.info(`[WS] New Plivo connection from ${remoteIp}`);

  let session = null;

  ws.on("message", async (raw) => {
    // All Plivo messages are JSON text frames
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignore non-JSON
    }

    switch (msg.event) {
      // ── "start": fired once when Plivo begins streaming for a call ──────────
      case "start": {
        const callUUID = msg.start?.callId || `call-${Date.now()}`;
        const fmt = msg.start?.mediaFormat || {};

        logger.info(`[WS] ── CALL STARTED ──────────────────────────────`);
        logger.info(`[WS]   callUUID   : ${callUUID}`);
        logger.info(`[WS]   encoding   : ${fmt.encoding}`); // audio/x-mulaw
        logger.info(`[WS]   sampleRate : ${fmt.sampleRate}`); // 8000
        logger.info(`[WS]   channels   : ${fmt.channels}`); // 1
        logger.info(`[WS] ──────────────────────────────────────────────`);

        session = new CallSession({
          callUUID,
          sarvamApiKey: SARVAM_API_KEY,
          language: LANGUAGE,
        });
        sessions.set(callUUID, session);

        // Connect to Sarvam STT (non-blocking — audio will buffer until ready)
        session.start().catch((err) => {
          logger.error(
            `[WS] Failed to start session for ${callUUID}: ${err.message}`,
          );
        });
        break;
      }

      // ── "media": fired for every audio chunk (~20ms of audio each) ──────────
      case "media": {
        if (!session) return;
        /**
         * msg.media:
         *   payload   — base64 μ-law audio bytes  ← the actual audio
         *   timestamp — ms from call start
         *   chunk     — sequence number (1-based)
         */
        session.handleAudioChunk(msg.media?.payload);
        break;
      }

      // ── "stop": fired when Plivo ends the stream ─────────────────────────────
      case "stop": {
        const callUUID = msg.stop?.callId;
        logger.info(`[WS] CALL STOPPED — callUUID: ${callUUID}`);

        if (session) {
          await session.end().catch(() => {});
          sessions.delete(callUUID);
          session = null;
        }
        break;
      }

      // ── "connected": Plivo's initial handshake ack — no action needed ────────
      case "connected":
        logger.debug(`[WS] Plivo connected handshake received`);
        break;

      default:
        logger.debug(`[WS] Unhandled event: ${msg.event}`);
    }
  });

  ws.on("close", (code) => {
    logger.info(`[WS] Connection closed — code: ${code}`);
    if (session) {
      session.end().catch(() => {});
      session = null;
    }
  });

  ws.on("error", (err) => {
    logger.error(`[WS] Socket error: ${err.message}`);
  });
});

// ── Start server ──────────────────────────────────────────────────────────────
httpServer.listen(PORT, "0.0.0.0", () => {
  logger.info(`╔═══════════════════════════════════════════════╗`);
  logger.info(`║  Plivo + Sarvam AI Production Server          ║`);
  logger.info(`╚═══════════════════════════════════════════════╝`);
  logger.info(`  Port         : ${PORT}`);
  logger.info(`  Health       : ${BASE_URL}/health`);
  logger.info(`  Answer URL   : ${BASE_URL}/answer  ← set this in Plivo`);
  logger.info(`  Stream URL   : ${WS_STREAM_URL}  ← Plivo connects here`);
  logger.info(`  Language     : ${LANGUAGE}`);
  logger.info(`  Backend API  : ${process.env.BACKEND_API_URL}`);
});

// ── Graceful shutdown (systemd / PM2 sends SIGTERM) ───────────────────────────
const shutdown = async (signal) => {
  logger.info(`[Main] ${signal} — shutting down gracefully`);

  // End all active sessions
  for (const [callUUID, session] of sessions.entries()) {
    logger.info(`[Main] Ending session: ${callUUID}`);
    await session.end().catch(() => {});
  }
  sessions.clear();

  httpServer.close(() => {
    logger.info("[Main] HTTP server closed");
    process.exit(0);
  });

  // Force exit after 10s if something hangs
  setTimeout(() => process.exit(1), 10_000);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("uncaughtException", (err) => {
  logger.error(`Uncaught exception: ${err.message}`, err);
  // Don't exit — PM2 would restart the process anyway
});

process.on("unhandledRejection", (reason) => {
  logger.error(`Unhandled rejection: ${reason}`);
});
