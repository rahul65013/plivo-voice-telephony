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
 * conversationManager.js — MSN Realty Full Script
 *
 * FLOW:
 *
 *  [Greeting audio plays via <Play> in /answer XML]
 *  "Hello, this is Aditi from MSN Realty. Is this Mr. [name]?"
 *
 *  STEP: CONFIRM_PERSON
 *    [yes]    → askLanguage       → STEP: ASK_LANGUAGE
 *    [no]     → notAvailable      → done ❌
 *    [unclear] → didNotUnderstand → re-ask
 *
 *  STEP: ASK_LANGUAGE
 *    [english] → language="en" → askBHK → STEP: ASK_BHK
 *    [telugu]  → language="te" → askBHK → STEP: ASK_BHK
 *    [unclear] → re-ask
 *
 *  STEP: ASK_BHK
 *    [4]              → details4BHK    → STEP: ASK_CALLBACK   [Part A - 4BHK]
 *    [5]              → details5BHK    → STEP: ASK_CALLBACK   [Part A - 5BHK]
 *    [negative/none]  → branchB_goodbye → done ❌             [Part B - not interested]  leadScore: Negative
 *    [other BHK 2/3]  → branchC_offer  → STEP: ASK_OTHER_BHK [Part C - wrong BHK]       leadScore: Maybe
 *
 *  STEP: ASK_CALLBACK  (after 4 or 5 BHK details played)
 *    [yes] → callbackGoodbye → done ✅   leadScore: Positive
 *    [no]  → noCallbackGoodbye → done ✅ leadScore: Maybe
 *
 *  STEP: ASK_OTHER_BHK  (Part C — offered 4/5 after they said 2/3)
 *    [yes] → callbackGoodbye → done ✅
 *    [no]  → noCallbackGoodbye → done ✅
 */

const logger = require("./logger");
const { createCallLog, updateCallLog } = require("./db");

// ── Keyword helpers ───────────────────────────────────────────────────────────

const POSITIVE_WORDS = [
  "yes", "yeah", "yep", "sure", "okay", "ok", "of course", "definitely",
  "absolutely", "please", "go ahead", "fine", "alright", "correct",
  "haan", "ha", "theek", "zaroor", "bilkul", "avunu", "అవును", "sari", "సరి",
];

const NEGATIVE_WORDS = [
  "no", "nope", "never", "don't", "didn't", "i am not", "i'm not",
  "nahi", "mat", "ledu", "వద్దు", "లేదు",
  "not interested", "not looking", "i did not", "i haven't", "didn't",
];

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
  if (["english", "eng", "angrezi", "inglis"].some((w) => t.includes(w))) return "en";
  if (["telugu", "telgu", "teligi", "తెలుగు"].some((w) => t.includes(w))) return "te";
  return null;
}

/**
 * Detect BHK preference from transcript.
 * Returns: "4" | "5" | "other" | null
 *   "other" = they mentioned 1/2/3 BHK (not what we sell)
 *   null    = couldn't detect any BHK mention
 */
function detectBHK(text) {
  const t = text.toLowerCase();
  if (t.includes("5") || t.includes("five"))  return "5";
  if (t.includes("4") || t.includes("four"))  return "4";
  if (
    t.includes("3") || t.includes("three") ||
    t.includes("2") || t.includes("two")   ||
    t.includes("1") || t.includes("one")   ||
    t.includes("bhk")  // mentioned BHK but not 4 or 5
  ) return "other";
  return null;
}

// ── Audio URL map — all from .env ─────────────────────────────────────────────
const AUDIO = {
  en: {
    // "Wrong number / not the person" — end call politely
    notAvailable:       process.env.AUDIO_NOT_AVAILABLE_EN,

    // "Are you comfortable with English or Telugu?"
    askLanguage:        process.env.AUDIO_ASK_LANGUAGE_EN,

    // "I saw you expressed interest in MSN One. Looking for 4 or 5 BHK?"
    askBHK:             process.env.AUDIO_ASK_BHK_EN,

    // Part A — 4 BHK details + ask for callback
    // "We have well-crafted 4BHKs starting at 5300 sqft... Shall I ask Neha to call?"
    details4BHK:        process.env.AUDIO_DETAILS_4BHK_EN,

    // Part A — 5 BHK details + ask for callback
    // "5BHK is a great choice. Starting at 7200 sqft... Shall I ask Neha to call?"
    details5BHK:        process.env.AUDIO_DETAILS_5BHK_EN,

    // Part A — yes to callback [Lead: Positive]
    // "Neha Kapoor will call you soon. Thanks! Bye!"
    callbackGoodbye:    process.env.AUDIO_CALLBACK_GOODBYE_EN,

    // Part A — no to callback / Part C — no to alt offer [Lead: Maybe]
    // "No problem. Visit www.msnrealty.com. Have a nice day!"
    noCallbackGoodbye:  process.env.AUDIO_NO_CALLBACK_GOODBYE_EN,

    // Part B — not interested in any BHK [Lead: Negative]
    // "No problem. If you change your mind, visit www.msnrealty.com. Have a nice day!"
    branchB_goodbye:    process.env.AUDIO_BRANCH_B_GOODBYE_EN,

    // Part C — they want 2/3 BHK, offer 4/5
    // "We don't have that. But would you be interested in our 4 or 5 BHK?"
    branchC_offer:      process.env.AUDIO_BRANCH_C_OFFER_EN,

    // Default fallback
    didNotUnderstand:   process.env.AUDIO_NOT_UNDERSTOOD_EN,
  },
  te: {
    notAvailable:       process.env.AUDIO_NOT_AVAILABLE_TE,
    askLanguage:        process.env.AUDIO_ASK_LANGUAGE_TE,
    askBHK:             process.env.AUDIO_ASK_BHK_TE,
    details4BHK:        process.env.AUDIO_DETAILS_4BHK_TE,
    details5BHK:        process.env.AUDIO_DETAILS_5BHK_TE,
    callbackGoodbye:    process.env.AUDIO_CALLBACK_GOODBYE_TE,
    noCallbackGoodbye:  process.env.AUDIO_NO_CALLBACK_GOODBYE_TE,
    branchB_goodbye:    process.env.AUDIO_BRANCH_B_GOODBYE_TE,
    branchC_offer:      process.env.AUDIO_BRANCH_C_OFFER_TE,
    didNotUnderstand:   process.env.AUDIO_NOT_UNDERSTOOD_TE,
  },
};

// Lead score values saved to DynamoDB
const LEAD_SCORE = {
  POSITIVE: "Positive",
  MAYBE:    "Maybe",
  NEGATIVE: "Negative",
};

const STEP = {
  CONFIRM_PERSON: "CONFIRM_PERSON", // "Is this Mr. X?"
  ASK_LANGUAGE:   "ASK_LANGUAGE",   // "English or Telugu?"
  ASK_BHK:        "ASK_BHK",        // "4 or 5 BHK?"
  ASK_CALLBACK:   "ASK_CALLBACK",   // "Shall I ask Neha to call?" (after 4 or 5 BHK details)
  ASK_OTHER_BHK:  "ASK_OTHER_BHK",  // Part C: "Interested in 4/5 instead?"
  DONE:           "DONE",
};

class ConversationManager {
  constructor(callUUID) {
    this.callUUID  = callUUID;
    this.step      = STEP.CONFIRM_PERSON;
    this.language  = "en";
    this.answers   = {};    // { bhk, wantsCallback, leadScore, interested }
    this.startedAt = Date.now();
    this.turnCount = 0;
  }

  audio(key) {
    const url = AUDIO[this.language][key];
    if (!url) logger.warn(`[${this.callUUID}][Conv] Missing audio URL: ${key} (${this.language})`);
    return url;
  }

  async _save(transcript, outcome = null) {
    const isFinal     = outcome !== null;
    const endedAt     = isFinal ? Date.now() : null;
    const durationSec = isFinal ? Math.round((endedAt - this.startedAt) / 1000) : null;

    if (this.turnCount === 1) {
      await createCallLog({
        callUUID:  this.callUUID,
        toNumber:  this.toNumber,
        startedAt: this.startedAt,
      });
    }

    await updateCallLog({
      callUUID: this.callUUID,
      toNumber: this.toNumber,
      qa:       this.qa,          // full question+answer history
      step:     this.step,
      language: this.language,
      answers:  this.answers,
      ...(isFinal && { outcome, endedAt, durationSec }),
    });
  }

  async handleTranscript(transcript) {
    this.turnCount++;
    logger.info(`[${this.callUUID}][Conv] Turn:${this.turnCount} Step:${this.step} | "${transcript}"`);

    // Record question+answer for this turn BEFORE step transitions
    this.qa.push({
      question: this._questionText(this.step),
      answer:   transcript,
    });

    switch (this.step) {

      // ── "Is this Mr. [name]?" ─────────────────────────────────────────────
      case STEP.CONFIRM_PERSON: {
        if (isNegative(transcript)) {
          logger.info(`[${this.callUUID}][Conv] Wrong person → ending call`);
          this.step = STEP.DONE;
          await this._save(transcript, "wrong_person");
          return { audioUrl: this.audio("notAvailable"), done: true };
        }

        if (isPositive(transcript)) {
          logger.info(`[${this.callUUID}][Conv] Person confirmed → asking language`);
          this.step = STEP.ASK_LANGUAGE;
          await this._save(transcript);
          return { audioUrl: this.audio("askLanguage"), done: false };
        }

        // Unclear — re-ask
        await this._save(transcript);
        return { audioUrl: this.audio("didNotUnderstand"), done: false };
      }

      // ── "English or Telugu?" ──────────────────────────────────────────────
      case STEP.ASK_LANGUAGE: {
        const detected = detectLanguage(transcript);

        if (!detected) {
          await this._save(transcript);
          return { audioUrl: this.audio("didNotUnderstand"), done: false };
        }

        this.language = detected;
        logger.info(`[${this.callUUID}][Conv] Language → ${detected}`);
        this.step = STEP.ASK_BHK;
        await this._save(transcript);
        return { audioUrl: this.audio("askBHK"), done: false };
      }

      // ── "4 or 5 BHK?" ────────────────────────────────────────────────────
      case STEP.ASK_BHK: {
        const bhk = detectBHK(transcript);

        // Part B — explicitly not interested
        if (!bhk && isNegative(transcript)) {
          logger.info(`[${this.callUUID}][Conv] Not interested → Part B`);
          this.answers.interested = false;
          this.answers.leadScore  = LEAD_SCORE.NEGATIVE;
          this.step = STEP.DONE;
          await this._save(transcript, "not_interested");
          return { audioUrl: this.audio("branchB_goodbye"), done: true };
        }

        // Part A — 4 BHK
        if (bhk === "4") {
          logger.info(`[${this.callUUID}][Conv] 4 BHK → Part A`);
          this.answers.bhk        = "4";
          this.answers.interested = true;
          this.step = STEP.ASK_CALLBACK;
          await this._save(transcript);
          return { audioUrl: this.audio("details4BHK"), done: false };
        }

        // Part A — 5 BHK
        if (bhk === "5") {
          logger.info(`[${this.callUUID}][Conv] 5 BHK → Part A`);
          this.answers.bhk        = "5";
          this.answers.interested = true;
          this.step = STEP.ASK_CALLBACK;
          await this._save(transcript);
          return { audioUrl: this.audio("details5BHK"), done: false };
        }

        // Part C — wrong BHK (2/3 etc)
        if (bhk === "other") {
          logger.info(`[${this.callUUID}][Conv] Other BHK → Part C`);
          this.answers.bhk       = "other";
          this.answers.leadScore = LEAD_SCORE.MAYBE;
          this.step = STEP.ASK_OTHER_BHK;
          await this._save(transcript);
          return { audioUrl: this.audio("branchC_offer"), done: false };
        }

        // Couldn't detect BHK at all — re-ask
        logger.info(`[${this.callUUID}][Conv] BHK unclear → re-asking`);
        await this._save(transcript);
        return { audioUrl: this.audio("didNotUnderstand"), done: false };
      }

      // ── "Shall I ask Neha to call?" (Part A — after 4 or 5 BHK details) ──
      case STEP.ASK_CALLBACK: {
        if (isNegative(transcript)) {
          // No callback — Lead: Maybe
          logger.info(`[${this.callUUID}][Conv] No callback → Lead: Maybe`);
          this.answers.wantsCallback = false;
          this.answers.leadScore     = LEAD_SCORE.MAYBE;
          this.step = STEP.DONE;
          await this._save(transcript, "completed_no_callback");
          return { audioUrl: this.audio("noCallbackGoodbye"), done: true };
        }

        // Yes callback — Lead: Positive
        logger.info(`[${this.callUUID}][Conv] Wants callback → Lead: Positive`);
        this.answers.wantsCallback = true;
        this.answers.leadScore     = LEAD_SCORE.POSITIVE;
        this.step = STEP.DONE;
        await this._save(transcript, "completed_callback");
        return { audioUrl: this.audio("callbackGoodbye"), done: true };
      }

      // ── Part C: "Interested in 4 or 5 BHK instead?" ──────────────────────
      case STEP.ASK_OTHER_BHK: {
        if (isNegative(transcript)) {
          // Still not interested — Lead: Maybe (already set)
          logger.info(`[${this.callUUID}][Conv] Part C rejected → ending`);
          this.answers.wantsCallback = false;
          this.step = STEP.DONE;
          await this._save(transcript, "completed_no_callback");
          return { audioUrl: this.audio("noCallbackGoodbye"), done: true };
        }

        // Interested in 4/5 after all — Lead: Positive
        logger.info(`[${this.callUUID}][Conv] Part C accepted → Lead: Positive`);
        this.answers.wantsCallback = true;
        this.answers.leadScore     = LEAD_SCORE.POSITIVE;
        this.step = STEP.DONE;
        await this._save(transcript, "completed_callback");
        return { audioUrl: this.audio("callbackGoodbye"), done: true };
      }

      default:
        return { audioUrl: null, done: true };
    }
  }
}

module.exports = ConversationManager;
