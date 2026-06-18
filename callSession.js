/**
 * callSession.js
 *
 * Manages a single call's STT lifecycle:
 *   - Feeds audio chunks from Plivo → SarvamSTT
 *   - Accumulates transcript segments between VAD events
 *   - Fires onTranscriptReady(fullText) after the user finishes speaking
 */

const SarvamSTT = require("./sarvamSTT");
const logger = require("./logger");

// How long (ms) to wait after last segment/END_SPEECH before finalising
const FLUSH_DELAY_MS = 1200;

class CallSession {
  constructor({ callUUID, sarvamApiKey, language, onTranscriptReady }) {
    this.callUUID = callUUID;
    this.onTranscriptReady = onTranscriptReady;

    this.stt = new SarvamSTT({
      callUUID,
      apiKey: sarvamApiKey,
      language: language || "en-IN",
      onTranscript: (text) => this._onSegment(text),
      onVAD: (signal) => this._onVAD(signal),
    });

    this.segments = []; // partial transcript pieces within one utterance
    this.isSpeaking = false;
    this.flushTimer = null;
  }

  async start() {
    await this.stt.connect();
    logger.info(`[${this.callUUID}][Session] Started`);
  }

  /**
   * Called for every Plivo "media" event.
   * @param {string} base64Mulaw - msg.media.payload from Plivo
   */
  handleAudioChunk(base64Mulaw) {
    if (!base64Mulaw) return;
    this.stt.sendAudio(base64Mulaw);
  }

  // ── VAD signals from Sarvam ──────────────────────────────────────────────

  _onVAD(signal) {
    logger.info(`[${this.callUUID}][Session] VAD: ${signal}`);

    if (signal === "START_SPEECH") {
      this.isSpeaking = true;
      this._cancelFlush(); // don't finalise while they're still talking
    }

    if (signal === "END_SPEECH") {
      this.isSpeaking = false;
      this._scheduleFlush(); // give Sarvam a moment to emit the last segment
    }
  }

  // ── Transcript segments from Sarvam ─────────────────────────────────────

  _onSegment(text) {
    logger.info(`[${this.callUUID}][Session] Segment: "${text}"`);
    this.segments.push(text);

    if (!this.isSpeaking) {
      // Sarvam emitted a segment after END_SPEECH — schedule finalise
      this._scheduleFlush();
    }
  }

  // ── Flush logic ─────────────────────────────────────────────────────────

  _scheduleFlush() {
    this._cancelFlush();
    this.flushTimer = setTimeout(() => this._finalise(), FLUSH_DELAY_MS);
  }

  _cancelFlush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  _finalise() {
    const full = this.segments.join(" ").trim();
    this.segments = [];
    if (full) {
      logger.info(`[${this.callUUID}][Session] FINAL TRANSCRIPT: "${full}"`);
      this.onTranscriptReady(full);
    }
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────

  async end() {
    this._cancelFlush();

    // Emit whatever the user said in their last turn (if call drops mid-speech)
    this.stt.flush();
    await new Promise((r) => setTimeout(r, 500)); // give Sarvam 500ms to respond

    this._finalise(); // fire transcript if there's anything left

    this.stt.disconnect();
    logger.info(`[${this.callUUID}][Session] Ended`);
  }
}

module.exports = CallSession;
