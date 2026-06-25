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
async function createCallLog({ callUUID, toNumber, startedAt }) {
  try {
    await docClient.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          callUUID,
          toNumber: toNumber || "unknown",
          startedAt: startedAt.toString(),
          createdAt: new Date().toISOString(),
          status: "in_progress",
          language: "unknown",
          qa: [], // [{ question, answer }, ...]
          answers: {},
          step: "CONFIRM_PERSON",
          outcome: null,
          endedAt: null,
          durationSec: null,
        },
      }),
    );
    logger.info(`[DB] ✅ Created call log — ${callUUID} → ${toNumber}`);
  } catch (err) {
    logger.error(`[DB] ❌ createCallLog failed: ${err.message}`);
  }
}

/**
 * Called after every turn — replaces qa list and updates current state.
 *
 * @param {object}   data
 * @param {string}   data.callUUID
 * @param {string}   data.toNumber
 * @param {Array}    data.qa          - full [{question, answer}] array so far
 * @param {string}   data.step
 * @param {string}   data.language
 * @param {object}   data.answers
 * @param {string}   [data.outcome]   - only on final turn
 * @param {number}   [data.endedAt]   - only on final turn
 * @param {number}   [data.durationSec] - only on final turn
 */
async function updateCallLog(data) {
  try {
    const expParts = [];
    const names = {};
    const values = {};

    // Replace full qa array each turn (append-in-DynamoDB for nested objects
    // is complex — replacing the whole list is simpler and just as reliable)
    expParts.push("qa = :qa");
    values[":qa"] = data.qa || [];

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

    // toNumber
    expParts.push("toNumber = :toNumber");
    values[":toNumber"] = data.toNumber || "unknown";

    // Updated timestamp
    expParts.push("updatedAt = :updatedAt");
    values[":updatedAt"] = new Date().toISOString();

    // Final turn only
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
        Key: { callUUID: data.callUUID },
        UpdateExpression: `SET ${expParts.join(", ")}`,
        ExpressionAttributeNames:
          Object.keys(names).length > 0 ? names : undefined,
        ExpressionAttributeValues: values,
      }),
    );

    logger.info(
      `[DB] ✅ Updated — ${data.callUUID} | step: ${data.step}${data.outcome ? ` | outcome: ${data.outcome}` : ""}`,
    );
  } catch (err) {
    logger.error(`[DB] ❌ updateCallLog failed: ${err.message}`);
  }
}

module.exports = { createCallLog, updateCallLog };
