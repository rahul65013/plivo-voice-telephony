/**
 * conversationManager.js
 *
 * Manages the conversation state for one call:
 *   - Tracks which "turn" we're on (greeting → language-select → main loop)
 *   - Detects the language the user wants from their first reply
 *   - Returns the correct audio URL for each turn
 *
 * AUDIO URL MAP — replace the dummy URLs with your real ones.
 * Each value is a publicly accessible .wav or .mp3 URL that Plivo can fetch.
 */

const logger = require("./logger");

// ── Dummy audio URLs — swap these for real ones ──────────────────────────────
const AUDIO = {
  // Played right after greeting while stream is open
  // "Please say English or Telugu to choose your language"
  languagePrompt: {
    en: "https://your-cdn.com/audio/choose_language_en.wav",
    te: "https://your-cdn.com/audio/choose_language_te.wav",
  },

  // Confirmation after language is chosen
  languageConfirmed: {
    en: "https://your-cdn.com/audio/got_it_english.wav",
    te: "https://your-cdn.com/audio/got_it_telugu.wav",
  },

  // Fallback when we don't understand
  didNotUnderstand: {
    en: "https://your-cdn.com/audio/sorry_didnt_understand_en.wav",
    te: "https://your-cdn.com/audio/sorry_didnt_understand_te.wav",
  },
};

// ── Language detection keywords ───────────────────────────────────────────────
const LANG_KEYWORDS = {
  en: ["english", "eng", "angrezi"],
  te: ["telugu", "telgu", "teligi", "తెలుగు"],
};

function detectLanguage(transcript) {
  const lower = transcript.toLowerCase();
  for (const [lang, keywords] of Object.entries(LANG_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) return lang;
  }
  return null;
}

// ── Turns ────────────────────────────────────────────────────────────────────
const TURN = {
  LANGUAGE_SELECT: "LANGUAGE_SELECT", // waiting for user to pick language
  MAIN: "MAIN", // normal RAG conversation
};

class ConversationManager {
  constructor(callUUID) {
    this.callUUID = callUUID;
    this.turn = TURN.LANGUAGE_SELECT;
    this.language = null; // "en" | "te" — set after user picks
  }

  /**
   * Given the latest transcript, returns:
   *   { audioUrl: string, language: string|null, done: boolean }
   *
   * `done: true` means hang up (not used yet but handy for future).
   */
  async handleTranscript(transcript) {
    logger.info(
      `[${this.callUUID}][Conv] Turn: ${this.turn} | "${transcript}"`,
    );

    // ── Turn 1: user is choosing their language ───────────────────────────
    if (this.turn === TURN.LANGUAGE_SELECT) {
      const detected = detectLanguage(transcript);

      if (!detected) {
        // Couldn't detect — re-ask in both languages (default to EN prompt)
        logger.info(
          `[${this.callUUID}][Conv] Language not detected, re-asking`,
        );
        return {
          audioUrl: AUDIO.languagePrompt.en, // or play both, your call
          language: null,
          done: false,
        };
      }

      // Language confirmed
      this.language = detected;
      this.turn = TURN.MAIN;
      logger.info(`[${this.callUUID}][Conv] Language set → ${detected}`);
      return {
        audioUrl: AUDIO.languageConfirmed[detected],
        language: detected,
        done: false,
      };
    }

    // ── Turn 2+: main RAG conversation ────────────────────────────────────
    if (this.turn === TURN.MAIN) {
      const audioUrl = await this._fetchRagAudioUrl(transcript);
      return { audioUrl, language: this.language, done: false };
    }
  }

  /**
   * Call your RAG/LLM backend here and get back an audio URL.
   * Replace the body of this function with your real API call.
   */
  async _fetchRagAudioUrl(transcript) {
    // TODO: replace with your actual API
    // const res  = await fetch(process.env.RAG_API_URL, {
    //   method: "POST",
    //   headers: { "Content-Type": "application/json" },
    //   body: JSON.stringify({ transcript, language: this.language }),
    // });
    // const { audioUrl } = await res.json();
    // return audioUrl;

    // Dummy: return a static test audio URL
    logger.info(
      `[${this.callUUID}][Conv] RAG stub — transcript: "${transcript}"`,
    );
    return "https://your-cdn.com/audio/dummy_response.wav";
  }

  /** First audio to play right after the greeting (before user speaks) */
  getLanguagePromptUrl() {
    return AUDIO.languagePrompt.en; // plays the bilingual "choose language" prompt
  }
}

module.exports = ConversationManager;
