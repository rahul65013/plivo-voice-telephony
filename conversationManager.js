// // /**
// //  * conversationManager.js
// //  *
// //  * Turn 1 — LANGUAGE_SELECT:
// //  *   User replies to the greeting (which already asked "English or Telugu?")
// //  *   We detect the language from their answer and play the confirmation audio URL.
// //  *
// //  * Turn 2+ — MAIN:
// //  *   Every transcript goes to your RAG API.
// //  *   RAG returns { audioUrl } which we play back.
// //  */

// // const logger = require("./logger");

// // // ── Static audio URLs ─────────────────────────────────────────────────────────
// // // Replace these with your actual hosted .wav / .mp3 URLs.
// // // Plivo fetches them directly so they must be publicly accessible.
// // const AUDIO = {
// //   languageConfirmed: {
// //     en:
// //       process.env.AUDIO_CONFIRMED_EN ||
// //       "https://YOUR_CDN/confirmed_english.wav",
// //     te:
// //       process.env.AUDIO_CONFIRMED_TE || "https://YOUR_CDN/confirmed_telugu.wav",
// //   },
// //   didNotUnderstand: {
// //     en:
// //       process.env.AUDIO_NOT_UNDERSTOOD_EN ||
// //       "https://YOUR_CDN/not_understood_en.wav",
// //     te:
// //       process.env.AUDIO_NOT_UNDERSTOOD_TE ||
// //       "https://YOUR_CDN/not_understood_te.wav",
// //   },
// // };

// // // ── Language detection ────────────────────────────────────────────────────────
// // const LANG_KEYWORDS = {
// //   en: ["english", "eng", "angrezi", "inglis"],
// //   te: ["telugu", "telgu", "teligi", "తెలుగు"],
// // };

// // function detectLanguage(transcript) {
// //   const lower = transcript.toLowerCase();
// //   for (const [lang, keywords] of Object.entries(LANG_KEYWORDS)) {
// //     if (keywords.some((kw) => lower.includes(kw))) return lang;
// //   }
// //   return null;
// // }

// // const TURN = { LANGUAGE_SELECT: "LANGUAGE_SELECT", MAIN: "MAIN" };

// // class ConversationManager {
// //   constructor(callUUID) {
// //     this.callUUID = callUUID;
// //     this.turn = TURN.LANGUAGE_SELECT;
// //     this.language = null; // "en" | "te"
// //   }

// //   /**
// //    * Call this with every final transcript.
// //    * Returns { audioUrl: string, language: string|null }
// //    */
// //   async handleTranscript(transcript) {
// //     logger.info(
// //       `[${this.callUUID}][Conv] Turn: ${this.turn} | "${transcript}"`,
// //     );

// //     // ── Turn 1: detect which language the user chose ──────────────────────
// //     if (this.turn === TURN.LANGUAGE_SELECT) {
// //       const detected = detectLanguage(transcript);

// //       if (!detected) {
// //         logger.info(
// //           `[${this.callUUID}][Conv] Language not detected, re-asking`,
// //         );
// //         // Play "didn't understand" in English (default) and wait for next reply
// //         return { audioUrl: AUDIO.didNotUnderstand.en, language: null };
// //       }

// //       this.language = detected;
// //       this.turn = TURN.MAIN;
// //       logger.info(`[${this.callUUID}][Conv] Language confirmed → ${detected}`);
// //       return {
// //         audioUrl: AUDIO.languageConfirmed[detected],
// //         language: detected,
// //       };
// //     }

// //     // ── Turn 2+: send transcript to RAG, get audio URL back ───────────────
// //     if (this.turn === TURN.MAIN) {
// //       const audioUrl = await this._callRag(transcript);
// //       return { audioUrl, language: this.language };
// //     }
// //   }

// //   /**
// //    * Replace the body of this function with your real RAG API call.
// //    *
// //    * Your RAG endpoint receives:
// //    *   POST { transcript: string, language: "en" | "te" }
// //    *
// //    * Your RAG endpoint must return:
// //    *   { audioUrl: "https://..." }   ← publicly accessible .wav or .mp3
// //    */
// //   async _callRag(transcript) {
// //     console.log("language", this.language);
// //     const res = await fetch(process.env.RAG_API_URL, {
// //       method: "POST",
// //       headers: { "Content-Type": "application/json" },
// //       //   body:    JSON.stringify({ transcript, language: this.language }),
// //       body: JSON.stringify({
// //         text: transcript,
// //         projectUrl: "voice-ai-telephony-demo",
// //         sessionId: "64eca96b-9a54-41ad-971f-ff5873e0e7f4",
// //         language: this.language,
// //       }),
// //     });

// //     if (!res.ok) throw new Error(`RAG API error: ${res.status}`);

// //     const { audioUrl } = await res.json();
// //     logger.info(`[${this.callUUID}][Conv] RAG audio URL: ${audioUrl}`);
// //     return audioUrl;
// //   }
// // }

// // module.exports = ConversationManager;

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
//         text: englishTranscript, // always English
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





/**
 * conversationManager.js — MSN Realty Branching Script
 *
 * FLOW:
 *
 *  [GREETING_AUDIO plays via <Play> in /answer XML before stream opens]
 *  "Hello, this is Aditi from MSN Realty. Can I have 2 mins?"
 *
 *  User replies →
 *
 *  STEP: GREETING
 *    [yes/positive] → play askLanguage    → STEP: ASK_LANGUAGE
 *    [no/negative]  → play notAvailable   → done (hang up)
 *
 *  STEP: ASK_LANGUAGE
 *    "Are you comfortable with English or should we talk in Telugu?"
 *    [english] → language = "en" → play askBHK  → STEP: ASK_BHK
 *    [telugu]  → language = "te" → play askBHK  → STEP: ASK_BHK
 *    [unclear] → re-ask askLanguage
 *
 *  STEP: ASK_BHK
 *    "Are you looking for a 4 or 5 BHK?"
 *    [4 or 5]      → save bhk → play branchA_details → STEP: ASK_MORE
 *    [not interested / negative] → play branchB_goodbye → done (hang up)
 *
 *  STEP: ASK_MORE
 *    "Would you like to know more? My senior manager Neha Rao will call you."
 *    [yes/positive] → save wantsCallback=true  → play branchA_goodbye → done
 *    [no/negative]  → save wantsCallback=false → play branchB_goodbye → done
 */

const logger = require("./logger");

// ── Keyword detection ─────────────────────────────────────────────────────────

const POSITIVE_WORDS = [
  "yes", "yeah", "yep", "sure", "okay", "ok", "of course", "definitely",
  "absolutely", "please", "go ahead", "fine", "alright", "correct",
  "haan", "ha", "theek", "zaroor", "bilkul",
  "avunu", "అవును", "sari", "సరి",
];

const NEGATIVE_WORDS = [
  "no", "nope", "not", "never", "don't", "didn't", "i am not", "i'm not",
  "nahi", "mat", "ledu", "వద్దు", "లేదు", "not interested", "not looking",
  "i did not", "i haven't",
];

const LANG_KEYWORDS = {
  en: ["english", "eng", "angrezi", "inglis"],
  te: ["telugu", "telgu", "teligi", "తెలుగు"],
};

function isPositive(text) {
  const t = text.toLowerCase();
  return POSITIVE_WORDS.some((w) => t.includes(w));
}

function isNegative(text) {
  const t = text.toLowerCase();
  return NEGATIVE_WORDS.some((w) => t.includes(w));
}

function detectLanguage(text) {
  const t = text.toLowerCase();
  for (const [lang, kws] of Object.entries(LANG_KEYWORDS)) {
    if (kws.some((kw) => t.includes(kw))) return lang;
  }
  return null;
}

function detectBHK(text) {
  const t = text.toLowerCase();
  if (t.includes("5") || t.includes("five")) return "5";
  if (t.includes("4") || t.includes("four")) return "4";
  return null;
}

// ── Audio URL map ─────────────────────────────────────────────────────────────
// Every URL comes from .env so you just swap files without touching code.
// Key naming: AUDIO_<STEP>_<EN|TE>

const AUDIO = {
  en: {
    // "No problem, have a nice day!" (user had no time)
    notAvailable: process.env.AUDIO_BRANCH_B_GOODBYE_EN,

    // "Are you comfortable with English or should we talk in Telugu?"
    askLanguage: process.env.AUDIO_ASK_LANGUAGE_EN,

    // "I saw you expressed interest in MSN One in Neopolis. Looking for 4 or 5 BHK?"
    askBHK: process.env.AUDIO_ASK_BHK_EN,

    // "That's a great choice. We have luxurious 4 & 5 BHK. Would you like to know more?"
    branchA_details: process.env.AUDIO_BRANCH_A_DETAILS_EN,

    // "Neha Rao will call you soon to explain. Thanks for your time. Bye!"
    branchA_goodbye: process.env.AUDIO_BRANCH_A_GOODBYE_EN,

    // "No problem. If you do anytime, visit www.msnrealty.com. Have a nice day!"
    branchB_goodbye: process.env.AUDIO_BRANCH_B_GOODBYE_EN,

    // "Sorry, I didn't catch that. Could you repeat?"
    didNotUnderstand: process.env.AUDIO_NOT_UNDERSTOOD_EN,
  },
  te: {
    notAvailable: process.env.AUDIO_BRANCH_B_GOODBYE_TE,
    askLanguage: process.env.AUDIO_ASK_LANGUAGE_TE,
    askBHK: process.env.AUDIO_ASK_BHK_TE,
    branchA_details: process.env.AUDIO_BRANCH_A_DETAILS_TE,
    branchA_goodbye: process.env.AUDIO_BRANCH_A_GOODBYE_TE,
    branchB_goodbye: process.env.AUDIO_BRANCH_B_GOODBYE_TE,
    didNotUnderstand: process.env.AUDIO_NOT_UNDERSTOOD_TE,
  },
};

const STEP = {
  GREETING:     "GREETING",     // user responding to "can I have 2 mins?"
  ASK_LANGUAGE: "ASK_LANGUAGE", // user picking English or Telugu
  ASK_BHK:      "ASK_BHK",     // user saying 4, 5, or not interested
  ASK_MORE:     "ASK_MORE",     // user saying yes/no to callback
  DONE:         "DONE",
};

class ConversationManager {
  constructor(callUUID) {
    this.callUUID = callUUID;
    this.step     = STEP.GREETING;
    this.language = "en";  // default until user picks
    this.answers  = {};    // collected: { bhk, wantsCallback }
  }

  // Shorthand — gets audio URL for current language
  audio(key) {
    const url = AUDIO[this.language][key];
    if (!url) logger.warn(`[${this.callUUID}][Conv] Missing audio URL for key: ${key} lang: ${this.language}`);
    return url;
  }

  /**
   * Called with every final transcript from the user.
   * @returns {{ audioUrl: string|null, done: boolean }}
   *   audioUrl — play this on the call (null = nothing to play)
   *   done     — true = hang up after playing audioUrl
   */
  async handleTranscript(transcript) {
    logger.info(`[${this.callUUID}][Conv] STEP:${this.step} LANG:${this.language} | "${transcript}"`);

    switch (this.step) {

      // ── User responding to "Can I have 2 mins?" ──────────────────────
      case STEP.GREETING: {
        // Check negative FIRST and independently — a "no" should always end
        // the call even if the reply also weakly matches a positive word.
        if (isNegative(transcript)) {
          logger.info(`[${this.callUUID}][Conv] User declined → ending call`);
          this.step = STEP.DONE;
          return { audioUrl: this.audio("notAvailable"), done: true };
        }

        if (isPositive(transcript)) {
          logger.info(`[${this.callUUID}][Conv] User agreed → asking language`);
          this.step = STEP.ASK_LANGUAGE;
          return { audioUrl: this.audio("askLanguage"), done: false };
        }

        // Neither clearly positive nor negative — re-ask instead of assuming yes
        logger.info(`[${this.callUUID}][Conv] Unclear reply → re-asking`);
        return { audioUrl: this.audio("didNotUnderstand"), done: false };
      }

      // ── User picking English or Telugu ────────────────────────────────
      case STEP.ASK_LANGUAGE: {
        const detected = detectLanguage(transcript);

        if (!detected) {
          logger.info(`[${this.callUUID}][Conv] Language unclear → re-asking`);
          return { audioUrl: this.audio("askLanguage"), done: false };
        }

        this.language = detected;
        logger.info(`[${this.callUUID}][Conv] Language set → ${detected}`);
        this.step = STEP.ASK_BHK;
        return { audioUrl: this.audio("askBHK"), done: false };
      }

      // ── User responding to "4 or 5 BHK?" ─────────────────────────────
      case STEP.ASK_BHK: {
        const bhk = detectBHK(transcript);

        if (!bhk && isNegative(transcript)) {
          // Branch B — not interested
          logger.info(`[${this.callUUID}][Conv] Not interested → Branch B`);
          this.answers.interested = false;
          this.step = STEP.DONE;
          return { audioUrl: this.audio("branchB_goodbye"), done: true };
        }

        // Branch A — interested (said 4, 5, or something positive)
        this.answers.bhk         = bhk || "4 or 5"; // if they said "either" etc.
        this.answers.interested  = true;
        logger.info(`[${this.callUUID}][Conv] BHK: ${this.answers.bhk} → Branch A`);
        this.step = STEP.ASK_MORE;
        return { audioUrl: this.audio("branchA_details"), done: false };
      }

      // ── User responding to "Would you like to know more?" ────────────
      case STEP.ASK_MORE: {
        this.answers.wantsCallback = !isNegative(transcript); // yes = wants callback
        logger.info(`[${this.callUUID}][Conv] Wants callback: ${this.answers.wantsCallback}`);
        logger.info(`[${this.callUUID}][Conv] ✅ FINAL ANSWERS: ${JSON.stringify(this.answers)}`);

        // TODO: persist answers to your DB here
        // await db.save({ callUUID: this.callUUID, ...this.answers });

        this.step = STEP.DONE;

        if (this.answers.wantsCallback) {
          return { audioUrl: this.audio("branchA_goodbye"), done: true };
        } else {
          return { audioUrl: this.audio("branchB_goodbye"), done: true };
        }
      }

      default:
        return { audioUrl: null, done: true };
    }
  }
}

module.exports = ConversationManager;
