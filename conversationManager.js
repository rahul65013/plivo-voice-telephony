/**
 * conversationManager.js — MSN Realty Full Script
 *
 * FLOW:
 *  [Greeting audio plays via <Play> in /answer XML]
 *  "Hello, this is Aditi from MSN Realty. Is this Mr. [name]?"
 *
 *  STEP: CONFIRM_PERSON
 *    [yes]     → askLanguage      → STEP: ASK_LANGUAGE
 *    [no]      → notAvailable     → done ❌
 *    [unclear] → didNotUnderstand → re-ask
 *
 *  STEP: ASK_LANGUAGE
 *    [english] → language="en" → askBHK → STEP: ASK_BHK
 *    [telugu]  → language="te" → askBHK → STEP: ASK_BHK
 *    [unclear] → re-ask
 *
 *  STEP: ASK_BHK
 *    [4]             → details4BHK    → STEP: ASK_CALLBACK   [Part A] leadScore: -
 *    [5]             → details5BHK    → STEP: ASK_CALLBACK   [Part A] leadScore: -
 *    [negative/none] → branchB_goodbye → done ❌             [Part B] leadScore: Negative
 *    [other 2/3 BHK] → branchC_offer  → STEP: ASK_OTHER_BHK [Part C] leadScore: Maybe
 *
 *  STEP: ASK_CALLBACK
 *    [yes] → callbackGoodbye   → done ✅  leadScore: Positive
 *    [no]  → noCallbackGoodbye → done ✅  leadScore: Maybe
 *
 *  STEP: ASK_OTHER_BHK (Part C)
 *    [yes] → callbackGoodbye   → done ✅  leadScore: Positive
 *    [no]  → noCallbackGoodbye → done ✅  leadScore: Maybe
 *
 *  CALL DROP (at any step):
 *    CONFIRM_PERSON → leadScore: Negative  (never confirmed identity)
 *    any other step → leadScore: Maybe     (got past intro but dropped)
 *    outcome: call_dropped
 */

const logger = require("./logger");
const { createCallLog, updateCallLog } = require("./db");

// ── Keyword helpers ───────────────────────────────────────────────────────────

const POSITIVE_WORDS = [
  "yes",
  "yeah",
  "yep",
  "sure",
  "okay",
  "ok",
  "of course",
  "definitely",
  "absolutely",
  "please",
  "go ahead",
  "fine",
  "alright",
  "correct",
  "haan",
  "ha",
  "theek",
  "zaroor",
  "bilkul",
  "avunu",
  "అవును",
  "sari",
  "సరి",
];

const NEGATIVE_WORDS = [
  "no",
  "nope",
  "never",
  "don't",
  "didn't",
  "i am not",
  "i'm not",
  "nahi",
  "mat",
  "ledu",
  "వద్దు",
  "లేదు",
  "not interested",
  "not looking",
  "i did not",
  "i haven't",
];

function isPositive(text) {
  return POSITIVE_WORDS.some((w) => text.toLowerCase().includes(w));
}

function isNegative(text) {
  return NEGATIVE_WORDS.some((w) => text.toLowerCase().includes(w));
}

function detectLanguage(text) {
  const t = text.toLowerCase();
  if (["english", "eng", "angrezi", "inglis"].some((w) => t.includes(w)))
    return "en";
  if (["telugu", "telgu", "teligi", "తెలుగు"].some((w) => t.includes(w)))
    return "te";
  return null;
}

function detectBHK(text) {
  const t = text.toLowerCase();
  if (t.includes("5") || t.includes("five")) return "5";
  if (t.includes("4") || t.includes("four")) return "4";
  if (
    t.includes("3") ||
    t.includes("three") ||
    t.includes("2") ||
    t.includes("two") ||
    t.includes("1") ||
    t.includes("one") ||
    t.includes("bhk")
  )
    return "other";
  return null;
}

// ── Audio URL map — all from .env ─────────────────────────────────────────────
const AUDIO = {
  en: {
    notAvailable: process.env.AUDIO_NOT_AVAILABLE_EN,
    askLanguage: process.env.AUDIO_ASK_LANGUAGE_EN,
    askBHK: process.env.AUDIO_ASK_BHK_EN,
    details4BHK: process.env.AUDIO_DETAILS_4BHK_EN,
    details5BHK: process.env.AUDIO_DETAILS_5BHK_EN,
    callbackGoodbye: process.env.AUDIO_CALLBACK_GOODBYE_EN,
    noCallbackGoodbye: process.env.AUDIO_NO_CALLBACK_GOODBYE_EN,
    branchB_goodbye: process.env.AUDIO_BRANCH_B_GOODBYE_EN,
    branchC_offer: process.env.AUDIO_BRANCH_C_OFFER_EN,
    didNotUnderstand: process.env.AUDIO_NOT_UNDERSTOOD_EN,
  },
  te: {
    notAvailable: process.env.AUDIO_NOT_AVAILABLE_TE,
    askLanguage: process.env.AUDIO_ASK_LANGUAGE_TE,
    askBHK: process.env.AUDIO_ASK_BHK_TE,
    details4BHK: process.env.AUDIO_DETAILS_4BHK_TE,
    details5BHK: process.env.AUDIO_DETAILS_5BHK_TE,
    callbackGoodbye: process.env.AUDIO_CALLBACK_GOODBYE_TE,
    noCallbackGoodbye: process.env.AUDIO_NO_CALLBACK_GOODBYE_TE,
    branchB_goodbye: process.env.AUDIO_BRANCH_B_GOODBYE_TE,
    branchC_offer: process.env.AUDIO_BRANCH_C_OFFER_TE,
    didNotUnderstand: process.env.AUDIO_NOT_UNDERSTOOD_TE,
  },
};

// ── Question text — saved to DB alongside each answer ────────────────────────
const QUESTION_TEXT = {
  CONFIRM_PERSON: process.env.Q_CONFIRM_PERSON || "Is this Mr./Ms. [name]?",
  ASK_LANGUAGE:
    process.env.Q_ASK_LANGUAGE ||
    "Are you comfortable with English? Or should we talk in Telugu?",
  ASK_BHK:
    process.env.Q_ASK_BHK ||
    "I saw you had expressed an interest in MSN One project in Neopolis. Are you looking for a 4 or 5 BHK?",
  ASK_CALLBACK:
    process.env.Q_ASK_CALLBACK ||
    "Would you like to know more about the details? I can ask my senior Neha Kapoor to connect with you soon.",
  ASK_OTHER_BHK:
    process.env.Q_ASK_OTHER_BHK ||
    "We don't have that. But would you be interested in checking out our 4 or 5 BHK?",
};

const LEAD_SCORE = {
  POSITIVE: "Positive",
  MAYBE: "Maybe",
  NEGATIVE: "Negative",
};

const STEP = {
  CONFIRM_PERSON: "CONFIRM_PERSON",
  ASK_LANGUAGE: "ASK_LANGUAGE",
  ASK_BHK: "ASK_BHK",
  ASK_CALLBACK: "ASK_CALLBACK",
  ASK_OTHER_BHK: "ASK_OTHER_BHK",
  DONE: "DONE",
};

class ConversationManager {
  constructor(callUUID, toNumber = "unknown") {
    this.callUUID = callUUID;
    this.toNumber = toNumber;
    this.step = STEP.CONFIRM_PERSON;
    this.language = "en";
    this.answers = {};
    this.startedAt = Date.now();
    this.turnCount = 0;
    this.qa = []; // [{ question, answer }]
    this.logInitialised = false; // guard: prevent duplicate createCallLog
  }

  // ── Called immediately when WS connects ──────────────────────────────────
  // Creates the DB record upfront so all subsequent updates have a record to update.
  // Guard ensures it only runs once even if Plivo fires two "start" events.
  async initCallLog() {
    return
    // if (this.logInitialised) return;
    // this.logInitialised = true;
    // await createCallLog({
    //   callUUID: this.callUUID,
    //   toNumber: this.toNumber,
    //   startedAt: this.startedAt,
    // });
  }

  // ── Called when call drops at any point (WS close / stop event) ──────────
  // Saves whatever state we have with a sensible lead score based on how far
  // the conversation got before the drop.
  //
  // Lead score on drop:
  //   CONFIRM_PERSON → Negative  (never even confirmed it was the right person)
  //   ASK_LANGUAGE   → Maybe     (confirmed person but no language yet)
  //   ASK_BHK        → Maybe     (confirmed + language set)
  //   ASK_CALLBACK   → Maybe     (interested in 4/5 BHK but dropped before confirming)
  //   ASK_OTHER_BHK  → Maybe     (was looking for other BHK)
  //   DONE           → skip      (already saved properly via normal flow)
  async saveOnDrop() {
    if (this.step === STEP.DONE) return; // already finalised — nothing to do

    logger.info(`[${this.callUUID}][Conv] Call dropped at step: ${this.step}`);

    // Assign lead score based on which step they were on when call dropped
    if (!this.answers.leadScore) {
      this.answers.leadScore =
        this.step === STEP.CONFIRM_PERSON
          ? LEAD_SCORE.NEGATIVE // never confirmed identity
          : LEAD_SCORE.MAYBE; // got past intro but dropped
    }

    // Mark as not interested if we never got a BHK answer
    if (this.answers.interested === undefined) {
      this.answers.interested = this.step === STEP.ASK_CALLBACK; // true only if they reached callback step
    }

    this.step = STEP.DONE;
    await this._save("call_dropped");
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  audio(key) {
    const url = AUDIO[this.language][key];
    if (!url)
      logger.warn(
        `[${this.callUUID}][Conv] Missing audio URL: ${key} (${this.language})`,
      );
    return url;
  }

  _recordQA(answer) {
    const question = QUESTION_TEXT[this.step];
    if (question) {
      this.qa.push({ question, answer });
      logger.info(
        `[${this.callUUID}][Conv] QA — Q: "${question}" | A: "${answer}"`,
      );
    }
  }

  async _save(outcome = null) {
    return
    // const isFinal = outcome !== null;
    // const endedAt = isFinal ? Date.now() : null;
    // const durationSec = isFinal
    //   ? Math.round((endedAt - this.startedAt) / 1000)
    //   : null;

    // await updateCallLog({
    //   callUUID: this.callUUID,
    //   toNumber: this.toNumber,
    //   qa: this.qa,
    //   step: this.step,
    //   language: this.language,
    //   answers: this.answers,
    //   ...(isFinal && { outcome, endedAt, durationSec }),
    // });
  }

  // ── Main entry — called for every transcript ──────────────────────────────
  async handleTranscript(transcript) {
    this.turnCount++;
    logger.info(
      `[${this.callUUID}][Conv] Turn:${this.turnCount} Step:${this.step} | "${transcript}"`,
    );

    this._recordQA(transcript); // record Q+A before step transitions

    switch (this.step) {
      // ── "Is this Mr. [name]?" ───────────────────────────────────────────
      case STEP.CONFIRM_PERSON: {
        if (isNegative(transcript)) {
          logger.info(`[${this.callUUID}][Conv] Wrong person → ending call`);
          this.answers.interested = false;
          this.answers.leadScore = LEAD_SCORE.NEGATIVE;
          this.step = STEP.DONE;
          await this._save("wrong_person");
          return { audioUrl: this.audio("notAvailable"), done: true };
        }
        if (isPositive(transcript)) {
          logger.info(`[${this.callUUID}][Conv] Confirmed → asking language`);
          this.step = STEP.ASK_LANGUAGE;
          await this._save();
          return { audioUrl: this.audio("askLanguage"), done: false };
        }
        // Unclear — re-ask
        await this._save();
        return { audioUrl: this.audio("didNotUnderstand"), done: false };
      }

      // ── "English or Telugu?" ────────────────────────────────────────────
      case STEP.ASK_LANGUAGE: {
        const detected = detectLanguage(transcript);
        if (!detected) {
          await this._save();
          return { audioUrl: this.audio("didNotUnderstand"), done: false };
        }
        this.language = detected;
        logger.info(`[${this.callUUID}][Conv] Language → ${detected}`);
        this.step = STEP.ASK_BHK;
        await this._save();
        return { audioUrl: this.audio("askBHK"), done: false };
      }

      // ── "4 or 5 BHK?" ───────────────────────────────────────────────────
      case STEP.ASK_BHK: {
        const bhk = detectBHK(transcript);

        // Part B — not interested
        if (!bhk && isNegative(transcript)) {
          logger.info(`[${this.callUUID}][Conv] Not interested → Part B`);
          this.answers.interested = false;
          this.answers.leadScore = LEAD_SCORE.NEGATIVE;
          this.step = STEP.DONE;
          await this._save("not_interested");
          return { audioUrl: this.audio("branchB_goodbye"), done: true };
        }

        // Part A — 4 BHK
        if (bhk === "4") {
          this.answers.bhk = "4";
          this.answers.interested = true;
          this.step = STEP.ASK_CALLBACK;
          await this._save();
          return { audioUrl: this.audio("details4BHK"), done: false };
        }

        // Part A — 5 BHK
        if (bhk === "5") {
          this.answers.bhk = "5";
          this.answers.interested = true;
          this.step = STEP.ASK_CALLBACK;
          await this._save();
          return { audioUrl: this.audio("details5BHK"), done: false };
        }

        // Part C — wrong BHK (2/3 etc)
        if (bhk === "other") {
          this.answers.bhk = "other";
          this.answers.interested = false;
          this.answers.leadScore = LEAD_SCORE.MAYBE;
          this.step = STEP.ASK_OTHER_BHK;
          await this._save();
          return { audioUrl: this.audio("branchC_offer"), done: false };
        }

        // BHK unclear — re-ask
        await this._save();
        return { audioUrl: this.audio("didNotUnderstand"), done: false };
      }

      // ── "Shall I ask Neha to call?" ─────────────────────────────────────
      case STEP.ASK_CALLBACK: {
        if (isNegative(transcript)) {
          this.answers.wantsCallback = false;
          this.answers.leadScore = LEAD_SCORE.MAYBE;
          this.step = STEP.DONE;
          await this._save("completed_no_callback");
          return { audioUrl: this.audio("noCallbackGoodbye"), done: true };
        }
        this.answers.wantsCallback = true;
        this.answers.leadScore = LEAD_SCORE.POSITIVE;
        this.step = STEP.DONE;
        await this._save("completed_callback");
        return { audioUrl: this.audio("callbackGoodbye"), done: true };
      }

      // ── Part C: "Interested in 4 or 5 BHK instead?" ────────────────────
      case STEP.ASK_OTHER_BHK: {
        if (isNegative(transcript)) {
          this.answers.wantsCallback = false;
          this.answers.leadScore = LEAD_SCORE.MAYBE;
          this.step = STEP.DONE;
          await this._save("completed_no_callback");
          return { audioUrl: this.audio("noCallbackGoodbye"), done: true };
        }
        this.answers.wantsCallback = true;
        this.answers.leadScore = LEAD_SCORE.POSITIVE;
        this.step = STEP.DONE;
        await this._save("completed_callback");
        return { audioUrl: this.audio("callbackGoodbye"), done: true };
      }

      default:
        return { audioUrl: null, done: true };
    }
  }
}

// Expose the AUDIO url map as a static property so server.js can walk every
// known clip and prefetch/cache its real duration at startup — this is what
// lets us know exactly when playback finishes without guessing a fixed delay.
ConversationManager.AUDIO = AUDIO;

module.exports = ConversationManager;
