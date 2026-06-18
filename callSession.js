/**
 * callSession.js — with full debug logging at every step
 */

const axios = require("axios");
const plivo = require("plivo");
const SarvamSTT = require("./sarvamSTT");
const { mulawBase64ToPcm16 } = require("./audioUtils");
const logger = require("./logger");

class CallSession {
  constructor({ callUUID, sarvamApiKey, language }) {
    this.callUUID = callUUID;
    this.sarvamApiKey = sarvamApiKey;
    this.language = language;
    this.stt = null;
    this.fullTranscript = "";
    this.chunkCount = 0;
    this.pcmBytesSent = 0; // track how much audio we've sent to Sarvam
    this.startedAt = Date.now();
    this.isProcessing = false;
    this.plivoClient = new plivo.Client(
      process.env.PLIVO_AUTH_ID,
      process.env.PLIVO_AUTH_TOKEN,
    );
  }

  async start() {
    logger.info(`[${this.callUUID}] Creating Sarvam STT instance...`);
    logger.info(`[${this.callUUID}] Language: ${this.language}`);
    logger.info(
      `[${this.callUUID}] API key: ${this.sarvamApiKey?.slice(0, 6)}...`,
    );

    this.stt = new SarvamSTT({
      callUUID: this.callUUID,
      apiKey: this.sarvamApiKey,
      language: this.language,
      onTranscript: (text) => this._onTranscript(text),
      onVAD: (signal) => this._onVAD(signal),
      onError: (err) => {
        logger.error(`[${this.callUUID}] ❌ Sarvam STT error: ${err.message}`);
      },
    });

    try {
      await this.stt.connect();
      logger.info(`[${this.callUUID}] ✅ Sarvam STT connected successfully`);
      logger.info(
        `[${this.callUUID}] Now waiting for audio chunks from Plivo...`,
      );
    } catch (err) {
      logger.error(
        `[${this.callUUID}] ❌ Sarvam STT connection FAILED: ${err.message}`,
      );
      logger.error(`[${this.callUUID}]    Possible causes:`);
      logger.error(`[${this.callUUID}]    1. Wrong SARVAM_API_KEY`);
      logger.error(`[${this.callUUID}]    2. EC2 outbound port 443 blocked`);
      logger.error(`[${this.callUUID}]    3. Sarvam API endpoint changed`);
      throw err;
    }
  }

  handleAudioChunk(base64Payload) {
    if (!base64Payload) {
      logger.warn(`[${this.callUUID}] Empty audio payload received`);
      return;
    }
    if (!this.stt) {
      logger.warn(
        `[${this.callUUID}] Audio chunk received but STT not ready yet`,
      );
      return;
    }

    this.chunkCount++;

    try {
      const pcmBuffer = mulawBase64ToPcm16(base64Payload);
      this.pcmBytesSent += pcmBuffer.length;
      this.stt.sendAudio(pcmBuffer);

      // Log progress every 100 chunks so you can confirm audio is being sent
      if (this.chunkCount % 100 === 0) {
        logger.info(
          `[${this.callUUID}] 📊 Audio stats — chunks: ${this.chunkCount} | PCM sent: ${(this.pcmBytesSent / 1024).toFixed(1)} KB`,
        );
      }

      // Log first chunk to confirm conversion is working
      if (this.chunkCount === 1) {
        logger.info(
          `[${this.callUUID}] ✅ First chunk converted — mulaw bytes: ${base64Payload.length} → PCM bytes: ${pcmBuffer.length}`,
        );
        logger.info(`[${this.callUUID}]    Audio is now flowing to Sarvam AI`);
      }
    } catch (err) {
      logger.error(
        `[${this.callUUID}] ❌ Audio conversion failed: ${err.message}`,
      );
    }
  }

  _onTranscript(text) {
    this.fullTranscript += (this.fullTranscript ? " " : "") + text;

    // ── THIS IS WHAT YOU WANT TO SEE IN LOGS ──────────────────────────────
    logger.info(`\n${"★".repeat(60)}`);
    logger.info(`[${this.callUUID}] 🗣  USER SAID   : "${text}"`);
    logger.info(`[${this.callUUID}] 📋 FULL SO FAR : "${this.fullTranscript}"`);
    logger.info(`${"★".repeat(60)}\n`);

    this._getAndPlayAudioResponse(text).catch((err) => {
      logger.error(`[${this.callUUID}] Backend/play error: ${err.message}`);
    });
  }

  _onVAD(signal) {
    if (signal === "START_SPEECH") {
      logger.info(
        `[${this.callUUID}] 🎙  VAD: Speech detected — user is speaking`,
      );
    }
    if (signal === "END_SPEECH") {
      logger.info(
        `[${this.callUUID}] 🔇 VAD: Speech ended — waiting for transcript...`,
      );
    }
  }

  async _getAndPlayAudioResponse(userText) {
    if (this.isProcessing) {
      logger.warn(
        `[${this.callUUID}] Skipping — previous response still in-flight`,
      );
      return;
    }
    this.isProcessing = true;

    try {
      logger.info(`[${this.callUUID}] 🚀 Calling your backend...`);
      logger.info(`[${this.callUUID}]    URL: ${process.env.BACKEND_API_URL}`);
      logger.info(`[${this.callUUID}]    Sending: userText="${userText}"`);

      const response = await axios.post(
        process.env.BACKEND_API_URL,
        {
          callUUID: this.callUUID,
          userText,
          fullTranscript: this.fullTranscript,
        },
        {
          headers: {
            "Content-Type": "application/json",
            ...(process.env.BACKEND_API_KEY && {
              Authorization: `Bearer ${process.env.BACKEND_API_KEY}`,
            }),
          },
          timeout: 10_000,
        },
      );

      logger.info(
        `[${this.callUUID}] ✅ Backend responded — status: ${response.status}`,
      );
      logger.info(
        `[${this.callUUID}]    Response: ${JSON.stringify(response.data)}`,
      );

      const audioUrl = response.data?.audioUrl;
      if (!audioUrl) {
        logger.warn(`[${this.callUUID}] ⚠️  Backend returned no audioUrl`);
        logger.warn(
          `[${this.callUUID}]    Got: ${JSON.stringify(response.data)}`,
        );
        return;
      }

      logger.info(`[${this.callUUID}] 🔊 Playing audio to caller: ${audioUrl}`);
      await this._playAudio(audioUrl);
    } catch (err) {
      if (err.response) {
        logger.error(
          `[${this.callUUID}] ❌ Backend error ${err.response.status}: ${JSON.stringify(err.response.data)}`,
        );
      } else if (err.code === "ECONNABORTED") {
        logger.error(`[${this.callUUID}] ❌ Backend timed out after 10s`);
      } else {
        logger.error(
          `[${this.callUUID}] ❌ Backend call failed: ${err.message}`,
        );
      }
    } finally {
      this.isProcessing = false;
    }
  }

  async _playAudio(audioUrl) {
    try {
      logger.info(`[${this.callUUID}] Calling Plivo REST to play audio...`);
      await this.plivoClient.calls.playSound(this.callUUID, audioUrl, {
        loop: 1,
        legs: "aleg",
        mix: false,
      });
      logger.info(`[${this.callUUID}] ✅ Plivo confirmed audio is playing`);
    } catch (err) {
      if (err.statusCode === 404 || err.message?.includes("not found")) {
        logger.warn(
          `[${this.callUUID}] Call already ended — cannot play audio`,
        );
      } else {
        logger.error(
          `[${this.callUUID}] ❌ Plivo playSound failed: ${err.message}`,
        );
        throw err;
      }
    }
  }

  async end() {
    const duration = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    if (this.stt) {
      this.stt.disconnect();
      this.stt = null;
    }

    logger.info(`\n${"═".repeat(60)}`);
    logger.info(`[${this.callUUID}] CALL ENDED`);
    logger.info(`[${this.callUUID}]   Duration     : ${duration}s`);
    logger.info(`[${this.callUUID}]   Audio chunks : ${this.chunkCount}`);
    logger.info(
      `[${this.callUUID}]   PCM sent     : ${(this.pcmBytesSent / 1024).toFixed(1)} KB`,
    );
    logger.info(`[${this.callUUID}]   Transcript   : "${this.fullTranscript}"`);
    logger.info(`${"═".repeat(60)}\n`);
  }
}

module.exports = CallSession;
