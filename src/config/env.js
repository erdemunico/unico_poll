const path = require("path");
const dotenv = require("dotenv");

function trimSecret(value) {
  if (value === undefined || value === null) {
    return "";
  }
  let s = String(value).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

const projectRoot = path.resolve(__dirname, "..", "..");
dotenv.config({ path: path.join(projectRoot, ".env") });

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const env = {
  port: toInt(process.env.PORT, 3000),
  slackBotToken: trimSecret(process.env.SLACK_BOT_TOKEN),
  slackSigningSecret: trimSecret(process.env.SLACK_SIGNING_SECRET),
  slackAppToken: trimSecret(process.env.SLACK_APP_TOKEN),
  databasePath: path.resolve(projectRoot, trimSecret(process.env.DATABASE_PATH) || "./data/unico-poll.db"),
  defaultSuggestionHours: toInt(process.env.DEFAULT_SUGGESTION_HOURS, 48),
  defaultVotingHours: toInt(process.env.DEFAULT_VOTING_HOURS, 48),
  defaultRunoffHours: toInt(process.env.DEFAULT_RUNOFF_HOURS, 24),
  fastTestMode: String(process.env.FAST_TEST_MODE || "false").toLowerCase() === "true",
  fastTestMinutes: toInt(process.env.FAST_TEST_MINUTES, 5),
  allowedCreatorIds: String(process.env.ALLOWED_CREATOR_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
  suggestionRateLimitCount: toInt(process.env.SUGGESTION_RATE_LIMIT_COUNT, 5),
  suggestionRateLimitWindowMinutes: toInt(process.env.SUGGESTION_RATE_LIMIT_WINDOW_MINUTES, 1),
};

const required = ["slackBotToken", "slackSigningSecret", "slackAppToken"];
for (const key of required) {
  if (!env[key]) {
    throw new Error(`Missing required environment variable for ${key}. Check .env`);
  }
}

module.exports = env;
