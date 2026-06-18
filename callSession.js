require("dotenv").config();

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
    this.isProcessing = false;
    this.isSpeaking = false;

    this.chunkCount = 0;
    this.fullTranscript = "";

    this.plivoClient = new plivo.Client(
      process.env.PLIVO_AUTH_ID,
      process.env.PLIVO_AUTH_TOKEN,
    );
  }

  async start() {
    logger.info(`\n================ STT START ================`);
    logger.info(`[${this.callUUID}] Initializing Sarvam STT`);

    this.stt = new SarvamSTT({
      callUUID: this.callUUID,
      apiKey: this.sarvamApiKey,
      language: this.language,
      onTranscript: (text) => this._onTranscript(text),
      onVAD: (sig) => this._onVAD(sig),
      onError: (err) =>
        logger.error(`[${this.callUUID}] STT ERROR: ${err.message}`),
    });

    await this.stt.connect();

    logger.info(`[${this.callUUID}] STT CONNECTED`);
  }

  /* ───────────────────────── AUDIO INPUT ───────────────────────── */
  handleAudioChunk(base64Payload) {
    if (!base64Payload || !this.stt) return;

    // ignore AI speech
    if (this.isSpeaking) {
      logger.info(`[${this.callUUID}] Ignoring audio (AI speaking)`);
      return;
    }

    this.chunkCount++;

    if (this.chunkCount === 1) {
      logger.info(`[${this.callUUID}] First audio chunk received`);
    }

    const pcm = mulawBase64ToPcm16(base64Payload);
    this.stt.sendAudio(pcm);
  }

  /* ───────────────────────── TRANSCRIPT ───────────────────────── */
  async _onTranscript(text) {
    this.fullTranscript += " " + text;

    logger.info(`\n================ TRANSCRIPT ================`);
    logger.info(`[${this.callUUID}] USER: "${text}"`);
    logger.info(`[${this.callUUID}] FULL: "${this.fullTranscript}"`);

    await this._getAIResponse(text);
  }

  _onVAD(signal) {
    logger.info(`[${this.callUUID}] VAD: ${signal}`);
  }

  /* ───────────────────────── AI PIPELINE ───────────────────────── */
  async _getAIResponse(userText) {
    if (this.isProcessing) {
      logger.warn(`[${this.callUUID}] Already processing`);
      return;
    }

    this.isProcessing = true;

    try {
      logger.info(`[${this.callUUID}] Calling backend...`);

      const res = await axios.post(process.env.BACKEND_API_URL, {
        callUUID: this.callUUID,
        userText,
      });

      const audioUrl = res.data?.audioUrl;

      logger.info(`[${this.callUUID}] Backend response: ${audioUrl}`);

      if (!audioUrl) return;

      await this._playAudio(audioUrl);
    } catch (err) {
      logger.error(`[${this.callUUID}] Backend error: ${err.message}`);
    } finally {
      this.isProcessing = false;
    }
  }

  /* ───────────────────────── AUDIO OUTPUT ───────────────────────── */
  async _playAudio(audioUrl) {
    try {
      logger.info(`\n================ AI SPEAKING ================`);
      logger.info(`[${this.callUUID}] Playing: ${audioUrl}`);

      this.isSpeaking = true;

      await this.plivoClient.calls.playSound(this.callUUID, audioUrl, {
        loop: 1,
        legs: "aleg",
        mix: false,
      });

      logger.info(`[${this.callUUID}] Playback started`);

      setTimeout(() => {
        this.isSpeaking = false;
        logger.info(`[${this.callUUID}] AI speaking ended`);
      }, 2000);
    } catch (err) {
      logger.error(`[${this.callUUID}] Play error: ${err.message}`);
      this.isSpeaking = false;
    }
  }

  async end() {
    logger.info(`\n================ SESSION END ================`);

    if (this.stt) {
      await this.stt.disconnect();
    }

    logger.info(`[${this.callUUID}] Final transcript: ${this.fullTranscript}`);
  }
}

module.exports = CallSession;
