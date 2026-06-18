// /**
//  * callSession.js
//  *
//  * Manages one phone call:
//  *  - Receives base64 mulaw audio chunks from Plivo
//  *  - Decodes mulaw → PCM16 and streams to Sarvam STT
//  *  - Buffers transcript segments until a silence gap or call end
//  *  - Fires onTranscriptReady(fullText) with the complete user utterance
//  */

// const SarvamSTT = require("./sarvamSTT");
// const logger = require("./logger");

// // ── mulaw decode table (standard ITU-T G.711) ─────────────────────────────
// const MULAW_DECODE_TABLE = (() => {
//   const table = new Int16Array(256);
//   for (let i = 0; i < 256; i++) {
//     let u = ~i & 0xff;
//     const sign = u & 0x80 ? -1 : 1;
//     const exponent = (u >> 4) & 0x07;
//     const mantissa = u & 0x0f;
//     let magnitude = ((mantissa << 1) | 33) << exponent;
//     magnitude -= 33;
//     table[i] = sign * magnitude;
//   }
//   return table;
// })();

// /**
//  * Decode base64 mulaw payload (as sent by Plivo) → PCM16LE Buffer
//  */
// function mulawBase64ToPcm16(base64) {
//   const mulaw = Buffer.from(base64, "base64");
//   const pcm = Buffer.allocUnsafe(mulaw.length * 2);
//   for (let i = 0; i < mulaw.length; i++) {
//     const sample = MULAW_DECODE_TABLE[mulaw[i]];
//     pcm.writeInt16LE(sample, i * 2);
//   }
//   return pcm;
// }

// // After this many ms of silence following speech_end, fire onTranscriptReady
// const UTTERANCE_FLUSH_MS = 1500;

// class CallSession {
//   constructor({ callUUID, sarvamApiKey, language, onTranscriptReady }) {
//     this.callUUID = callUUID;
//     this.sarvamApiKey = sarvamApiKey;
//     this.language = language || "en-IN";
//     this.onTranscriptReady = onTranscriptReady || (() => {});

//     this.stt = null;
//     this.segments = []; // transcript segments in current utterance
//     this.chunkCount = 0;
//     this.isSpeaking = false;
//     this.flushTimer = null;
//     this.ended = false;
//   }

//   async start() {
//     logger.info(`[${this.callUUID}] CallSession.start()`);

//     this.stt = new SarvamSTT({
//       callUUID: this.callUUID,
//       apiKey: this.sarvamApiKey,
//       language: this.language,
//       onTranscript: (text) => this._onSegment(text),
//       onVAD: (sig) => this._onVAD(sig),
//       onError: (err) =>
//         logger.error(`[${this.callUUID}] STT error: ${err.message}`),
//     });

//     await this.stt.connect();
//     logger.info(`[${this.callUUID}] STT connected ✅`);
//   }

//   handleAudioChunk(base64Payload) {
//     if (!base64Payload || !this.stt || this.ended) return;

//     this.chunkCount++;
//     try {
//       const pcm = mulawBase64ToPcm16(base64Payload);
//       this.stt.sendAudio(pcm);
//     } catch (err) {
//       logger.error(`[${this.callUUID}] Audio decode error: ${err.message}`);
//     }
//   }

//   /* ── VAD signals ─────────────────────────────────────────────────────── */
//   _onVAD(signal) {
//     logger.info(`[${this.callUUID}] VAD: ${signal}`);

//     if (signal === "START_SPEECH") {
//       this.isSpeaking = true;
//       // Cancel any pending flush — user is still talking
//       this._cancelFlush();
//     } else if (signal === "END_SPEECH") {
//       this.isSpeaking = false;
//       // Start a flush timer — transcript segment(s) should arrive soon
//       this._scheduleFlush();
//     }
//   }

//   /* ── Transcript segment from Sarvam ─────────────────────────────────── */
//   _onSegment(text) {
//     logger.info(`[${this.callUUID}] Segment: "${text}"`);
//     this.segments.push(text);

//     // Reset flush window each time a new segment lands
//     this._scheduleFlush();
//   }

//   /* ── Flush: fire onTranscriptReady with the full utterance ──────────── */
//   _scheduleFlush() {
//     this._cancelFlush();
//     this.flushTimer = setTimeout(() => {
//       this._fireTranscript();
//     }, UTTERANCE_FLUSH_MS);
//   }

//   _cancelFlush() {
//     if (this.flushTimer) {
//       clearTimeout(this.flushTimer);
//       this.flushTimer = null;
//     }
//   }

//   _fireTranscript() {
//     if (this.segments.length === 0) return;

//     const full = this.segments.join(" ").trim();
//     this.segments = [];

//     logger.info(`\n================ UTTERANCE READY ================`);
//     logger.info(`[${this.callUUID}] "${full}"`);

//     this.onTranscriptReady(full);
//   }

//   /* ── End of call ─────────────────────────────────────────────────────── */
//   async end() {
//     if (this.ended) return;
//     this.ended = true;

//     logger.info(
//       `[${this.callUUID}] CallSession.end() — chunks: ${this.chunkCount}`,
//     );

//     // Flush any remaining speech immediately
//     this._cancelFlush();
//     this._fireTranscript();

//     if (this.stt) {
//       this.stt.disconnect();
//       this.stt = null;
//     }
//   }
// }

// module.exports = CallSession;



const SarvamSTT = require("./sarvamSTT");
const logger = require("./logger");

const MULAW_DECODE_TABLE = (() => {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    let u = ~i & 0xff;
    const sign = u & 0x80 ? -1 : 1;
    const exp = (u >> 4) & 0x07;
    const mant = u & 0x0f;
    let sample = ((mant << 1) + 33) << exp;
    sample -= 33;
    table[i] = sign * sample;
  }
  return table;
})();

function mulawBase64ToPcm16(base64) {
  const mulaw = Buffer.from(base64, "base64");
  const pcm = Buffer.allocUnsafe(mulaw.length * 2);

  for (let i = 0; i < mulaw.length; i++) {
    pcm.writeInt16LE(MULAW_DECODE_TABLE[mulaw[i]], i * 2);
  }

  return pcm;
}

class CallSession {
  constructor({ callUUID, sarvamApiKey, language, onTranscriptReady }) {
    this.callUUID = callUUID;
    this.apiKey = sarvamApiKey;
    this.language = language || "en-IN";
    this.onTranscriptReady = onTranscriptReady;

    this.stt = null;
    this.segments = [];
    this.flushTimer = null;
    this.ended = false;

    this.chunkCount = 0;
  }

  async start() {
    this.stt = new SarvamSTT({
      callUUID: this.callUUID,
      apiKey: this.apiKey,
      language: this.language,
      onTranscript: (text) => this._onSegment(text),
      onVAD: (sig) => this._onVAD(sig),
      onError: (err) => logger.error(err),
    });

    await this.stt.connect();

    logger.info(`[${this.callUUID}] STT ready`);
  }

  handleAudioChunk(base64Payload) {
    if (!base64Payload || this.ended) return;

    this.chunkCount++;

    const pcm = mulawBase64ToPcm16(base64Payload);

    this.stt.sendAudio(pcm);
  }

  _onVAD(signal) {
    logger.info(`[${this.callUUID}] VAD: ${signal}`);

    if (signal === "START_SPEECH") {
      this._cancelFlush();
    }

    if (signal === "END_SPEECH") {
      this._scheduleFlush();
    }
  }

  _onSegment(text) {
    this.segments.push(text);
    this._scheduleFlush();
  }

  _scheduleFlush() {
    this._cancelFlush();

    this.flushTimer = setTimeout(() => {
      this._fire();
    }, 1500);
  }

  _cancelFlush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  _fire() {
    if (!this.segments.length) return;

    const full = this.segments.join(" ").trim();
    this.segments = [];

    logger.info(`\n===== UTTERANCE =====`);
    logger.info(full);

    this.onTranscriptReady(full);
  }

  async end() {
    if (this.ended) return;
    this.ended = true;

    this._cancelFlush();
    this._fire();

    this.stt?.disconnect();

    logger.info(`[${this.callUUID}] Call ended`);
  }
}

module.exports = CallSession;
