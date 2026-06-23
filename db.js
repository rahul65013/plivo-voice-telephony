const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");

const logger = require("./logger");

const client = new DynamoDBClient({
  region: process.env.AWS_REGION || "ap-south-1",
});

const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    removeUndefinedValues: true,
  },
});

const TABLE = process.env.DYNAMO_TABLE_NAME || "call_logs";

/**
 * Called on the very first turn — creates the record in DynamoDB.
 */
async function createCallLog({ callUUID, startedAt }) {
  try {
    await docClient.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          callUUID,
          startedAt: startedAt.toString(),
          createdAt: new Date().toISOString(),
          status: "in_progress",
          language: "unknown",
          transcripts: [],
          answers: {},
          step: "GREETING",
          outcome: null,
          endedAt: null,
          durationSec: null,
        },
      }),
    );

    logger.info(`[DB] ✅ Created call log — ${callUUID}`);
  } catch (err) {
    logger.error(`[DB] ❌ createCallLog failed: ${err.message}`);
  }
}

/**
 * Called after every turn — appends transcript and updates state.
 *
 * @param {object} data
 * @param {string} data.callUUID
 * @param {string} data.transcript
 * @param {string} data.step
 * @param {string} data.language
 * @param {object} data.answers
 * @param {string} [data.outcome]
 * @param {number} [data.endedAt]
 * @param {number} [data.durationSec]
 */
async function updateCallLog(data) {
  try {
    const expParts = [];
    const names = {};
    const values = {};

    // Append transcript safely
    expParts.push(
      "transcripts = list_append(if_not_exists(transcripts, :emptyList), :newTranscript)",
    );
    values[":emptyList"] = [];
    values[":newTranscript"] = [data.transcript];

    // Step
    expParts.push("#step = :step");
    names["#step"] = "step";
    values[":step"] = data.step;

    // Language
    expParts.push("#lang = :lang");
    names["#lang"] = "language";
    values[":lang"] = data.language;

    // Answers
    expParts.push("answers = :answers");
    values[":answers"] = data.answers || {};

    // Updated timestamp
    expParts.push("updatedAt = :updatedAt");
    values[":updatedAt"] = new Date().toISOString();

    // Final call updates
    if (data.outcome) {
      expParts.push("outcome = :outcome");
      values[":outcome"] = data.outcome;

      expParts.push("#status = :status");
      names["#status"] = "status";
      values[":status"] = "completed";

      expParts.push("endedAt = :endedAt");
      values[":endedAt"] = data.endedAt?.toString();

      expParts.push("durationSec = :durationSec");
      values[":durationSec"] = data.durationSec;
    }

    await docClient.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: {
          callUUID: data.callUUID,
        },
        UpdateExpression: `SET ${expParts.join(", ")}`,
        ExpressionAttributeNames:
          Object.keys(names).length > 0 ? names : undefined,
        ExpressionAttributeValues: values,
      }),
    );

    logger.info(
      `[DB] ✅ Updated call log — ${data.callUUID} | step: ${data.step}${
        data.outcome ? ` | outcome: ${data.outcome}` : ""
      }`,
    );
  } catch (err) {
    logger.error(`[DB] ❌ updateCallLog failed: ${err.message}`);
  }
}

module.exports = {
  createCallLog,
  updateCallLog,
};
