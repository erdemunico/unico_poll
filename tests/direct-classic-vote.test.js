"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { describe, it, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unico-poll-direct-"));
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
const { parseSkipChannelSuggestions } = require("../src/utils/parser");
const { votingBlocks } = require("../src/slack/blocks");
const { registerActions, finalizeStartVotingFromWizard } = require("../src/slack/actions");

const CHANNEL = "C_FLOWMAZE";
const CREATOR = "U_ERDEM";

const USERS = [
  { id: "U_AYSE", name: "Ayse Kaya" },
  { id: "U_MEHMET", name: "Mehmet Demir" },
  { id: "U_ELIF", name: "Elif Yilmaz" },
  { id: "U_CAN", name: "Can Ozturk" },
  { id: "U_ZEYNEP", name: "Zeynep Arslan" },
  { id: "U_BURAK", name: "Burak Cetin" },
  { id: "U_DENIZ", name: "Deniz Aydin" },
  { id: "U_MELIS", name: "Melis Korkmaz" },
  { id: "U_KEREM", name: "Kerem Sahin" },
  { id: "U_SELIN", name: "Selin Acar" },
];

const GAMES = [
  "Color Maze",
  "Maze Dash",
  "Amaze Dash",
  "Puzzle Box",
  "Tower Defense Mini",
  "Hex Island",
  "Night Courier",
  "Sky Garden",
  "Quiet Harbor",
  "Brick & Brew",
];

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

function mockSlackClient() {
  const posts = [];
  let tsSeq = 1;
  return {
    posts,
    conversations: {
      open: async ({ users }) => ({ ok: true, channel: { id: `D_${users}` } }),
    },
    views: {
      open: async (payload) => {
        posts.push({ type: "view_open", ...payload });
        return { ok: true };
      },
    },
    chat: {
      postMessage: async (payload) => {
        const ts = `1700000000.${String(tsSeq).padStart(6, "0")}`;
        tsSeq += 1;
        const rec = { type: "message", ts, channel: payload.channel, ...payload };
        posts.push(rec);
        return { ok: true, ts, channel: payload.channel };
      },
      postEphemeral: async (payload) => {
        posts.push({ type: "ephemeral", ...payload });
        return { ok: true };
      },
    },
  };
}

function createMockBolt(client) {
  const actions = [];
  const views = [];
  return {
    client,
    action(match, handler) {
      actions.push({ match, handler });
    },
    view(id, handler) {
      views.push({ id, handler });
    },
    async invokeAction(actionId, { body, client: c }) {
      const hit = actions.find(({ match }) => {
        if (typeof match === "string") {
          return match === actionId;
        }
        if (match instanceof RegExp) {
          return match.test(actionId);
        }
        return false;
      });
      assert.ok(hit, `no action handler for ${actionId}`);
      let acked = false;
      await hit.handler({
        ack: async () => {
          acked = true;
        },
        body,
        client: c,
      });
      assert.equal(acked, true, `${actionId} did not ack`);
    },
    async invokeView(callbackId, { body, view, client: c }) {
      const hit = views.find((v) => v.id === callbackId);
      assert.ok(hit, `no view handler for ${callbackId}`);
      const acks = [];
      await hit.handler({
        ack: async (payload) => {
          acks.push(payload || { ok: true });
        },
        body,
        view,
        client: c,
      });
      return acks[0];
    },
  };
}

function collectSectionTexts(blocks) {
  return (blocks || [])
    .filter((b) => b.type === "section" && b.text?.text)
    .map((b) => b.text.text)
    .join("\n");
}

function classicVoteButtons(blocks) {
  return (blocks || [])
    .filter((b) => b.type === "actions")
    .flatMap((b) => b.elements || [])
    .filter((el) => String(el.action_id || "").startsWith("classic_vote__"));
}

async function startDirectClassic({ privacy, client }) {
  const poll = pollService.createPoll({
    channelId: CHANNEL,
    creatorId: CREATOR,
    creatorSlackIds: [CREATOR],
    title: privacy === "open" ? "Direkt Klasik Acik" : "Direkt Klasik Kapali",
    skipSuggestionCollect: true,
  });
  assert.equal(poll.phase, "ballot_setup");

  await finalizeStartVotingFromWizard({
    client,
    body: { user: { id: CREATOR } },
    wizard: {
      pollId: poll.id,
      channelId: CHANNEL,
      flow: "direct",
      voteMode: "classic",
      privacy,
      lines: GAMES,
    },
    hours: 48,
    actingIds: [CREATOR],
  });

  const live = pollService.getPollById(poll.id);
  assert.equal(live.phase, "voting");
  assert.equal(live.vote_mode, "classic");
  return live;
}

async function castClassicViaButton(app, client, { pollId, userId, suggestionId }) {
  const actionId = `classic_vote__${pollId}__${suggestionId}`;
  await app.invokeAction(actionId, {
    client,
    body: {
      user: { id: userId },
      channel: { id: CHANNEL },
      actions: [
        {
          action_id: actionId,
          value: JSON.stringify({ pollId, suggestionId }),
        },
      ],
    },
  });
}

describe("direkt klasik acik / kapali — 10 named users vote", () => {
  let client;
  let app;

  beforeEach(() => {
    resetStore();
    client = mockSlackClient();
    app = createMockBolt(client);
    registerActions(app);
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses | direkt as a ballot without channel suggestions", () => {
    assert.equal(parseSkipChannelSuggestions("direkt"), true);
    assert.equal(parseSkipChannelSuggestions("48h direkt"), true);
    assert.equal(parseSkipChannelSuggestions("48h"), false);
  });

  it("kapali: 10 users each cast a classic vote; ballots lock; no public vote notices", async () => {
    const poll = await startDirectClassic({ privacy: "closed", client });
    assert.equal(pollService.isOpenVotePoll(poll), false);

    const shortlist = pollService.getShortlistedSuggestions(poll.id);
    assert.equal(shortlist.length, 10);
    assert.deepEqual(
      shortlist.map((s) => s.display_name),
      GAMES
    );

    const announce = client.posts.find((p) => p.type === "message" && p.channel === CHANNEL);
    assert.ok(announce, "voting announcement missing");
    assert.match(collectSectionTexts(announce.blocks), /Oy gorunurlugu: \*kapali\*/);
    const buttons = classicVoteButtons(announce.blocks);
    assert.equal(buttons.length, 10, "all 10 options must be vote buttons");

    const publicBeforeVotes = client.posts.filter((p) => p.type === "message").length;

    for (let i = 0; i < USERS.length; i += 1) {
      await castClassicViaButton(app, client, {
        pollId: poll.id,
        userId: USERS[i].id,
        suggestionId: shortlist[i].id,
      });
    }

    for (const user of USERS) {
      assert.equal(pollService.hasUserClassicVoteForPoll(poll.id, user.id), true, `${user.name} did not vote`);
    }

    const results = pollService.buildResults(poll.id);
    assert.equal(results.results.length, 10);
    for (const row of results.results) {
      assert.equal(row.score, 1, `${row.display_name} should have exactly 1 vote`);
    }

    const dup = pollService.castClassicVote({
      pollId: poll.id,
      userId: USERS[0].id,
      suggestionId: shortlist[1].id,
    });
    assert.equal(dup.ok, false);
    assert.match(dup.reason, /degistirilemez/);
    assert.equal(dup.openVote, false);

    await castClassicViaButton(app, client, {
      pollId: poll.id,
      userId: USERS[0].id,
      suggestionId: shortlist[0].id,
    });
    const ayseEphemeral = client.posts.filter(
      (p) => p.type === "ephemeral" && p.user === USERS[0].id
    );
    assert.ok(ayseEphemeral.some((p) => /kaydedildi|zaten kayitli/.test(p.text)));

    const publicAfter = client.posts.filter((p) => p.type === "message");
    assert.equal(
      publicAfter.length,
      publicBeforeVotes,
      "kapali oy must not post channel 'oy kullandi' notices"
    );
    assert.ok(!publicAfter.some((p) => String(p.text || "").includes("oy kullandi")));

    USERS.forEach((user, idx) => {
      const lines = pollService.getUserVoteSummaryLines({
        pollId: poll.id,
        actingUserIds: [user.id],
      });
      assert.ok(lines[0].includes(shortlist[idx].display_name), `${user.name} summary mismatch`);
    });
  });

  it("acik: 10 users vote via buttons and each vote is announced in the channel", async () => {
    const poll = await startDirectClassic({ privacy: "open", client });
    assert.equal(pollService.isOpenVotePoll(poll), true);
    assert.equal(Number(poll.is_open_vote), 1);

    const shortlist = pollService.getShortlistedSuggestions(poll.id);
    const announce = client.posts.find((p) => p.type === "message" && p.channel === CHANNEL);
    assert.match(collectSectionTexts(announce.blocks), /Oy gorunurlugu: \*acik\*/);

    for (let i = 0; i < USERS.length; i += 1) {
      await castClassicViaButton(app, client, {
        pollId: poll.id,
        userId: USERS[i].id,
        suggestionId: shortlist[i].id,
      });
    }

    const notices = client.posts.filter(
      (p) => p.type === "message" && String(p.text || "").includes("oy kullandi")
    );
    assert.equal(notices.length, 10, "every open vote must post a channel notice");
    for (let i = 0; i < USERS.length; i += 1) {
      const blob = JSON.stringify(notices[i]);
      assert.ok(blob.includes(`<@${USERS[i].id}>`), `missing mention for ${USERS[i].name}`);
      assert.ok(blob.includes(GAMES[i]), `missing game ${GAMES[i]} in open-vote notice`);
    }

    const vote = pollService.castClassicVote({
      pollId: poll.id,
      userId: USERS[3].id,
      suggestionId: shortlist[3].id,
    });
    assert.equal(vote.ok, true);
    assert.equal(vote.recorded, false);
    assert.equal(vote.openVote, true);

    const results = pollService.buildResults(poll.id);
    assert.equal(results.results.filter((r) => r.score === 1).length, 10);
  });

  it("acik: classic vote modal submit also records the ballot and posts a notice", async () => {
    const poll = await startDirectClassic({ privacy: "open", client });
    const shortlist = pollService.getShortlistedSuggestions(poll.id);
    const voter = USERS[4];
    const choice = shortlist[7];

    await app.invokeView("classic_vote_submit", {
      client,
      body: { user: { id: voter.id } },
      view: {
        private_metadata: JSON.stringify({ pollId: poll.id, channelId: CHANNEL }),
        state: {
          values: {
            classic_vote_choice: {
              classic_vote_select: { selected_option: { value: choice.id } },
            },
          },
        },
      },
    });

    assert.equal(pollService.hasUserClassicVoteForPoll(poll.id, voter.id), true);
    const lines = pollService.getUserVoteSummaryLines({
      pollId: poll.id,
      actingUserIds: [voter.id],
    });
    assert.ok(lines[0].includes(choice.display_name));
    assert.ok(
      client.posts.some(
        (p) =>
          p.type === "message" &&
          String(p.text || "").includes("oy kullandi") &&
          JSON.stringify(p).includes(`<@${voter.id}>`)
      )
    );
  });

  it("wizard privacy closed cannot be turned into open vote by rating mode", async () => {
    const poll = pollService.createPoll({
      channelId: CHANNEL,
      creatorId: CREATOR,
      creatorSlackIds: [CREATOR],
      title: "Direkt Puanlama",
      skipSuggestionCollect: true,
    });
    await finalizeStartVotingFromWizard({
      client,
      body: { user: { id: CREATOR } },
      wizard: {
        pollId: poll.id,
        channelId: CHANNEL,
        flow: "direct",
        voteMode: "rating",
        privacy: "open",
        lines: GAMES.slice(0, 4),
      },
      hours: 24,
      actingIds: [CREATOR],
    });
    const live = pollService.getPollById(poll.id);
    assert.equal(live.vote_mode, "rating");
    assert.equal(pollService.isOpenVotePoll(live), false);
    const announce = client.posts.find((p) => p.type === "message" && p.channel === CHANNEL);
    assert.match(collectSectionTexts(announce.blocks), /puanlama modunda acik oy yok/);
  });

  it("channel voting message exposes every named option as a button", () => {
    const poll = pollService.createPoll({
      channelId: CHANNEL,
      creatorId: CREATOR,
      creatorSlackIds: [CREATOR],
      title: "Butonlar",
      skipSuggestionCollect: true,
    });
    pollService.replacePollSuggestionsFromLines({
      pollId: poll.id,
      actingSlackUserIds: [CREATOR],
      lines: GAMES,
    });
    const sugg = pollService.listSuggestions(poll.id);
    pollService.saveShortlist({ pollId: poll.id, suggestionIds: sugg.map((s) => s.id) });
    pollService.startVoting({
      pollId: poll.id,
      voteMode: "classic",
      isOpenVote: false,
      votingHours: 48,
    });
    const blocks = votingBlocks({
      poll: pollService.getPollById(poll.id),
      suggestions: pollService.getShortlistedSuggestions(poll.id),
    });
    const labels = classicVoteButtons(blocks).map((b) => b.text.text);
    assert.deepEqual(labels, GAMES);
  });
});
