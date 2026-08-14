"use strict";

const env = require("../config/env");
const logger = require("../utils/logger");
const pollService = require("../services/pollService");
const { userSuggestionReceiptBlocks } = require("./blocks");

/**
 * Show a user only their own suggestions: channel ephemeral (may vanish) plus a
 * persistent DM so the list remains on their Slack the way the creator sees theirs.
 */
async function deliverUserSuggestionReceipt({ client, poll, userId, channelId }) {
  if (!client || !poll || !userId) {
    return { dm: false, ephemeral: false };
  }
  const suggestions = pollService.listSuggestionsForUser({ pollId: poll.id, userId });
  const blocks = userSuggestionReceiptBlocks({
    poll,
    suggestions,
    maxPerUser: env.suggestionMaxPerUser,
  });
  const text = pollService.getUserSuggestionSummaryLines({ pollId: poll.id, userId }).join("\n");
  const delivered = { dm: false, ephemeral: false };
  const chan = channelId || poll.channel_id;

  if (chan) {
    try {
      await client.chat.postEphemeral({
        channel: chan,
        user: userId,
        text,
        blocks,
      });
      delivered.ephemeral = true;
    } catch (err) {
      logger.warn("User suggestion receipt ephemeral failed", {
        pollId: poll.id,
        userId,
        error: err.message,
      });
    }
  }

  try {
    const im = await client.conversations.open({ users: userId });
    if (im.ok && im.channel?.id) {
      await client.chat.postMessage({
        channel: im.channel.id,
        text,
        blocks,
      });
      delivered.dm = true;
    } else {
      logger.warn("User suggestion receipt DM: conversations.open not ok", {
        pollId: poll.id,
        userId,
        error: im && im.error,
      });
    }
  } catch (err) {
    logger.warn("User suggestion receipt DM failed", {
      pollId: poll.id,
      userId,
      error: err.message,
    });
  }

  logger.info("User suggestion receipt delivered", {
    pollId: poll.id,
    userId,
    count: suggestions.length,
    ...delivered,
  });
  return delivered;
}

module.exports = {
  deliverUserSuggestionReceipt,
};
