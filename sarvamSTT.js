// // /**
// //  * sarvamSTT.js
// //  *
// //  * Connects directly to Sarvam's WebSocket STT endpoint (no SDK).
// //  * Plivo sends μ-law 8kHz audio → we convert to PCM16 LE → send to Sarvam.
// //  *
// //  * Message types from Sarvam:
// //  *   { type: "transcript",   transcript: "..." }   ← final transcript
// //  *   { type: "speech_start" }                       ← VAD: user started speaking
// //  *   { type: "speech_end" }                         ← VAD: user stopped speaking
// //  */


const WebSocket = require("ws");
const logger = require("./logger");

const SARVAM_WS_URL = "wss://api.sarvam.ai/speech-to-text/ws";

// μ-law → PCM16 LE decode table (built once)
const MULAW_TABLE = (() => {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    let u = ~i & 0xff;
    const sign = u & 0x80;
    const exp  = (u >> 4) & 0x07;
    const mant = u & 0x0f;
    let sample = ((mant << 1) + 33) << exp;
    sample -= 33;
    table[i] = sign ? -sample : sample;
  }
  return table;
})();

function mulawBase64ToPcm16Base64(b64) {
  const mulaw = Buffer.from(b64, "base64");
  const pcm   = Buffer.allocUnsafe(mulaw.length * 2);
  for (let i = 0; i < mulaw.length; i++) pcm.writeInt16LE(MULAW_TABLE[mulaw[i]], i * 2);
  return pcm.toString("base64");
}

class SarvamSTT {
  constructor({ callUUID, apiKey, language, onTranscript, onVAD, onError }) {
    this.callUUID    = callUUID;
    this.apiKey      = apiKey;
    this.language    = language || "en-IN";
    this.onTranscript = onTranscript;
    this.onVAD       = onVAD   || (() => {});
    this.onError     = onError || ((e) => logger.error(`[STT] ${e.message}`));
    this.ws          = null;
    this.ready       = false;
    this.audioQueue  = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      const params = new URLSearchParams({
        "language-code":    this.language,
        model:              "saaras:v3",
        mode:               "transcribe",
        sample_rate:        "8000",
        input_audio_codec:  "pcm_s16le",  // URL param — tells Sarvam raw format
        high_vad_sensitivity: "true",
        vad_signals:        "true",
      });

      this.ws = new WebSocket(`${SARVAM_WS_URL}?${params}`, {
        headers: { "api-subscription-key": this.apiKey },
      });

      this.ws.on("open", () => {
        logger.info(`[${this.callUUID}][STT] Connected ✅`);
        this.ready = true;
        for (const chunk of this.audioQueue) this._send(chunk);
        this.audioQueue = [];
        resolve();
      });

      this.ws.on("message", (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        // VAD signal
        if (msg.type === "events") {
          const signal = msg.data?.signal_type;
          if (signal === "START_SPEECH" || signal === "END_SPEECH") {
            logger.info(`[${this.callUUID}][STT] VAD: ${signal}`);
            this.onVAD(signal);
          }
          return;
        }

        // Transcript
        if (msg.type === "data") {
          const text = msg.data?.transcript?.trim();
          if (text) {
            logger.info(`[${this.callUUID}][STT] Transcript: "${text}"`);
            this.onTranscript(text);
          }
          return;
        }

        // Error
        if (msg.type === "error") {
          logger.error(`[${this.callUUID}][STT] Error: ${msg.data?.message}`);
          return;
        }
      });

      this.ws.on("error", (err) => { this.onError(err); reject(err); });
      this.ws.on("close", (code) => {
        logger.info(`[${this.callUUID}][STT] Closed (code ${code})`);
        this.ready = false;
      });
    });
  }

  sendAudio(b64Mulaw) {
    if (!this.ready) { this.audioQueue.push(b64Mulaw); return; }
    this._send(b64Mulaw);
  }

  _send(b64Mulaw) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      audio: {
        data:        mulawBase64ToPcm16Base64(b64Mulaw),
        encoding:    "audio/wav",   // message-body enum — MUST be "audio/wav"
        sample_rate: 8000,
      },
    }));
  }

  disconnect() {
    this.ready = false;
    this.audioQueue = [];
    // Don't send flush — Sarvam rejects flush with no audio, just close cleanly
    if (this.ws) { this.ws.close(); this.ws = null; }
  }
}

module.exports = SarvamSTT;

