/**
 * sarvamSTT.js
 *
 * Manages a single WebSocket connection to Sarvam AI STT per call.
 *
 * Official Sarvam protocol:
 *   - Connect: wss://api.sarvam.ai/v1/speech-to-text/streaming?model=saaras:v3&...
 *   - Auth:    header  api-subscription-key: YOUR_KEY
 *   - Audio:   send raw BINARY frames (PCM 16-bit LE) — NOT base64-wrapped JSON
 *   - Receive: JSON messages { type, transcript? }
 *     types:  "transcript"   → final sentence  { transcript: "text" }
 *             "speech_start" → VAD detected speech beginning
 *             "speech_end"   → VAD detected speech ending (transcript will follow)
 *   - Flush:  send JSON { type: "flush" } to force processing remaining audio
 */

const WebSocket = require("ws");
const logger    = require("./logger");

class SarvamSTT {
  constructor({ callUUID, apiKey, language, onTranscript, onVAD, onError }) {
    this.callUUID     = callUUID;
    this.apiKey       = apiKey;
    this.language     = language || "en-IN";
    this.onTranscript = onTranscript || (() => {});
    this.onVAD        = onVAD        || (() => {});
    this.onError      = onError      || ((e) => logger.error(`[${callUUID}] STT error: ${e.message}`));

    this.ws               = null;
    this.isReady          = false;
    this.audioQueue       = [];   // buffer chunks queued before WS opens
    this.reconnectCount   = 0;
    this.MAX_RECONNECTS   = 3;
    this.destroyed        = false; // set true on intentional disconnect
  }

  connect() {
    return new Promise((resolve, reject) => {
      if (this.destroyed) return reject(new Error("SarvamSTT instance was destroyed"));

      // All config goes in query params — Sarvam does NOT use a JSON handshake frame
      const params = new URLSearchParams({
        model:                "saaras:v3",
        mode:                 "transcribe",
        language_code:        this.language,
        sample_rate:          "8000",       // Plivo telephony = 8kHz
        input_audio_codec:    "pcm_s16le",  // REQUIRED for PCM formats
        high_vad_sensitivity: "true",       // 0.5s silence boundary — best for calls
        vad_signals:          "true",       // receive speech_start / speech_end events
      });

      const url = `wss://api.sarvam.ai/v1/speech-to-text/streaming?${params}`;
      logger.info(`[${this.callUUID}] STT connecting → ${url}`);

      this.ws = new WebSocket(url, {
        headers: { "api-subscription-key": this.apiKey },
      });

      this.ws.binaryType = "nodebuffer"; // receive binary as Buffer

      this.ws.on("open", () => {
        logger.info(`[${this.callUUID}] STT ✅ connected to Sarvam AI`);
        this.isReady        = true;
        this.reconnectCount = 0;

        // Flush audio buffered while connecting
        if (this.audioQueue.length > 0) {
          logger.info(`[${this.callUUID}] STT flushing ${this.audioQueue.length} buffered chunks`);
          for (const chunk of this.audioQueue) this.ws.send(chunk);
          this.audioQueue = [];
        }
        resolve();
      });

      this.ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this._handleMessage(msg);
        } catch {
          // Binary pong or non-JSON keepalive — ignore
        }
      });

      this.ws.on("error", (err) => {
        logger.error(`[${this.callUUID}] STT WebSocket error: ${err.message}`);
        this.isReady = false;
        this.onError(err);
        reject(err);
      });

      this.ws.on("close", (code, reason) => {
        const r = reason?.toString() || "";
        logger.warn(`[${this.callUUID}] STT closed — code: ${code} reason: "${r}"`);
        this.isReady = false;

        // Reconnect on network-level abnormal close only
        // 4xxx = Sarvam auth / quota error → don't retry
        if (!this.destroyed && code === 1006 && this.reconnectCount < this.MAX_RECONNECTS) {
          const delay = Math.min(300 * Math.pow(2, this.reconnectCount), 4000);
          this.reconnectCount++;
          logger.warn(`[${this.callUUID}] STT reconnecting in ${delay}ms (attempt ${this.reconnectCount})`);
          setTimeout(() => this.connect().catch(this.onError), delay);
        }
      });
    });
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case "transcript": {
        const text = (msg.transcript || "").trim();
        if (text) {
          logger.info(`[${this.callUUID}] 📝 TRANSCRIPT: "${text}"`);
          this.onTranscript(text);
        }
        break;
      }
      case "speech_start":
        logger.debug(`[${this.callUUID}] 🎙  speech_start`);
        this.onVAD("START_SPEECH");
        break;
      case "speech_end":
        logger.debug(`[${this.callUUID}] 🔇 speech_end`);
        this.onVAD("END_SPEECH");
        break;
      default:
        logger.debug(`[${this.callUUID}] STT msg type: ${msg.type}`);
    }
  }

  /**
   * Send PCM 16-bit Buffer as a raw BINARY WebSocket frame.
   * Plivo sends ~50 chunks/sec. This must be fast.
   */
  sendAudio(pcmBuffer) {
    if (this.destroyed) return;

    if (!this.isReady || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.audioQueue.push(pcmBuffer); // queue it — will flush on open/reconnect
      return;
    }

    this.ws.send(pcmBuffer); // raw binary — NOT JSON-wrapped
  }

  /** Force Sarvam to process any audio remaining in its internal buffer */
  flush() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "flush" }));
    }
  }

  disconnect() {
    this.destroyed = true;
    this.flush();
    if (this.ws) {
      this.ws.close(1000, "Call ended");
      this.ws = null;
    }
    this.isReady    = false;
    this.audioQueue = [];
  }
}

module.exports = SarvamSTT;
