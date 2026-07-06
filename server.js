// require("dotenv").config();

// const http = require("http");
// const WebSocket = require("ws");
// const express = require("express");
// const plivo = require("plivo");
// const CallSession = require("./callSession");
// const ConversationManager = require("./conversationManager");
// const logger = require("./logger");

// const REQUIRED = [
//   "PLIVO_AUTH_ID",
//   "PLIVO_AUTH_TOKEN",
//   "PLIVO_FROM_NUMBER",
//   "SARVAM_API_KEY",
//   "SERVER_BASE_URL",
//   "GREETING_AUDIO_URL",
// ];
// const missing = REQUIRED.filter((k) => !process.env[k]);
// if (missing.length) {
//   logger.error(`Missing env vars: ${missing.join(", ")}`);
//   process.exit(1);
// }

// const PORT = parseInt(process.env.PORT || "8080", 10);
// const BASE_URL = process.env.SERVER_BASE_URL.replace(/\/$/, "");
// const LANGUAGE = process.env.SARVAM_LANGUAGE || "en-IN";
// const GREETING_AUDIO_URL = process.env.GREETING_AUDIO_URL; // your wav/mp3 with greeting + language question
// const WS_STREAM_URL =
//   BASE_URL.replace(/^https/, "wss").replace(/^http/, "ws") + "/stream";

// const plivoClient = new plivo.Client(
//   process.env.PLIVO_AUTH_ID,
//   process.env.PLIVO_AUTH_TOKEN,
// );

// // Stores toNumber keyed by requestUuid from /make-call
// // so we can look it up when the WS stream connects
// const pendingCalls = new Map(); // requestUuid → toNumber

// const app = express();
// app.use(express.urlencoded({ extended: true }));
// app.use(express.json());

// app.get("/health", (_req, res) =>
//   res.json({ status: "ok", uptime: process.uptime().toFixed(0) + "s" }),
// );

// /**
//  * /answer — plays greeting audio (which already includes the language question),
//  * then opens the bidirectional stream to receive caller audio.
//  */
// app.all("/answer", (req, res) => {
//   // Plivo sends To (the number we dialled) in the answer request
//   const toNumber = req.body?.To || req.query?.To || "unknown";
//   const callUUID = req.body?.CallUUID || req.query?.CallUUID || "unknown";
//   console.log("callUIID", callUUID);
//   logger.info(`[HTTP] /answer — CallUUID: ${callUUID} To: ${toNumber}`);

//   const fileKey = req.query.fileKey;
//   const audioUrl = `https://d2mpwaasjbc18b.cloudfront.net/${fileKey}`;

//   // Store toNumber keyed by CallUUID — this is reliable because
//   // Plivo's CallUUID in /answer matches the callId in the WS start event
//   if (callUUID !== "unknown") pendingCalls.set(callUUID, toNumber);

//   const xml = `<?xml version="1.0" encoding="UTF-8"?>
// <Response>
//   <Play>${audioUrl}</Play>
//   <Stream
//     bidirectional="true"
//     keepCallAlive="true"
//     contentType="audio/x-mulaw;rate=8000">
//     ${WS_STREAM_URL}
//   </Stream>
// </Response>`;

//   logger.info(`[HTTP] XML:\n${xml}`);
//   res.set("Content-Type", "text/xml").send(xml);
// });

// const retryableErrors = [
//   "Network Congestion From Carrier",
//   "Temporary Failure",
//   "No Route To Destination",
// ];

// app.post("/hangup", async (req, res) => {
//   try {
//     logger.info(`[HANGUP] Payload: ${JSON.stringify(req.body, null, 2)}`);

//     const { CallUUID, From, To, HangupCause } = req.body;

//     logger.info(`[HANGUP] UUID=${CallUUID} Cause=${HangupCause}`);

//     if (
//       retryableErrors.includes(HangupCause) &&
//       From === process.env.PLIVO_FROM_NUMBER
//     ) {
//       logger.warn(`[HANGUP] Retrying call using secondary number`);

//       await plivoClient.calls.create(
//         process.env.PLIVO_SECONDARY_NUMBER,
//         To,
//         `${BASE_URL}/answer`,
//         {
//           answerMethod: "POST",
//           hangupUrl: `${BASE_URL}/hangup`,
//           hangupMethod: "POST",
//         },
//       );

//       logger.info(`[HANGUP] Retry initiated from secondary number`);
//     }

//     res.sendStatus(200);
//   } catch (err) {
//     logger.error(`[HANGUP] ${err.message}`);
//     res.sendStatus(500);
//   }
// });

// app.post("/make-call", async (req, res) => {
//   const { toNumber } = req.body;
//   if (!toNumber) return res.status(400).json({ error: "toNumber required" });

//   try {
//     const result = await plivoClient.calls.create(
//       process.env.PLIVO_FROM_NUMBER,
//       toNumber,
//       `${BASE_URL}/answer`,
//       {
//         answerMethod: "POST",
//         hangupUrl: `${BASE_URL}/hangup`,
//         hangupMethod: "POST",
//       },
//     );
//     logger.info(`[MAKE_CALL] Success — ${result.requestUuid}`);
//     pendingCalls.set(result.requestUuid, toNumber);
//     res.json(result);
//   } catch (err) {
//     logger.error(`[MAKE_CALL] ${err.message}`);
//     res.status(500).json({ error: err.message });
//   }
// });

// // ── WebSocket /stream ─────────────────────────────────────────────────────────
// const httpServer = http.createServer(app);
// const wss = new WebSocket.Server({ server: httpServer, path: "/stream" });

// const MULAW_SILENCE = Buffer.alloc(160, 0xff);

// wss.on("connection", (ws, req) => {
//   logger.info(`[WS] Connected from ${req.socket.remoteAddress}`);

//   let session = null;
//   let conv = null;
//   let callUUID = null;
//   let chunkCount = 0;
//   let keepAlive = null;
//   let isPlayingAudio = false;

//   const startKeepAlive = () => {
//     keepAlive = setInterval(() => {
//       if (ws.readyState === WebSocket.OPEN) {
//         ws.send(
//           JSON.stringify({
//             event: "playAudio",
//             media: {
//               contentType: "audio/x-mulaw;rate=8000",
//               sampleRate: 8000,
//               payload: MULAW_SILENCE.toString("base64"),
//             },
//           }),
//         );
//       }
//     }, 5000);
//   };

//   const stopKeepAlive = () => {
//     clearInterval(keepAlive);
//     keepAlive = null;
//   };

//   const playAudioUrl = async (audioUrl) => {
//     if (!audioUrl || !callUUID) return;
//     if (isPlayingAudio) {
//       logger.warn(`[${callUUID}] Already playing — skipping`);
//       return;
//     }
//     isPlayingAudio = true;
//     try {
//       logger.info(`[${callUUID}] 🔊 Playing: ${audioUrl}`);
//       await plivoClient.calls.playMusic(callUUID, audioUrl);
//     } catch (err) {
//       logger.error(`[${callUUID}] play error: ${err.message}`);
//     } finally {
//       setTimeout(() => {
//         isPlayingAudio = false;
//       }, 3000);
//     }
//   };

//   ws.on("message", async (raw) => {
//     let msg;
//     try {
//       msg = JSON.parse(raw.toString());
//     } catch {
//       return;
//     }

//     switch (msg.event) {
//       case "start": {
//         callUUID =
//           msg.start?.callId || msg.start?.streamSid || `call-${Date.now()}`;
//         logger.info(`[WS] START — callUUID: ${callUUID}`);
//         logger.info(`[WS] START full payload: ${JSON.stringify(msg.start)}`);

//         // Look up toNumber stored at /answer time (keyed by CallUUID)
//         const toNumber = pendingCalls.get(callUUID) || "unknown";
//         pendingCalls.delete(callUUID);
//         logger.info(`[WS] toNumber: ${toNumber}`);

//         conv = new ConversationManager(callUUID, toNumber);

//         // Create DB record immediately when call connects — don't wait for first transcript
//         // This ensures the record exists before any updateCallLog calls
//         await conv.initCallLog();

//         session = new CallSession({
//           callUUID,
//           sarvamApiKey: process.env.SARVAM_API_KEY,
//           language: LANGUAGE,
//           onTranscriptReady: (transcript) => onTranscript(transcript),
//         });

//         await session.start();
//         startKeepAlive();
//         // No extra audio to play here — greeting + language question
//         // was already played by <Play> in the /answer XML before stream opened
//         logger.info(`[WS] Session ready ✅`);
//         break;
//       }

//       case "media": {
//         if (!session || !msg.media?.payload) return;
//         chunkCount++;
//         if (chunkCount === 1) logger.info(`[WS] First audio chunk`);
//         if (chunkCount % 500 === 0) logger.info(`[WS] Chunks: ${chunkCount}`);
//         session.handleAudioChunk(msg.media.payload);
//         break;
//       }

//       case "stop": {
//         logger.info(`[WS] STOP — total chunks: ${chunkCount}`);
//         stopKeepAlive();
//         // saveOnDrop is a no-op if conv is already DONE (normal flow completed)
//         // handles the case where Plivo ends the call before conversation finished
//         if (conv) {
//           await conv
//             .saveOnDrop()
//             .catch((e) => logger.error(`[WS] saveOnDrop error: ${e.message}`));
//           conv = null;
//         }
//         if (session) {
//           await session.end();
//           session = null;
//         }
//         break;
//       }

//       default:
//         break; // ignore "incorrectPayload" and other housekeeping events
//     }
//   });

//   ws.on("close", () => {
//     logger.info(`[WS] Connection closed`);
//     stopKeepAlive();
//     // Save lead score + state if call dropped mid-conversation
//     conv
//       ?.saveOnDrop()
//       .catch((e) => logger.error(`[WS] saveOnDrop error: ${e.message}`));
//     session?.end().catch(() => {});
//     session = null;
//     conv = null;
//   });

//   ws.on("error", (err) => {
//     logger.error(`[WS] Error: ${err.message}`);
//     stopKeepAlive();
//   });

//   async function onTranscript(transcript) {
//     logger.info(`\n${"─".repeat(60)}`);
//     logger.info(`[TRANSCRIPT] "${transcript}"`);
//     logger.info(`${"─".repeat(60)}\n`);

//     if (!conv) return;

//     try {
//       const { audioUrl, done, language } =
//         await conv.handleTranscript(transcript);
//       if (language) logger.info(`[CONV] Language: ${language}`);

//       if (audioUrl) {
//         await playAudioUrl(audioUrl);

//         if (done) {
//           // Estimate audio duration from env, default 6s — set GOODBYE_AUDIO_DURATION_MS in .env
//           // to match the length of your longest goodbye audio file
//           const delay = parseInt(
//             process.env.GOODBYE_AUDIO_DURATION_MS || "6000",
//             10,
//           );
//           logger.info(
//             `[CONV] done=true — hanging up in ${delay}ms after goodbye audio`,
//           );
//           setTimeout(async () => {
//             try {
//               await plivoClient.calls.hangup(callUUID);
//               logger.info(`[CONV] ✅ Call hung up`);
//             } catch (err) {
//               // Call may have already ended by the time we hang up — that's fine
//               logger.warn(
//                 `[CONV] Hangup skipped (call likely already ended): ${err.message}`,
//               );
//             }
//           }, delay);
//         }
//       } else if (done) {
//         // No audio to play — hang up immediately
//         logger.info(`[CONV] done=true, no audio — hanging up now`);
//         try {
//           await plivoClient.calls.hangup(callUUID);
//           logger.info(`[CONV] ✅ Call hung up`);
//         } catch (err) {
//           logger.warn(`[CONV] Hangup skipped: ${err.message}`);
//         }
//       }
//     } catch (err) {
//       logger.error(`[TRANSCRIPT] Handler error: ${err.message}`);
//     }
//   }
// });

// httpServer.listen(PORT, "0.0.0.0", () => {
//   logger.info(`\n🚀 Server running on port ${PORT}`);
//   logger.info(`   Answer  : ${BASE_URL}/answer`);
//   logger.info(`   Stream  : ${WS_STREAM_URL}`);
//   logger.info(`   Greeting: ${GREETING_AUDIO_URL}`);
// });

// process.on("SIGINT", () => {
//   logger.info(`Shutting down`);
//   process.exit(0);
// });

// /**
//  * server.js
//  *
//  * Plivo outbound call bot:
//  *   POST /make-call  → dials the number
//  *   POST /answer     → returns XML (Speak greeting + bidirectional Stream)
//  *   WS   /stream     → receives Plivo audio, pipes to Sarvam STT
//  *
//  * Flow:
//  *   call answered → greeting played → stream opens → user speaks
//  *   → Sarvam transcribes → handleTranscript() called with text
//  *   → (TODO) fetch audio URL from your API → play it back
//  */

require("dotenv").config();

const http = require("http");
const WebSocket = require("ws");
const express = require("express");
const plivo = require("plivo");
const mm = require("music-metadata"); // npm install music-metadata
const CallSession = require("./callSession");
const ConversationManager = require("./conversationManager");
const logger = require("./logger");
const pendingCalls = new Map(); // requestUuid → toNumber
const pendingAudioUrls = new Map();

const REQUIRED = [
  "PLIVO_AUTH_ID",
  "PLIVO_AUTH_TOKEN",
  "PLIVO_FROM_NUMBER",
  "SARVAM_API_KEY",
  "SERVER_BASE_URL",
  "GREETING_AUDIO_URL",
];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  logger.error(`Missing env vars: ${missing.join(", ")}`);
  process.exit(1);
}

const PORT = parseInt(process.env.PORT || "8080", 10);
const BASE_URL = process.env.SERVER_BASE_URL.replace(/\/$/, "");
const LANGUAGE = process.env.SARVAM_LANGUAGE || "en-IN";
const GREETING_AUDIO_URL = process.env.GREETING_AUDIO_URL; // your wav/mp3 with greeting + language question
const WS_STREAM_URL =
  BASE_URL.replace(/^https/, "wss").replace(/^http/, "ws") + "/stream";

// Small safety pad added on top of the *real* clip duration, to absorb
// network jitter on some carrier legs. This is NOT a guess at the clip
// length — the clip length itself is measured from the actual file, this
// is just a small buffer around that known number. If the caller barges in,
// none of this matters — playback is stopped immediately instead.
const PLAYBACK_SAFETY_PAD_MS = parseInt(
  process.env.PLAYBACK_SAFETY_PAD_MS || "400",
  10,
);

const plivoClient = new plivo.Client(
  process.env.PLIVO_AUTH_ID,
  process.env.PLIVO_AUTH_TOKEN,
);

// ── Stop an in-progress Play via Plivo's REST API directly ───────────────────
// DELETE /v1/Account/{auth_id}/Call/{call_uuid}/Play/ — stops whatever audio
// is currently playing on the call. Called via fetch (not the SDK) so we
// don't depend on guessing a method name that may not exist in your
// installed plivo-node version.
async function stopPlayback(callUUID) {
  const authId = process.env.PLIVO_AUTH_ID;
  const authToken = process.env.PLIVO_AUTH_TOKEN;
  const url = `https://api.plivo.com/v1/Account/${authId}/Call/${callUUID}/Play/`;
  const basicAuth = Buffer.from(`${authId}:${authToken}`).toString("base64");

  const res = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Basic ${basicAuth}` },
  });

  // 404 just means nothing was playing anymore (clip already finished) — fine.
  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${body}`);
  }
}

// ── Audio duration cache ──────────────────────────────────────────────────────
// Maps audioUrl → duration in ms. Populated once per URL, then reused for
// every subsequent call that plays that same clip — no repeated network work.
const audioDurationCache = new Map();

async function getAudioDurationMs(audioUrl) {
  if (!audioUrl) return PLAYBACK_SAFETY_PAD_MS;
  if (audioDurationCache.has(audioUrl)) return audioDurationCache.get(audioUrl);

  try {
    const res = await fetch(audioUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const metadata = await mm.parseBuffer(buffer, undefined, {
      duration: true,
    });
    const seconds = metadata.format.duration;
    if (!seconds) throw new Error("no duration in metadata");
    const ms = Math.round(seconds * 1000);
    audioDurationCache.set(audioUrl, ms);
    logger.info(`[AUDIO] Probed duration for ${audioUrl}: ${ms}ms`);
    return ms;
  } catch (err) {
    logger.error(
      `[AUDIO] Duration probe failed for ${audioUrl}: ${err.message} — falling back to 4000ms`,
    );
    const fallbackMs = 4000;
    audioDurationCache.set(audioUrl, fallbackMs);
    return fallbackMs;
  }
}

// Prefetch every known clip's duration at startup so there is zero added
// latency during a live call — by the time a call comes in, the cache is warm.
async function prefetchAllAudioDurations() {
  const urls = new Set();

  for (const langMap of Object.values(ConversationManager.AUDIO || {})) {
    for (const url of Object.values(langMap)) {
      if (url) urls.add(url);
    }
  }
  if (GREETING_AUDIO_URL) urls.add(GREETING_AUDIO_URL);

  logger.info(
    `[AUDIO] Prefetching durations for ${urls.size} known clip(s)...`,
  );
  await Promise.all([...urls].map((url) => getAudioDurationMs(url)));
  logger.info(`[AUDIO] Prefetch complete.`);
}

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get("/health", (_req, res) =>
  res.json({ status: "ok", uptime: process.uptime().toFixed(0) + "s" }),
);

/**
 * /answer — plays greeting audio (which already includes the language question),
 * then opens the bidirectional stream to receive caller audio.
 */
app.all("/answer", (req, res) => {
  logger.info(`[HTTP] /answer`);
  const toNumber = req.body?.To || req.query?.To || "unknown";
  const callUUID = req.body?.CallUUID || req.query?.CallUUID || "unknown";
  logger.info(`[HTTP] /answer — CallUUID: ${callUUID} To: ${toNumber}`);
  const audioUrl = req.query.audioUrl;

  console.log("Original URL:", req.originalUrl);
  console.log("Query:", req.query);
  console.log("Body:", req.body);
  console.log("audioUrl", audioUrl);

  if (callUUID !== "unknown") {
    pendingCalls.set(callUUID, toNumber);

    if (audioUrl) {
      pendingAudioUrls.set(callUUID, audioUrl);
      logger.info(`[HTTP] Saved audioUrl for ${callUUID}`);
    }
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
   <Play>${audioUrl}</Play>
  <Stream
    bidirectional="true"
    keepCallAlive="true"
    contentType="audio/x-mulaw;rate=8000">
    ${WS_STREAM_URL}
  </Stream>
</Response>`;

  logger.info(`[HTTP] XML:\n${xml}`);
  res.set("Content-Type", "text/xml").send(xml);
});

const retryableErrors = [
  "Network Congestion From Carrier",
  "Temporary Failure",
  "No Route To Destination",
  "NORMAL_TEMPORARY_FAILURE",
];

app.post("/hangup", async (req, res) => {
  try {
    logger.info(`[HANGUP] Payload: ${JSON.stringify(req.body, null, 2)}`);

    const { CallUUID, From, To, HangupCause } = req.body;
    const audioUrl =
      pendingAudioUrls.get(CallUUID) ||
      pendingAudioUrls.get(req.body.RequestUUID);

    logger.info(`[HANGUP] audioUrl = ${audioUrl}`);

    logger.info(`[HANGUP] UUID=${CallUUID} Cause=${HangupCause}`);

    if (
      retryableErrors.includes(HangupCause) &&
      From === process.env.PLIVO_FROM_NUMBER
    ) {
      logger.warn(`[HANGUP] Retrying call using secondary number`);

      await plivoClient.calls.create(
        process.env.PLIVO_SECONDARY_NUMBER,
        To,
        `${BASE_URL}/answer?audioUrl=${encodeURIComponent(audioUrl)}`,
        {
          answerMethod: "POST",
          hangupUrl: `${BASE_URL}/hangup`,
          hangupMethod: "POST",
        },
      );
      pendingAudioUrls.delete(CallUUID);

      logger.info(`[HANGUP] Retry initiated from secondary number`);
    }

    res.sendStatus(200);
  } catch (err) {
    logger.error(`[HANGUP] ${err.message}`);
    res.sendStatus(500);
  }
});

app.post("/store-audio-url", (req, res) => {
  const { requestUuid, audioUrl } = req.body;

  pendingAudioUrls.set(requestUuid, audioUrl);

  logger.info(`[STORE] requestUuid=${requestUuid} audioUrl=${audioUrl}`);

  res.sendStatus(200);
});

app.post("/make-call", async (req, res) => {
  const { toNumber } = req.body;
  if (!toNumber) return res.status(400).json({ error: "toNumber required" });

  try {
    const result = await plivoClient.calls.create(
      process.env.PLIVO_FROM_NUMBER,
      toNumber,
      `${BASE_URL}/answer`,
      {
        answerMethod: "POST",
        hangupUrl: `${BASE_URL}/hangup`,
        hangupMethod: "POST",
      },
    );
    logger.info(`[MAKE_CALL] Success — ${result.requestUuid}`);
    res.json(result);
  } catch (err) {
    logger.error(`[MAKE_CALL] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── WebSocket /stream ─────────────────────────────────────────────────────────
const httpServer = http.createServer(app);
const wss = new WebSocket.Server({ server: httpServer, path: "/stream" });

const MULAW_SILENCE = Buffer.alloc(160, 0xff);

wss.on("connection", (ws, req) => {
  logger.info(`[WS] Connected from ${req.socket.remoteAddress}`);

  let session = null;
  let conv = null;
  let callUUID = null;
  let chunkCount = 0;
  let keepAlive = null;
  let isPlayingAudio = false;
  let playbackResumeTimer = null; // handle to the "resume listening" timeout, so barge-in can cancel it

  const startKeepAlive = () => {
    keepAlive = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            event: "playAudio",
            media: {
              contentType: "audio/x-mulaw;rate=8000",
              sampleRate: 8000,
              payload: MULAW_SILENCE.toString("base64"),
            },
          }),
        );
      }
    }, 5000);
  };

  const stopKeepAlive = () => {
    clearInterval(keepAlive);
    keepAlive = null;
  };

  // Returns the real (measured) duration of the clip that was played, in ms,
  // so callers (e.g. the final-hangup timer) can reuse the exact same number
  // instead of keeping their own separate guess.
  const playAudioUrl = async (audioUrl) => {
    if (!audioUrl || !callUUID) return 0;
    if (isPlayingAudio) {
      logger.warn(`[${callUUID}] Already playing — skipping`);
      return 0;
    }

    isPlayingAudio = true;
    const durationMs = await getAudioDurationMs(audioUrl); // cache hit in the common case — near-instant

    try {
      logger.info(`[${callUUID}] 🔊 Playing (${durationMs}ms): ${audioUrl}`);
      await plivoClient.calls.playMusic(callUUID, audioUrl);
    } catch (err) {
      logger.error(`[${callUUID}] play error: ${err.message}`);
      isPlayingAudio = false; // fail-safe — don't get stuck if the play call itself failed
      return 0;
    }

    // Resume listening exactly `durationMs` (the clip's real length) later,
    // plus a small fixed safety pad — unless barge-in cancels this first.
    playbackResumeTimer = setTimeout(() => {
      playbackResumeTimer = null;
      isPlayingAudio = false;
      logger.info(`[${callUUID}] 🎤 Clip finished naturally`);
    }, durationMs + PLAYBACK_SAFETY_PAD_MS);

    return durationMs;
  };

  // ── Barge-in ─────────────────────────────────────────────────────────────
  // Fired the instant VAD detects the caller started speaking. If we're
  // currently playing a clip, stop it immediately on the call and mark
  // playback as over — the caller's speech is now the answer for whatever
  // question was playing, and flows through onTranscript exactly like any
  // other turn once STT finalises it.
  const handleBargeIn = async () => {
    if (!isPlayingAudio || !callUUID) return;

    logger.info(`[${callUUID}] 🎤⚡ Barge-in detected — stopping playback`);

    if (playbackResumeTimer) {
      clearTimeout(playbackResumeTimer);
      playbackResumeTimer = null;
    }
    isPlayingAudio = false;

    try {
      await stopPlayback(callUUID);
      logger.info(`[${callUUID}] ⏹️ Playback stopped`);
    } catch (err) {
      logger.error(`[${callUUID}] stopPlayback error: ${err.message}`);
    }
  };

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.event) {
      case "start": {
        callUUID =
          msg.start?.callId || msg.start?.streamSid || `call-${Date.now()}`;
        logger.info(`[WS] START — callUUID: ${callUUID}`);

        // ✅ Look up toNumber stored at /answer time (keyed by CallUUID)
        const toNumber = pendingCalls.get(callUUID) || "unknown";
        pendingCalls.delete(callUUID);
        logger.info(`[WS] toNumber resolved: ${toNumber}`);

        conv = new ConversationManager(callUUID, toNumber); // ✅ pass toNumber

        // ✅ Create DB record immediately so all subsequent updates have a row to update
        await conv.initCallLog();

        session = new CallSession({
          callUUID,
          sarvamApiKey: process.env.SARVAM_API_KEY,
          language: LANGUAGE,
          onTranscriptReady: (transcript) => onTranscript(transcript),
          onSpeechStart: () => handleBargeIn(),
        });

        await session.start();
        startKeepAlive();
        // No extra audio to play here — greeting + language question
        // was already played by <Play> in the /answer XML before stream opened
        logger.info(`[WS] Session ready ✅`);
        break;
      }

      case "media": {
        if (!session || !msg.media?.payload) return;

        // STT runs continuously — even while our own audio is playing —
        // so we can detect barge-in via VAD as early as possible. Plivo's
        // bidirectional Stream only ever sends the caller's real (inbound)
        // audio here, never an echo of what we played, so this is safe.
        chunkCount++;
        if (chunkCount === 1) logger.info(`[WS] First audio chunk`);
        if (chunkCount % 500 === 0) logger.info(`[WS] Chunks: ${chunkCount}`);
        session.handleAudioChunk(msg.media.payload);
        break;
      }

      case "stop": {
        logger.info(`[WS] STOP — total chunks: ${chunkCount}`);
        stopKeepAlive();
        if (session) {
          await session.end();
          session = null;
        }
        break;
      }

      default:
        break; // ignore "incorrectPayload" and other housekeeping events
    }
  });

  ws.on("close", () => {
    logger.info(`[WS] Connection closed`);
    stopKeepAlive();
    session?.end().catch(() => {});
    session = null;
  });

  ws.on("error", (err) => {
    logger.error(`[WS] Error: ${err.message}`);
    stopKeepAlive();
  });

  async function onTranscript(transcript) {
    logger.info(`\n${"─".repeat(60)}`);
    logger.info(`[TRANSCRIPT] "${transcript}"`);
    logger.info(`${"─".repeat(60)}\n`);

    if (!conv) return;

    try {
      const { audioUrl, done, language } =
        await conv.handleTranscript(transcript);
      if (language) logger.info(`[CONV] Language: ${language}`);

      if (audioUrl) {
        const durationMs = await playAudioUrl(audioUrl);

        if (done) {
          // Use the clip's REAL measured duration (+ safety pad) to time the
          // hangup. If the caller barges in on the final goodbye clip too,
          // handleBargeIn() will have already stopped it and flipped
          // isPlayingAudio — the hangup still fires on schedule regardless,
          // which is fine since the call is ending either way.
          const delay = durationMs + PLAYBACK_SAFETY_PAD_MS;
          logger.info(
            `[CONV] done=true — hanging up in ${delay}ms after goodbye audio`,
          );
          setTimeout(async () => {
            try {
              await plivoClient.calls.hangup(callUUID);
              logger.info(`[CONV] ✅ Call hung up`);
            } catch (err) {
              // Call may have already ended by the time we hang up — that's fine
              logger.warn(
                `[CONV] Hangup skipped (call likely already ended): ${err.message}`,
              );
            }
          }, delay);
        }
      } else if (done) {
        // No audio to play — hang up immediately
        logger.info(`[CONV] done=true, no audio — hanging up now`);
        try {
          await plivoClient.calls.hangup(callUUID);
          logger.info(`[CONV] ✅ Call hung up`);
        } catch (err) {
          logger.warn(`[CONV] Hangup skipped: ${err.message}`);
        }
      }
    } catch (err) {
      logger.error(`[TRANSCRIPT] Handler error: ${err.message}`);
    }
  }
});

prefetchAllAudioDurations()
  .catch((err) => logger.error(`[AUDIO] Prefetch failed: ${err.message}`))
  .finally(() => {
    httpServer.listen(PORT, "0.0.0.0", () => {
      logger.info(`\n🚀 Server running on port ${PORT}`);
      logger.info(`   Answer  : ${BASE_URL}/answer`);
      logger.info(`   Stream  : ${WS_STREAM_URL}`);
      logger.info(`   Greeting: ${GREETING_AUDIO_URL}`);
    });
  });

process.on("SIGINT", () => {
  logger.info(`Shutting down`);
  process.exit(0);
});