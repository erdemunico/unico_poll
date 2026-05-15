const cron = require("node-cron");
const pollService = require("./pollService");
const store = require("../db/store");
const { notifySuggestionPhaseEnded, notifyPollClosedInsufficientSuggestions } = require("../slack/commands");
const { sendCreatorResults } = require("../slack/actions");
const logger = require("../utils/logger");

/**
 * Serialize scheduler work so a slow tick (Slack API) cannot overlap the next cron
 * and process the same expired poll twice in one process.
 */
function registerScheduler(app) {
  let chain = Promise.resolve();

  cron.schedule("*/1 * * * *", () => {
    chain = chain
      .then(() => runSchedulerTick(app))
      .catch((err) => logger.error("Scheduler tick failed", { error: err.message }));
  });
}

async function runSchedulerTick(app) {
  store.reloadStoreFromDisk();
  const expiredSuggestion = pollService.getExpiredSuggestionPolls();
  for (const poll of expiredSuggestion) {
    if (!pollService.tryClaimSuggestionPhaseClose(poll.id)) {
      continue;
    }
    try {
      const suggestions = pollService.listSuggestions(poll.id);
      if (suggestions.length < 2) {
        pollService.closePoll(poll.id);
        await notifyPollClosedInsufficientSuggestions({ app, poll, count: suggestions.length });
      } else {
        await notifySuggestionPhaseEnded({ app, poll });
        pollService.markSuggestionClosed(poll.id);
      }
    } catch (err) {
      pollService.clearSuggestionPhaseCloseClaim(poll.id);
      logger.error("Suggestion phase close failed", { pollId: poll.id, error: err.message });
    }
  }

  const expiredVoting = pollService.getExpiredVotingPolls();
  for (const poll of expiredVoting) {
    store.reloadStoreFromDisk();
    const fresh = pollService.getPollById(poll.id);
    if (!fresh || fresh.phase !== "voting") {
      continue;
    }
    if (fresh.creator_results_sent_at) {
      continue;
    }
    if (!pollService.tryClaimVotingCloseDelivery(poll.id)) {
      continue;
    }
    try {
      pollService.closePoll(poll.id);
      await sendCreatorResults(app, poll.id);
    } catch (err) {
      pollService.clearVotingCloseDeliveryClaim(poll.id);
      logger.error("Voting phase close failed", { pollId: poll.id, error: err.message });
    }
  }
}

module.exports = {
  registerScheduler,
};
