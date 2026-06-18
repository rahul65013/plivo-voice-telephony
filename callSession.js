/**
 * callSession.js
 *
 * Owns the full lifecycle of one phone call:
 *   1. Receives mulaw audio chunks from Plivo via WebSocket
 *   2. Converts each chunk to PCM16 and streams to Sarvam AI
 *   3. Receives final transcript sentences from Sarvam
 *   4. POSTs transcript to your backend API → gets audioUrl back
 *   5. Plays that audioUrl to the caller via Plivo REST API
 *   6. Logs everything and cleans up on call end
 */

const axios      = require("axios");
const plivo      = require("plivo");
const SarvamSTT  = require("./sarvamSTT");
const { mulawBase64ToPcm16 } = require("./audioUtils");
const logger     = require("./logger");

class CallSession {
  constructor({ callUUID, sarvamApiKey, language }) {
    this.callUUID       = callUUID;
    this.sarvamApiKey   = sarvamApiKey;
    this.language       = language;

    this.stt            = null;
    this.fullTranscript = "";    // running transcript for whole call
    this.chunkCount     = 0;
    this.startedAt      = Date.now();
    this.isProcessing   = false; // prevent overlapping backend calls

    // Plivo REST client — used to play audio back to caller
    this.plivoClient = new plivo.Client(
      process.env.PLIVO_AUTH_ID,
      process.env.PLIVO_AUTH_TOKEN
    );
  }

  // ── Start: open Sarvam STT connection ──────────────────────────────────────
  async start() {
    this.stt = new SarvamSTT({
      callUUID:     this.callUUID,
      apiKey:       this.sarvamApiKey,
      language:     this.language,
      onTranscript: (text) => this._onTranscript(text),
      onVAD:        (signal) => this._onVAD(signal),
      onError:      (err) => logger.error(`[${this.callUUID}] STT error: ${err.message}`),
    });

    await this.stt.connect();
    logger.info(`[${this.callUUID}] ✅ Session started`);
  }

  // ── Receive one Plivo audio chunk ─────────────────────────────────────────
  // Called for every "media" event from Plivo WebSocket
  // payload = base64 string of μ-law bytes
  handleAudioChunk(base64Payload) {
    if (!base64Payload || !this.stt) return;
    this.chunkCount++;

    try {
      const pcmBuffer = mulawBase64ToPcm16(base64Payload);
      this.stt.sendAudio(pcmBuffer);
    } catch (err) {
      logger.error(`[${this.callUUID}] Audio decode error: ${err.message}`);
    }
  }

  // ── Called when Sarvam returns a final sentence ───────────────────────────
  _onTranscript(text) {
    // Append to full call transcript
    this.fullTranscript += (this.fullTranscript ? " " : "") + text;

    // ✅ Console log — every sentence the user speaks
    logger.info(`[${this.callUUID}] ─────────────────────────────────────`);
    logger.info(`[${this.callUUID}] USER SAID   : "${text}"`);
    logger.info(`[${this.callUUID}] FULL SO FAR : "${this.fullTranscript}"`);
    logger.info(`[${this.callUUID}] ─────────────────────────────────────`);

    // Call your backend (non-blocking — don't await here so next chunks keep flowing)
    this._getAndPlayAudioResponse(text).catch((err) => {
      logger.error(`[${this.callUUID}] Backend/play error: ${err.message}`);
    });
  }

  _onVAD(signal) {
    if (signal === "START_SPEECH") logger.info(`[${this.callUUID}] 🎙  Speaking...`);
    if (signal === "END_SPEECH")   logger.info(`[${this.callUUID}] ⏳ Processing speech...`);
  }

  // ── POST to your backend → play returned audioUrl ────────────────────────
  async _getAndPlayAudioResponse(userText) {
    if (this.isProcessing) {
      logger.warn(`[${this.callUUID}] Skipping — previous response still in-flight`);
      return;
    }
    this.isProcessing = true;

    try {
      // ── STEP 1: Call your backend API ─────────────────────────────────────
      logger.info(`[${this.callUUID}] 🚀 Calling backend: ${process.env.BACKEND_API_URL}`);

      const backendResponse = await axios.post(
        process.env.BACKEND_API_URL,
        {
          callUUID:       this.callUUID,
          userText,
          fullTranscript: this.fullTranscript,
        },
        {
          headers: {
            "Content-Type":  "application/json",
            ...(process.env.BACKEND_API_KEY && {
              Authorization: `Bearer ${process.env.BACKEND_API_KEY}`,
            }),
          },
          timeout: 10_000, // 10s — if backend is slow, skip this turn
        }
      );

      const audioUrl = backendResponse.data?.audioUrl;

      if (!audioUrl) {
        logger.warn(`[${this.callUUID}] Backend returned no audioUrl — skipping playback`);
        return;
      }

      logger.info(`[${this.callUUID}] 🔊 Got audioUrl: ${audioUrl}`);

      // ── STEP 2: Play audio to caller via Plivo REST API ───────────────────
      await this._playAudio(audioUrl);

    } catch (err) {
      if (err.response) {
        // Backend returned a non-2xx status
        logger.error(`[${this.callUUID}] Backend error ${err.response.status}: ${JSON.stringify(err.response.data)}`);
      } else if (err.code === "ECONNABORTED") {
        logger.error(`[${this.callUUID}] Backend timed out after 10s`);
      } else {
        logger.error(`[${this.callUUID}] _getAndPlayAudioResponse: ${err.message}`);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  // ── Play audio URL to the live call via Plivo REST ────────────────────────
  async _playAudio(audioUrl) {
    try {
      // Plivo's playSound plays an MP3/WAV URL to the live call
      await this.plivoClient.calls.playSound(this.callUUID, audioUrl, {
        loop:   1,
        legs:   "aleg",  // aleg = the caller's side
        mix:    false,   // replace any existing audio
      });
      logger.info(`[${this.callUUID}] ✅ Audio playing to caller`);
    } catch (err) {
      // 404 = call already hung up — not a real error
      if (err.statusCode === 404 || err.message?.includes("not found")) {
        logger.warn(`[${this.callUUID}] Call already ended — cannot play audio`);
      } else {
        throw err;
      }
    }
  }

  // ── End: flush STT and log call summary ───────────────────────────────────
  async end() {
    const durationSec = ((Date.now() - this.startedAt) / 1000).toFixed(1);

    if (this.stt) {
      this.stt.disconnect();
      this.stt = null;
    }

    logger.info(`[${this.callUUID}] ═══════════════════════════════════════`);
    logger.info(`[${this.callUUID}] CALL ENDED`);
    logger.info(`[${this.callUUID}] Duration  : ${durationSec}s`);
    logger.info(`[${this.callUUID}] Chunks    : ${this.chunkCount}`);
    logger.info(`[${this.callUUID}] Transcript: "${this.fullTranscript}"`);
    logger.info(`[${this.callUUID}] ═══════════════════════════════════════`);
  }
}

module.exports = CallSession;
