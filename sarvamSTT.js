/**
 * sarvamSTT.js — with full debug logging
 */

const WebSocket = require("ws");
const logger = require("./logger");

class SarvamSTT {
  constructor({ callUUID, apiKey, language, onTranscript, onVAD, onError }) {
    this.callUUID = callUUID;
    this.apiKey = apiKey;
    this.language = language || "en-IN";
    this.onTranscript = onTranscript || (() => {});
    this.onVAD = onVAD || (() => {});
    this.onError = onError || ((e) => logger.error(`STT error: ${e.message}`));

    this.ws = null;
    this.isReady = false;
    this.audioQueue = [];
    this.reconnectCount = 0;
    this.MAX_RECONNECTS = 3;
    this.destroyed = false;
    this.audioSentCount = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      if (this.destroyed) return reject(new Error("Instance destroyed"));

      const params = new URLSearchParams({
        model: "saaras:v3",
        mode: "transcribe",
        language_code: this.language,
        sample_rate: "8000",
        input_audio_codec: "pcm_s16le",
        high_vad_sensitivity: "true",
        vad_signals: "true",
      });

      const url = `wss://api.sarvam.ai/v1/speech-to-text/streaming?${params}`;

      logger.info(`[${this.callUUID}] Sarvam STT connecting to:`);
      logger.info(`[${this.callUUID}] ${url}`);

      this.ws = new WebSocket(url, {
        headers: { "api-subscription-key": this.apiKey },
      });
      this.ws.binaryType = "nodebuffer";

      this.ws.on("open", () => {
        logger.info(`[${this.callUUID}] ✅ Sarvam WebSocket OPEN`);
        logger.info(
          `[${this.callUUID}]    Queued audio chunks to flush: ${this.audioQueue.length}`,
        );
        this.isReady = true;
        this.reconnectCount = 0;

        if (this.audioQueue.length > 0) {
          logger.info(
            `[${this.callUUID}] Flushing ${this.audioQueue.length} buffered chunks to Sarvam`,
          );
          for (const chunk of this.audioQueue) this.ws.send(chunk);
          this.audioQueue = [];
        }
        resolve();
      });

      this.ws.on("message", (data) => {
        // Log RAW message from Sarvam so we see everything it sends
        const raw = data.toString();
        logger.info(`[${this.callUUID}] 📨 Sarvam raw message: ${raw}`);

        try {
          const msg = JSON.parse(raw);
          this._handleMessage(msg);
        } catch {
          logger.debug(`[${this.callUUID}] Non-JSON from Sarvam: ${raw}`);
        }
      });

      this.ws.on("error", (err) => {
        logger.error(
          `[${this.callUUID}] ❌ Sarvam WebSocket ERROR: ${err.message}`,
        );
        logger.error(`[${this.callUUID}]    Error code: ${err.code}`);
        this.isReady = false;
        this.onError(err);
        reject(err);
      });

      this.ws.on("close", (code, reason) => {
        const r = reason?.toString() || "";
        logger.warn(
          `[${this.callUUID}] Sarvam WebSocket CLOSED — code: ${code} reason: "${r}"`,
        );
        logger.warn(
          `[${this.callUUID}] Total audio frames sent to Sarvam: ${this.audioSentCount}`,
        );
        this.isReady = false;

        // Reconnect on network drop
        if (
          !this.destroyed &&
          code === 1006 &&
          this.reconnectCount < this.MAX_RECONNECTS
        ) {
          const delay = Math.min(300 * Math.pow(2, this.reconnectCount), 4000);
          this.reconnectCount++;
          logger.warn(
            `[${this.callUUID}] Reconnecting in ${delay}ms (attempt ${this.reconnectCount}/${this.MAX_RECONNECTS})`,
          );
          setTimeout(() => this.connect().catch(this.onError), delay);
        }
      });
    });
  }

  _handleMessage(msg) {
    logger.info(`[${this.callUUID}] Sarvam message type: "${msg.type}"`);

    switch (msg.type) {
      case "transcript": {
        const text = (msg.transcript || "").trim();
        logger.info(`[${this.callUUID}] 🎯 TRANSCRIPT RECEIVED: "${text}"`);
        if (text) this.onTranscript(text);
        else logger.warn(`[${this.callUUID}] Empty transcript received`);
        break;
      }
      case "speech_start":
        logger.info(`[${this.callUUID}] Sarvam VAD: speech_start`);
        this.onVAD("START_SPEECH");
        break;
      case "speech_end":
        logger.info(
          `[${this.callUUID}] Sarvam VAD: speech_end — transcript should follow`,
        );
        this.onVAD("END_SPEECH");
        break;
      default:
        logger.info(
          `[${this.callUUID}] Sarvam unknown type: ${msg.type} — full: ${JSON.stringify(msg)}`,
        );
    }
  }

  sendAudio(pcmBuffer) {
    if (this.destroyed) return;

    if (!this.isReady || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.audioQueue.push(pcmBuffer);
      // Log if queue is growing (means Sarvam hasn't connected yet)
      if (this.audioQueue.length % 50 === 0) {
        logger.warn(
          `[${this.callUUID}] STT not ready — audio queue size: ${this.audioQueue.length}`,
        );
      }
      return;
    }

    this.audioSentCount++;
    this.ws.send(pcmBuffer);

    // Confirm first audio frame reached Sarvam
    if (this.audioSentCount === 1) {
      logger.info(`[${this.callUUID}] ✅ First PCM frame sent to Sarvam AI`);
    }
    if (this.audioSentCount % 200 === 0) {
      logger.info(
        `[${this.callUUID}] 📡 Sent ${this.audioSentCount} PCM frames to Sarvam`,
      );
    }
  }

  flush() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      logger.info(`[${this.callUUID}] Sending flush to Sarvam`);
      this.ws.send(JSON.stringify({ type: "flush" }));
    }
  }

  disconnect() {
    logger.info(`[${this.callUUID}] Disconnecting from Sarvam STT`);
    this.destroyed = true;
    this.flush();
    if (this.ws) {
      this.ws.close(1000, "Call ended");
      this.ws = null;
    }
    this.isReady = false;
    this.audioQueue = [];
  }
}

module.exports = SarvamSTT;
