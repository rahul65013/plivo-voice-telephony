

/**
 * callSession.js
 * Manages one call: feeds audio to STT, collects transcript segments,
 * fires onTranscriptReady when the user finishes an utterance.
 */

const SarvamSTT = require("./sarvamSTT");
const logger    = require("./logger");

const FLUSH_DELAY_MS = 1000; // wait 1s after END_SPEECH before finalising

class CallSession {
  constructor({ callUUID, sarvamApiKey, language, onTranscriptReady }) {
    this.callUUID           = callUUID;
    this.onTranscriptReady  = onTranscriptReady;
    this.segments           = [];
    this.isSpeaking         = false;
    this.flushTimer         = null;

    this.stt = new SarvamSTT({
      callUUID,
      apiKey:       sarvamApiKey,
      language:     language || "en-IN",
      onTranscript: (text) => this._onSegment(text),
      onVAD:        (sig)  => this._onVAD(sig),
    });
  }

  async start() {
    await this.stt.connect();
    logger.info(`[${this.callUUID}][Session] Started`);
  }

  handleAudioChunk(b64Mulaw) {
    if (b64Mulaw) this.stt.sendAudio(b64Mulaw);
  }

  _onVAD(signal) {
    if (signal === "START_SPEECH") {
      this.isSpeaking = true;
      this._cancelFlush();
    } else if (signal === "END_SPEECH") {
      this.isSpeaking = false;
      this._scheduleFlush();
    }
  }

  _onSegment(text) {
    this.segments.push(text);
    if (!this.isSpeaking) this._scheduleFlush();
  }

  _scheduleFlush() {
    this._cancelFlush();
    this.flushTimer = setTimeout(() => this._finalise(), FLUSH_DELAY_MS);
  }

  _cancelFlush() {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
  }

  _finalise() {
    const full = this.segments.join(" ").trim();
    this.segments = [];
    if (full) {
      logger.info(`[${this.callUUID}][Session] ✅ FINAL: "${full}"`);
      this.onTranscriptReady(full);
    }
  }

  async end() {
    this._cancelFlush();
    this._finalise(); // emit anything left
    this.stt.disconnect();
    logger.info(`[${this.callUUID}][Session] Ended`);
  }
}

module.exports = CallSession;
