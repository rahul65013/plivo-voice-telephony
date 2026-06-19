/**
 * conversationManager.js
 *
 * Turn 1 — LANGUAGE_SELECT:
 *   User replies to the greeting (which already asked "English or Telugu?")
 *   We detect the language from their answer and play the confirmation audio URL.
 *
 * Turn 2+ — MAIN:
 *   Every transcript goes to your RAG API.
 *   RAG returns { audioUrl } which we play back.
 */

const logger = require("./logger");

// ── Static audio URLs ─────────────────────────────────────────────────────────
// Replace these with your actual hosted .wav / .mp3 URLs.
// Plivo fetches them directly so they must be publicly accessible.
const AUDIO = {
  languageConfirmed: {
    en:
      process.env.AUDIO_CONFIRMED_EN ||
      "https://YOUR_CDN/confirmed_english.wav",
    te:
      process.env.AUDIO_CONFIRMED_TE || "https://YOUR_CDN/confirmed_telugu.wav",
  },
  didNotUnderstand: {
    en:
      process.env.AUDIO_NOT_UNDERSTOOD_EN ||
      "https://YOUR_CDN/not_understood_en.wav",
    te:
      process.env.AUDIO_NOT_UNDERSTOOD_TE ||
      "https://YOUR_CDN/not_understood_te.wav",
  },
};

// ── Language detection ────────────────────────────────────────────────────────
const LANG_KEYWORDS = {
  en: ["english", "eng", "angrezi", "inglis"],
  te: ["telugu", "telgu", "teligi", "తెలుగు"],
};

function detectLanguage(transcript) {
  const lower = transcript.toLowerCase();
  for (const [lang, keywords] of Object.entries(LANG_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) return lang;
  }
  return null;
}

const TURN = { LANGUAGE_SELECT: "LANGUAGE_SELECT", MAIN: "MAIN" };

class ConversationManager {
  constructor(callUUID) {
    this.callUUID = callUUID;
    this.turn = TURN.LANGUAGE_SELECT;
    this.language = null; // "en" | "te"
  }

  /**
   * Call this with every final transcript.
   * Returns { audioUrl: string, language: string|null }
   */
  async handleTranscript(transcript) {
    logger.info(
      `[${this.callUUID}][Conv] Turn: ${this.turn} | "${transcript}"`,
    );

    // ── Turn 1: detect which language the user chose ──────────────────────
    if (this.turn === TURN.LANGUAGE_SELECT) {
      const detected = detectLanguage(transcript);

      if (!detected) {
        logger.info(
          `[${this.callUUID}][Conv] Language not detected, re-asking`,
        );
        // Play "didn't understand" in English (default) and wait for next reply
        return { audioUrl: AUDIO.didNotUnderstand.en, language: null };
      }

      this.language = detected;
      this.turn = TURN.MAIN;
      logger.info(`[${this.callUUID}][Conv] Language confirmed → ${detected}`);
      return {
        audioUrl: AUDIO.languageConfirmed[detected],
        language: detected,
      };
    }

    // ── Turn 2+: send transcript to RAG, get audio URL back ───────────────
    if (this.turn === TURN.MAIN) {
      const audioUrl = await this._callRag(transcript);
      return { audioUrl, language: this.language };
    }
  }

  /**
   * Replace the body of this function with your real RAG API call.
   *
   * Your RAG endpoint receives:
   *   POST { transcript: string, language: "en" | "te" }
   *
   * Your RAG endpoint must return:
   *   { audioUrl: "https://..." }   ← publicly accessible .wav or .mp3
   */
  async _callRag(transcript) {
    console.log("language", this.language);
    const res = await fetch(process.env.RAG_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      //   body:    JSON.stringify({ transcript, language: this.language }),
      body: JSON.stringify({
        text: transcript,
        projectUrl: "voice-ai-telephony-demo",
        sessionId: "64eca96b-9a54-41ad-971f-ff5873e0e7f4",
        language: this.language,
      }),
    });

    if (!res.ok) throw new Error(`RAG API error: ${res.status}`);

    const { audioUrl } = await res.json();
    logger.info(`[${this.callUUID}][Conv] RAG audio URL: ${audioUrl}`);
    return audioUrl;
  }
}

module.exports = ConversationManager;

// /**
//  * conversationManager.js
//  *
//  * Pipeline for Telugu:
//  *   user speaks Telugu
//  *     → Sarvam STT gives Telugu text
//  *     → translate Telugu → English  (Sarvam Translate API)
//  *     → send English text to RAG
//  *     → RAG returns { responseText: "...", audioUrl: "..." }
//  *         if RAG returns audioUrl directly → play it (RAG already did TTS in Telugu)
//  *         if RAG returns only responseText  → translate English → Telugu, then TTS
//  *
//  * Pipeline for English:
//  *   user speaks English
//  *     → Sarvam STT gives English text
//  *     → send directly to RAG (no translation)
//  *     → RAG returns { audioUrl: "..." } → play it
//  *
//  * Sarvam Translate API:
//  *   POST https://api.sarvam.ai/translate
//  *   Headers: api-subscription-key: <key>
//  *   Body: { input, source_language_code, target_language_code, mode, model }
//  *   Response: { translated_text: "..." }
//  */

// const logger = require("./logger");

// const SARVAM_TRANSLATE_URL = "https://api.sarvam.ai/translate";

// // Language code mapping — Sarvam STT gives us "en"/"te", translate API needs BCP-47
// const LANG_CODE = {
//   en: "en-IN",
//   te: "te-IN",
// };

// // ── Language detection from user's first reply ────────────────────────────────
// const LANG_KEYWORDS = {
//   en: ["english", "eng", "angrezi", "inglis"],
//   te: ["telugu", "telgu", "teligi", "తెలుగు"],
// };

// function detectLanguage(transcript) {
//   const lower = transcript.toLowerCase();
//   for (const [lang, keywords] of Object.entries(LANG_KEYWORDS)) {
//     if (keywords.some((kw) => lower.includes(kw))) return lang;
//   }
//   return null;
// }

// // ── Static audio URLs — put in .env or replace inline ────────────────────────
// const AUDIO = {
//   languageConfirmed: {
//     en:
//       process.env.AUDIO_CONFIRMED_EN ||
//       "https://YOUR_CDN/confirmed_english.wav",
//     te:
//       process.env.AUDIO_CONFIRMED_TE || "https://YOUR_CDN/confirmed_telugu.wav",
//   },
//   didNotUnderstand: {
//     en:
//       process.env.AUDIO_NOT_UNDERSTOOD_EN ||
//       "https://YOUR_CDN/not_understood_en.wav",
//     te:
//       process.env.AUDIO_NOT_UNDERSTOOD_TE ||
//       "https://YOUR_CDN/not_understood_te.wav",
//   },
// };

// const TURN = { LANGUAGE_SELECT: "LANGUAGE_SELECT", MAIN: "MAIN" };

// class ConversationManager {
//   constructor(callUUID) {
//     this.callUUID = callUUID;
//     this.turn = TURN.LANGUAGE_SELECT;
//     this.language = null; // "en" | "te"
//   }

//   async handleTranscript(transcript) {
//     logger.info(
//       `[${this.callUUID}][Conv] Turn: ${this.turn} | "${transcript}"`,
//     );

//     // ── Turn 1: detect language ───────────────────────────────────────────
//     if (this.turn === TURN.LANGUAGE_SELECT) {
//       const detected = detectLanguage(transcript);

//       if (!detected) {
//         logger.info(
//           `[${this.callUUID}][Conv] Language not detected, re-asking`,
//         );
//         return { audioUrl: AUDIO.didNotUnderstand.en, language: null };
//       }

//       this.language = detected;
//       this.turn = TURN.MAIN;
//       logger.info(`[${this.callUUID}][Conv] Language confirmed → ${detected}`);
//       return {
//         audioUrl: AUDIO.languageConfirmed[detected],
//         language: detected,
//       };
//     }

//     // ── Turn 2+: translate if Telugu → RAG → audio ────────────────────────
//     if (this.turn === TURN.MAIN) {
//       const audioUrl = await this._processAndCallRag(transcript);
//       return { audioUrl, language: this.language };
//     }
//   }

//   async _processAndCallRag(transcript) {
//     let textForRag = transcript;

//     // Step 1: if Telugu, translate to English before sending to RAG
//     if (this.language === "te") {
//       logger.info(`[${this.callUUID}][Conv] Translating Telugu → English`);
//       textForRag = await this._translate(transcript, "te-IN", "en-IN");
//       logger.info(`[${this.callUUID}][Conv] Translated: "${textForRag}"`);
//     }

//     // Step 2: call RAG with English text + original language so it knows
//     // what language to respond in (for TTS on your RAG side)
//     const audioUrl = await this._callRag(textForRag);
//     return audioUrl;
//   }

//   /**
//    * Sarvam Translate API
//    * @param {string} text - text to translate
//    * @param {string} from - BCP-47 source language e.g. "te-IN"
//    * @param {string} to   - BCP-47 target language e.g. "en-IN"
//    * @returns {string} translated text
//    */
//   async _translate(text, from, to) {
//     const res = await fetch(SARVAM_TRANSLATE_URL, {
//       method: "POST",
//       headers: {
//         "Content-Type": "application/json",
//         "api-subscription-key": process.env.SARVAM_API_KEY,
//       },
//       body: JSON.stringify({
//         input: text,
//         source_language_code: from,
//         target_language_code: to,
//         mode: "formal", // formal | informal | code-mixed
//         model: "mayura:v1", // or "sarvam-translate:v1" for all 22 langs
//       }),
//     });

//     if (!res.ok) {
//       const err = await res.text();
//       throw new Error(`Sarvam Translate error ${res.status}: ${err}`);
//     }

//     const data = await res.json();
//     return data.translated_text;
//   }

//   /**
//    * Your RAG API call.
//    *
//    * Sends:
//    *   transcript — always in English (translated if user spoke Telugu)
//    *   language   — "en" | "te" (so your RAG/TTS knows which audio to generate)
//    *
//    * Expects back:
//    *   { audioUrl: "https://..." }  — publicly accessible .wav or .mp3
//    */
//   async _callRag(englishTranscript) {
//     const res = await fetch(process.env.RAG_API_URL, {
//       method: "POST",
//       headers: { "Content-Type": "application/json" },
//       body: JSON.stringify({
//         transcript: englishTranscript, // always English
//         language: this.language, // "en" or "te" — for TTS on your side
//         projectUrl: "voice-ai-telephony-demo",
//       }),
//     });

//     if (!res.ok) throw new Error(`RAG API error: ${res.status}`);

//     const { audioUrl } = await res.json();
//     logger.info(`[${this.callUUID}][Conv] RAG audio URL: ${audioUrl}`);
//     return audioUrl;
//   }
// }

// module.exports = ConversationManager;
