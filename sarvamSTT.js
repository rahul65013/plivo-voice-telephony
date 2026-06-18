// /**
//  * sarvamSTT.js
//  * Streams PCM16 audio to Sarvam AI and fires callbacks for transcripts + VAD.
//  */

// const WebSocket = require("ws");
// const logger = require("./logger");

// class SarvamSTT {
//   constructor({ callUUID, apiKey, language, onTranscript, onVAD, onError }) {
//     this.callUUID = callUUID;
//     this.apiKey = apiKey;
//     this.language = language || "en-IN";
//     this.onTranscript = onTranscript || (() => {});
//     this.onVAD = onVAD || (() => {});
//     this.onError = onError || ((e) => logger.error(`STT error: ${e.message}`));

//     this.ws = null;
//     this.isReady = false;
//     this.audioQueue = [];
//     this.reconnectCount = 0;
//     this.MAX_RECONNECTS = 3;
//     this.destroyed = false;
//     this.audioSentCount = 0;
//   }

//   connect() {
//     return new Promise((resolve, reject) => {
//       if (this.destroyed) return reject(new Error("Instance destroyed"));

//       const params = new URLSearchParams({
//         model: "saaras:v3",
//         mode: "transcribe",
//         language_code: this.language,
//         sample_rate: "16000",
//         // input_audio_codec: "pcm_s16le",
//         // high_vad_sensitivity: "true",
//         // vad_signals: "true",
//       });

//       const url = `wss://api.sarvam.ai/v1/speech-to-text/streaming?${params}`;
//       logger.info(`[${this.callUUID}] Sarvam STT → ${url}`);

//       this.ws = new WebSocket(url, {
//         headers: { "api-subscription-key": this.apiKey },
//       });
//       this.ws.binaryType = "nodebuffer";

//       let resolved = false;
//       const done = (err) => {
//         if (resolved) return;
//         resolved = true;
//         err ? reject(err) : resolve();
//       };

//       this.ws.on("open", () => {
//         logger.info(`[${this.callUUID}] ✅ Sarvam WS open`);
//         this.isReady = true;
//         this.reconnectCount = 0;

//         if (this.audioQueue.length > 0) {
//           logger.info(
//             `[${this.callUUID}] Flushing ${this.audioQueue.length} queued chunks`,
//           );
//           for (const chunk of this.audioQueue) this.ws.send(chunk);
//           this.audioQueue = [];
//         }
//         done();
//       });

//       this.ws.on("message", (data) => {
//         const raw = data.toString();
//         logger.info(`[${this.callUUID}] Sarvam ← ${raw}`);
//         try {
//           this._handleMessage(JSON.parse(raw));
//         } catch {
//           logger.warn(`[${this.callUUID}] Non-JSON from Sarvam: ${raw}`);
//         }
//       });

//       this.ws.on("error", (err) => {
//         logger.error(`[${this.callUUID}] Sarvam WS error: ${err.message}`);
//         this.isReady = false;
//         this.onError(err);
//         done(err);
//       });

//       this.ws.on("close", (code, reason) => {
//         const r = reason?.toString() || "";
//         logger.warn(
//           `[${this.callUUID}] Sarvam WS closed — code:${code} reason:"${r}" ` +
//             `frames_sent:${this.audioSentCount}`,
//         );
//         this.isReady = false;

//         if (
//           !this.destroyed &&
//           code === 1006 &&
//           this.reconnectCount < this.MAX_RECONNECTS
//         ) {
//           const delay = Math.min(300 * 2 ** this.reconnectCount, 4000);
//           this.reconnectCount++;
//           logger.warn(
//             `[${this.callUUID}] Reconnecting in ${delay}ms (${this.reconnectCount}/${this.MAX_RECONNECTS})`,
//           );
//           setTimeout(() => this.connect().catch(this.onError), delay);
//         }
//         // resolve on first close if we never opened (timeout scenario)
//         done();
//       });
//     });
//   }

//   _handleMessage(msg) {
//     switch (msg.type) {
//       case "transcript": {
//         const text = (msg.transcript || "").trim();
//         logger.info(`[${this.callUUID}] 🎯 Transcript: "${text}"`);
//         if (text) this.onTranscript(text);
//         break;
//       }
//       case "speech_start":
//         logger.info(`[${this.callUUID}] VAD: speech_start`);
//         this.onVAD("START_SPEECH");
//         break;
//       case "speech_end":
//         logger.info(`[${this.callUUID}] VAD: speech_end`);
//         this.onVAD("END_SPEECH");
//         break;
//       default:
//         logger.info(
//           `[${this.callUUID}] Sarvam unknown: ${JSON.stringify(msg)}`,
//         );
//     }
//   }

//   sendAudio(pcmBuffer) {
//     if (this.destroyed) return;

//     if (!this.isReady || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
//       this.audioQueue.push(pcmBuffer);
//       if (this.audioQueue.length % 50 === 0)
//         logger.warn(
//           `[${this.callUUID}] STT not ready — queue: ${this.audioQueue.length}`,
//         );
//       return;
//     }

//     this.audioSentCount++;
//     this.ws.send(pcmBuffer);

//     if (this.audioSentCount === 1)
//       logger.info(`[${this.callUUID}] ✅ First PCM frame → Sarvam`);
//     if (this.audioSentCount % 200 === 0)
//       logger.info(`[${this.callUUID}] 📡 ${this.audioSentCount} frames sent`);
//   }

//   flush() {
//     if (this.ws?.readyState === WebSocket.OPEN) {
//       logger.info(`[${this.callUUID}] Flushing Sarvam`);
//       this.ws.send(JSON.stringify({ type: "flush" }));
//     }
//   }

//   disconnect() {
//     logger.info(`[${this.callUUID}] Disconnecting Sarvam STT`);
//     this.destroyed = true;
//     this.flush();
//     if (this.ws) {
//       this.ws.close(1000, "Call ended");
//       this.ws = null;
//     }
//     this.isReady = false;
//     this.audioQueue = [];
//   }
// }

// module.exports = SarvamSTT;



const { SarvamAIClient } = require("sarvamai");
const logger = require("./logger");

class SarvamSTT {
  constructor({ callUUID, apiKey, language, onTranscript, onVAD, onError }) {
    this.callUUID = callUUID;

    this.client = new SarvamAIClient({
      apiSubscriptionKey: apiKey,
    });

    this.language = language || "en-IN";

    this.onTranscript = onTranscript || (() => {});
    this.onVAD = onVAD || (() => {});
    this.onError = onError || (() => {});

    this.stream = null;
    this.ready = false;
    this.queue = [];
  }

  async connect() {
    try {
      logger.info(`[${this.callUUID}] Connecting Sarvam...`);

      // ✅ CORRECT SDK ENTRY (IMPORTANT FIX)
      this.stream = await this.client.speechToTextStreaming.connect({
        model: "saaras:v3",
        mode: "transcribe",
        language_code: this.language,
        sample_rate: 8000,
        high_vad_sensitivity: true,
        vad_signals: true,
      });

      this.ready = true;

      logger.info(`[${this.callUUID}] Sarvam stream OPEN`);

      // 🔥 Incoming messages
      this.stream.on("data", (msg) => {
        logger.info(`[${this.callUUID}] MSG:`, msg);

        if (msg.type === "transcript") {
          const text = msg.transcript?.trim();
          if (text) this.onTranscript(text);
        }

        if (msg.type === "speech_start") {
          this.onVAD("START_SPEECH");
        }

        if (msg.type === "speech_end") {
          this.onVAD("END_SPEECH");
        }
      });

      this.stream.on("error", (err) => {
        logger.error(`[${this.callUUID}] STT error: ${err.message}`);
        this.onError(err);
      });

      // flush queued audio
      for (const chunk of this.queue) {
        this._send(chunk);
      }
      this.queue = [];
    } catch (err) {
      logger.error(`[${this.callUUID}] CONNECT FAILED: ${err.message}`);
      this.onError(err);
    }
  }

  // ✅ PUBLIC API
  sendAudio(pcmBuffer) {
    if (!this.ready || !this.stream) {
      this.queue.push(pcmBuffer);
      return;
    }

    this._send(pcmBuffer);
  }

  // 🔥 IMPORTANT FIX: SDK DOES NOT USE .send()
  _send(pcmBuffer) {
    try {
      if (typeof this.stream.write === "function") {
        this.stream.write(pcmBuffer); // ✔ correct for many builds
      } else if (typeof this.stream.sendAudio === "function") {
        this.stream.sendAudio(pcmBuffer); // ✔ fallback
      } else if (typeof this.stream.send === "function") {
        this.stream.send(pcmBuffer); // ✔ rare fallback
      } else {
        throw new Error("No valid stream send method found");
      }
    } catch (err) {
      logger.error(`[${this.callUUID}] sendAudio error: ${err.message}`);
    }
  }

  flush() {
    try {
      if (this.stream?.flush) this.stream.flush();
    } catch (e) {}
  }

  disconnect() {
    this.stream?.close?.();
    this.stream = null;
    this.ready = false;
    this.queue = [];
  }
}

module.exports = SarvamSTT;
