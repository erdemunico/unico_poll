"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { describe, it, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unico-poll-receipts-"));
process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
process.env.SLACK_SIGNING_SECRET = "test-signing-secret";
process.env.SLACK_APP_TOKEN = "xapp-test-token";
process.env.DATABASE_PATH = path.join(tmpDir, "store.json");
process.env.SUGGESTION_MAX_PER_USER = "5";
process.env.FAST_TEST_MODE = "false";
process.env.SUGGESTION_RATE_LIMIT_COUNT = "0";

const store = require("../src/db/store");
const env = require("../src/config/env");
const pollService = require("../src/services/pollService");
const { parseSuggestionInput } = require("../src/utils/parser");
const {
  suggestionAnnouncementBlocks,
  userSuggestionReceiptBlocks,
} = require("../src/slack/blocks");
const { deliverUserSuggestionReceipt } = require("../src/slack/suggestionReceipts");

const CHANNEL = "C_FLOWMAZE";
const AYSE = { id: "U_AYSE", name: "Ayse Kaya" };
const MEHMET = { id: "U_MEHMET", name: "Mehmet Demir" };

function storeFile() {
  const p = env.databasePath;
  return String(p).endsWith(".json") ? p : `${String(p).replace(/\.db$/i, ".json")}`;
}

function resetStore() {
  const empty = {
    polls: [],
    suggestions: [],
    poll_shortlist: [],
    votes_classic: [],
    votes_rating: [],
  };
  fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
  fs.writeFileSync(storeFile(), JSON.stringify(empty, null, 2));
  store.reloadStoreFromDisk();
}

function addGame(pollId, user, gameName) {
  const parsed = parseSuggestionInput(`${gameName} : ${user.name}`);
  const result = pollService.addSuggestion({ pollId, userId: user.id, parsed });
  assert.equal(result.ok, true, result.reason || gameName);
}

function mockSlackClient() {
  const posts = [];
  return {
    posts,
    conversations: {
      open: async ({ users }) => ({ ok: true, channel: { id: `D_${users}` } }),
    },
    chat: {
      postMessage: async (payload) => {
        posts.push({ type: "message", ...payload });
        return { ok: true };
      },
      postEphemeral: async (payload) => {
        posts.push({ type: "ephemeral", ...payload });
        return { ok: true };
      },
    },
  };
}

describe("each user sees only their own suggestions", () => {
  beforeEach(() => {
    resetStore();
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("keeps Ayse and Mehmet lists separate", () => {
    const poll = pollService.createPoll({
      channelId: CHANNEL,
      creatorId: "U_ERDEM",
      creatorSlackIds: ["U_ERDEM"],
      title: "Flowmaze",
      suggestionHours: 48,
    });
    addGame(poll.id, AYSE, "Color Maze");
    addGame(poll.id, AYSE, "Maze Dash");
    addGame(poll.id, MEHMET, "Amaze Dash");

    const ayse = pollService.listSuggestionsForUser({ pollId: poll.id, userId: AYSE.id });
    const mehmet = pollService.listSuggestionsForUser({ pollId: poll.id, userId: MEHMET.id });
    assert.equal(ayse.length, 2);
    assert.equal(mehmet.length, 1);
    assert.deepEqual(
      ayse.map((s) => s.display_name),
      ["Color Maze", "Maze Dash"]
    );
    assert.equal(mehmet[0].display_name, "Amaze Dash");

    const ayseLines = pollService.getUserSuggestionSummaryLines({
      pollId: poll.id,
      userId: AYSE.id,
    }).join("\n");
    assert.match(ayseLines, /Color Maze/);
    assert.match(ayseLines, /Maze Dash/);
    assert.ok(!ayseLines.includes("Amaze Dash"));

    const mehmetLines = pollService.getUserSuggestionSummaryLines({
      pollId: poll.id,
      userId: MEHMET.id,
    }).join("\n");
    assert.match(mehmetLines, /Amaze Dash/);
    assert.ok(!mehmetLines.includes("Color Maze"));
  });

  it("receipt blocks never include someone else's games", () => {
    const poll = pollService.createPoll({
      channelId: CHANNEL,
      creatorId: "U_ERDEM",
      creatorSlackIds: ["U_ERDEM"],
      title: "Flowmaze",
      suggestionHours: 48,
    });
    addGame(poll.id, AYSE, "Color Maze");
    addGame(poll.id, MEHMET, "Amaze Dash");
    const blob = JSON.stringify(
      userSuggestionReceiptBlocks({
        poll,
        suggestions: pollService.listSuggestionsForUser({ pollId: poll.id, userId: MEHMET.id }),
        maxPerUser: 5,
      })
    );
    assert.ok(blob.includes("Amaze Dash"));
    assert.ok(!blob.includes("Color Maze"));
    assert.match(blob, /yalnizca sende gorunur/);
  });

  it("posts the full personal list as ephemeral AND a lasting DM", async () => {
    const poll = pollService.createPoll({
      channelId: CHANNEL,
      creatorId: "U_ERDEM",
      creatorSlackIds: ["U_ERDEM"],
      title: "Flowmaze",
      suggestionHours: 48,
    });
    addGame(poll.id, AYSE, "Color Maze");
    addGame(poll.id, AYSE, "Maze Dash");
    addGame(poll.id, MEHMET, "Amaze Dash");

    const client = mockSlackClient();
    const delivered = await deliverUserSuggestionReceipt({
      client,
      poll,
      userId: AYSE.id,
      channelId: CHANNEL,
    });
    assert.equal(delivered.ephemeral, true);
    assert.equal(delivered.dm, true);

    const ephemeral = client.posts.find((p) => p.type === "ephemeral");
    assert.equal(ephemeral.channel, CHANNEL);
    assert.equal(ephemeral.user, AYSE.id);
    const eblob = JSON.stringify(ephemeral);
    assert.ok(eblob.includes("Color Maze"));
    assert.ok(eblob.includes("Maze Dash"));
    assert.ok(!eblob.includes("Amaze Dash"));

    const dm = client.posts.find((p) => p.type === "message" && p.channel === `D_${AYSE.id}`);
    assert.ok(dm, "persistent DM missing");
    assert.ok(JSON.stringify(dm).includes("Color Maze"));
    assert.ok(!JSON.stringify(dm).includes("Amaze Dash"));
  });

  it("announcement includes Onerilerini gor so a vanished ephemeral can be reopened", () => {
    const poll = pollService.createPoll({
      channelId: CHANNEL,
      creatorId: "U_ERDEM",
      creatorSlackIds: ["U_ERDEM"],
      title: "Flowmaze",
      suggestionHours: 48,
    });
    const blocks = suggestionAnnouncementBlocks(poll);
    const hasButton = blocks.some((b) =>
      (b.elements || []).some((el) => el.action_id === "show_my_suggestions")
    );
    assert.ok(hasButton, "Onerilerini gor button missing");
  });
});
