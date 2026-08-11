const { App, SocketModeReceiver } = require("@slack/bolt");
const env = require("./config/env");
require("./db/store").getState();
const { registerCommands } = require("./slack/commands");
const { registerActions } = require("./slack/actions");
const { registerScheduler } = require("./services/scheduler");
const logger = require("./utils/logger");

const receiver = new SocketModeReceiver({
  appToken: env.slackAppToken,
  clientPingTimeout: env.socketClientPingTimeoutMs,
  serverPingTimeout: env.socketServerPingTimeoutMs,
});

const app = new App({
  token: env.slackBotToken,
  signingSecret: env.slackSigningSecret,
  receiver,
});

registerCommands(app);
registerActions(app);
const scheduler = registerScheduler(app);

process.on("uncaughtException", (err) => {
  logger.error("uncaughtException", { error: err?.message || String(err), stack: err?.stack });
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  logger.error("unhandledRejection", { error: msg });
  process.exit(1);
});

(async () => {
  await app.start(env.port);
  // eslint-disable-next-line no-console
  console.log(
    `Unico Poll is running on port ${env.port} ` +
      `(socket ping timeout client=${env.socketClientPingTimeoutMs}ms server=${env.socketServerPingTimeoutMs}ms)`
  );
  scheduler.runStartupTick();
})();
