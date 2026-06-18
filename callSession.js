class CallSession {
  constructor({ callUUID, sarvamApiKey, language }) {
    this.callUUID = callUUID;
    this.sarvamApiKey = sarvamApiKey;
    this.language = language;

    this.stt = null;
    this.fullTranscript = "";
    this.chunkCount = 0;
  }

  async start() {
    logger.info(`[${this.callUUID}] Starting STT ONLY mode`);

    this.stt = new SarvamSTT({
      callUUID: this.callUUID,
      apiKey: this.sarvamApiKey,
      language: this.language,
      onTranscript: (text) => this._onTranscript(text),
      onVAD: (sig) => logger.info(`[${this.callUUID}] VAD: ${sig}`),
      onError: (err) =>
        logger.error(`[${this.callUUID}] STT error: ${err.message}`),
    });

    await this.stt.connect();

    logger.info(`[${this.callUUID}] STT CONNECTED`);
  }

  handleAudioChunk(base64Payload) {
    if (!base64Payload || !this.stt) return;

    this.chunkCount++;

    const pcm = mulawBase64ToPcm16(base64Payload);
    this.stt.sendAudio(pcm);
  }

  _onTranscript(text) {
    this.fullTranscript += " " + text;

    logger.info(`\n================ USER SPEECH ================`);
    logger.info(`[${this.callUUID}] TEXT: "${text}"`);
    logger.info(`[${this.callUUID}] FULL: "${this.fullTranscript}"`);
  }

  async end() {
    logger.info(`[${this.callUUID}] CALL ENDED`);
    logger.info(`[FINAL TRANSCRIPT] ${this.fullTranscript}`);

    if (this.stt) await this.stt.disconnect();
  }
}
