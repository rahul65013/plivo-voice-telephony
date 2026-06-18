// /**
//  * sarvamSTT.js
//  *
//  * Connects directly to Sarvam's WebSocket STT endpoint (no SDK).
//  * Plivo sends μ-law 8kHz audio → we convert to PCM16 LE → send to Sarvam.
//  *
//  * Message types from Sarvam:
//  *   { type: "transcript",   transcript: "..." }   ← final transcript
//  *   { type: "speech_start" }                       ← VAD: user started speaking
//  *   { type: "speech_end" }                         ← VAD: user stopped speaking
//  */

// const WebSocket = require("ws");
// const logger = require("./logger");

// // Sarvam WebSocket endpoint
// const SARVAM_WS_URL = "wss://api.sarvam.ai/speech-to-text/ws";

// // μ-law → PCM16 decode table (built once at startup)
// const MULAW_TABLE = (() => {
//   const table = new Int16Array(256);
//   for (let i = 0; i < 256; i++) {
//     let u = ~i & 0xff;
//     const sign = u & 0x80;
//     const exp = (u >> 4) & 0x07;
//     const mant = u & 0x0f;
//     let sample = ((mant << 1) + 33) << exp;
//     sample -= 33;
//     table[i] = sign ? -sample : sample;
//   }
//   return table;
// })();

// function mulawBase64ToPcm16Base64(base64Input) {
//   const mulaw = Buffer.from(base64Input, "base64");
//   const pcm = Buffer.allocUnsafe(mulaw.length * 2);
//   for (let i = 0; i < mulaw.length; i++) {
//     pcm.writeInt16LE(MULAW_TABLE[mulaw[i]], i * 2);
//   }
//   return pcm.toString("base64");
// }

// class SarvamSTT {
//   /**
//    * @param {object} opts
//    * @param {string}   opts.callUUID
//    * @param {string}   opts.apiKey        - SARVAM_API_KEY
//    * @param {string}   [opts.language]    - BCP-47 code, default "en-IN"
//    * @param {Function} opts.onTranscript  - called with (transcriptText)
//    * @param {Function} opts.onVAD         - called with ("START_SPEECH" | "END_SPEECH")
//    * @param {Function} [opts.onError]     - called with (Error)
//    */
//   constructor({ callUUID, apiKey, language, onTranscript, onVAD, onError }) {
//     this.callUUID = callUUID;
//     this.apiKey = apiKey;
//     this.language = language || "en-IN";
//     this.onTranscript = onTranscript;
//     this.onVAD = onVAD || (() => {});
//     this.onError = onError || ((e) => logger.error(`[STT] ${e.message}`));

//     this.ws = null;
//     this.ready = false;
//     this.audioQueue = []; // holds base64 μ-law strings queued before connect
//   }

//   connect() {
//     return new Promise((resolve, reject) => {
//       // Build the query string — all config goes in URL params
//       const params = new URLSearchParams({
//         "language-code": this.language,
//         model: "saaras:v3",
//         mode: "transcribe",
//         sample_rate: "8000", // Plivo gives us 8kHz
//         input_audio_codec: "pcm_s16le", // we'll convert μ-law → PCM16 before sending
//         high_vad_sensitivity: "true",
//         vad_signals: "true",
//       });

//       const url = `${SARVAM_WS_URL}?${params.toString()}`;

//       logger.info(`[${this.callUUID}][STT] Connecting to Sarvam...`);

//       this.ws = new WebSocket(url, {
//         headers: {
//           "api-subscription-key": this.apiKey,
//         },
//       });

//       this.ws.on("open", () => {
//         logger.info(`[${this.callUUID}][STT] Connected ✅`);
//         this.ready = true;

//         // Flush anything that arrived before the socket was ready
//         for (const chunk of this.audioQueue) {
//           this._sendPcm(chunk);
//         }
//         this.audioQueue = [];

//         resolve();
//       });

//       this.ws.on("message", (raw) => {
//         let msg;
//         try {
//           msg = JSON.parse(raw.toString());
//         } catch {
//           return; // ignore non-JSON frames
//         }

//         logger.info(`[${this.callUUID}][STT] MSG: ${JSON.stringify(msg)}`);

//         if (msg.type === "transcript" && msg.transcript?.trim()) {
//           this.onTranscript(msg.transcript.trim());
//         } else if (msg.type === "speech_start") {
//           this.onVAD("START_SPEECH");
//         } else if (msg.type === "speech_end") {
//           this.onVAD("END_SPEECH");
//         }
//       });

//       this.ws.on("error", (err) => {
//         logger.error(`[${this.callUUID}][STT] WebSocket error: ${err.message}`);
//         this.onError(err);
//         reject(err);
//       });

//       this.ws.on("close", (code, reason) => {
//         logger.info(
//           `[${this.callUUID}][STT] Closed — code: ${code}, reason: ${reason}`,
//         );
//         this.ready = false;
//       });
//     });
//   }

//   /**
//    * Called per audio chunk from Plivo.
//    * @param {string} base64Mulaw - base64-encoded μ-law audio from Plivo
//    */
//   sendAudio(base64Mulaw) {
//     if (!this.ready) {
//       this.audioQueue.push(base64Mulaw);
//       return;
//     }
//     this._sendPcm(base64Mulaw);
//   }

//   _sendPcm(base64Mulaw) {
//     if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

//     const pcm16Base64 = mulawBase64ToPcm16Base64(base64Mulaw);

//     const payload = JSON.stringify({
//       audio: {
//         data: pcm16Base64,
//         encoding: "pcm_s16le",
//         sample_rate: 8000,
//       },
//     });

//     this.ws.send(payload);
//   }

//   /** Flush Sarvam's buffer — forces it to emit whatever it has buffered */
//   flush() {
//     if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
//     logger.info(`[${this.callUUID}][STT] Flushing...`);
//     this.ws.send(JSON.stringify({ flush: true }));
//   }

//   disconnect() {
//     this.ready = false;
//     this.audioQueue = [];
//     if (this.ws) {
//       this.ws.close();
//       this.ws = null;
//     }
//   }
// }

// module.exports = SarvamSTT;




/**
 * sarvamSTT.js
 *
 * Connects directly to Sarvam's WebSocket STT endpoint (no SDK).
 *
 * Audio pipeline:
 *   Plivo → μ-law base64 (8kHz)
 *       → converted to PCM16 LE here
 *       → sent to Sarvam as base64 with encoding:"audio/wav"
 *
 * Key fix: `input_audio_codec=pcm_s16le` goes in the WS URL params (tells
 * Sarvam what raw format to expect), but the per-message `encoding` field
 * must always be "audio/wav" — that is the only value Sarvam accepts there.
 *
 * Sarvam message types received (when vad_signals=true):
 *   { type: "transcript",   transcript: "..." }
 *   { type: "speech_start" }
 *   { type: "speech_end"   }
 */

const WebSocket = require("ws");
const logger = require("./logger");

const SARVAM_WS_URL = "wss://api.sarvam.ai/speech-to-text/ws";

// μ-law → PCM16 decode table (built once at startup, zero runtime cost)
const MULAW_TABLE = (() => {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    let u = ~i & 0xff;
    const sign = u & 0x80;
    const exp = (u >> 4) & 0x07;
    const mant = u & 0x0f;
    let sample = ((mant << 1) + 33) << exp;
    sample -= 33;
    table[i] = sign ? -sample : sample;
  }
  return table;
})();

function mulawBase64ToPcm16Base64(base64Input) {
  const mulaw = Buffer.from(base64Input, "base64");
  const pcm = Buffer.allocUnsafe(mulaw.length * 2);
  for (let i = 0; i < mulaw.length; i++) {
    pcm.writeInt16LE(MULAW_TABLE[mulaw[i]], i * 2);
  }
  return pcm.toString("base64");
}

class SarvamSTT {
  constructor({ callUUID, apiKey, language, onTranscript, onVAD, onError }) {
    this.callUUID = callUUID;
    this.apiKey = apiKey;
    this.language = language || "en-IN";
    this.onTranscript = onTranscript;
    this.onVAD = onVAD || (() => {});
    this.onError = onError || ((e) => logger.error(`[STT] ${e.message}`));

    this.ws = null;
    this.ready = false;
    this.audioQueue = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      const params = new URLSearchParams({
        "language-code": this.language,
        model: "saaras:v3",
        mode: "transcribe",
        sample_rate: "8000",
        input_audio_codec: "pcm_s16le", // ← URL param: tells Sarvam the raw format
        high_vad_sensitivity: "true",
        vad_signals: "true",
      });

      const url = `${SARVAM_WS_URL}?${params.toString()}`;
      logger.info(`[${this.callUUID}][STT] Connecting to Sarvam...`);

      this.ws = new WebSocket(url, {
        headers: { "api-subscription-key": this.apiKey },
      });

      this.ws.on("open", () => {
        logger.info(`[${this.callUUID}][STT] Connected ✅`);
        this.ready = true;

        // Flush anything queued before the socket was ready
        for (const chunk of this.audioQueue) this._sendPcm(chunk);
        this.audioQueue = [];

        resolve();
      });

      this.ws.on("message", (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }

        logger.info(`[${this.callUUID}][STT] MSG: ${JSON.stringify(msg)}`);

        if (msg.type === "transcript" && msg.transcript?.trim()) {
          this.onTranscript(msg.transcript.trim());
        } else if (msg.type === "speech_start") {
          this.onVAD("START_SPEECH");
        } else if (msg.type === "speech_end") {
          this.onVAD("END_SPEECH");
        } else if (msg.type === "error") {
          logger.error(`[${this.callUUID}][STT] Server error: ${JSON.stringify(msg)}`);
        }
      });

      this.ws.on("error", (err) => {
        logger.error(`[${this.callUUID}][STT] WebSocket error: ${err.message}`);
        this.onError(err);
        reject(err);
      });

      this.ws.on("close", (code, reason) => {
        logger.info(`[${this.callUUID}][STT] Closed — code: ${code}, reason: ${reason}`);
        this.ready = false;
      });
    });
  }

  sendAudio(base64Mulaw) {
    if (!this.ready) {
      this.audioQueue.push(base64Mulaw);
      return;
    }
    this._sendPcm(base64Mulaw);
  }

  _sendPcm(base64Mulaw) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const pcm16Base64 = mulawBase64ToPcm16Base64(base64Mulaw);

    // FIX: encoding in the message body MUST be "audio/wav" — Sarvam's
    // validation enum rejects anything else (pcm_s16le etc. are URL-param only)
    this.ws.send(JSON.stringify({
      audio: {
        data: pcm16Base64,
        encoding: "audio/wav", // ← always "audio/wav" in message body
        sample_rate: 8000,
      },
    }));
  }

  flush() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    logger.info(`[${this.callUUID}][STT] Flushing...`);
    this.ws.send(JSON.stringify({ flush: true }));
  }

  disconnect() {
    this.ready = false;
    this.audioQueue = [];
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

module.exports = SarvamSTT;


