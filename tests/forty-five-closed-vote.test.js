"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { describe, it, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unico-poll-45-"));
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
const {
  votingBlocks,
  creatorResultsBlocks,
  channelResultsBlocks,
} = require("../src/slack/blocks");
const { registerActions, finalizeStartVotingFromWizard } = require("../src/slack/actions");

const CHANNEL = "C_FLOWMAZE";
const CREATOR = "U_ERDEM";

const FIRST = [
  "Ayse", "Mehmet", "Elif", "Can", "Zeynep", "Burak", "Deniz", "Melis", "Kerem", "Selin",
  "Emre", "Ceren", "Onur", "Derya", "Baris", "Pinar", "Tolga", "Gizem", "Okan", "Nazli",
  "Hakan", "Seda", "Volkan", "Ebru", "Serkan", "Merve", "Umut", "Aylin", "Kaan", "Buse",
  "Yigit", "Damla", "Oguz", "Tuba", "Levent", "Sibel", "Arda", "Hande", "Cem", "Fulya",
  "Tamer", "Nihan", "Alp", "Esra", "Koray",
];
const LAST = [
  "Kaya", "Demir", "Yilmaz", "Ozturk", "Arslan", "Cetin", "Aydin", "Korkmaz", "Sahin", "Acar",
  "Yildiz", "Kilic", "Celik", "Aslan", "Dogan", "Koç", "Polat", "Erdem", "Gunes", "Aksoy",
  "Tas", "Ucar", "Ozkan", "Erdogan", "Karaca", "Sen", "Aydemir", "Kurt", "Guler", "Yavuz",
  "Tekin", "Ozdemir", "Avci", "Bozkurt", "Ince", "Kaplan", "Eren", "Sari", "Unal", "Mutlu",
  "Kocak", "Bayram", "Cakir", "Ipek", "Soylu",
];

const USERS = FIRST.map((first, i) => ({
  id: `U_${String(i + 1).padStart(2, "0")}_${first.toUpperCase()}`,
  name: `${first} ${LAST[i]}`,
}));

const GAMES = [
  "Color Maze",
  "Maze Dash",
  "Amaze Dash",
  "Puzzle Box",
  "Hex Island",
  "Night Courier",
  "Sky Garden",
];

assert.equal(USERS.length, 45);
assert.equal(GAMES.length, 7);

/** Seeded shuffle so the mix is mixed but the test is repeatable. */
function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffledVoteBag(optionCount, voterCount, seed) {
  const counts = [];
  let remaining = voterCount;
  for (let i = 0; i < optionCount; i += 1) {
    const leftSlots = optionCount - i;
    const base = Math.floor(remaining / leftSlots);
    counts.push(base);
    remaining -= base;
  }
  const bag = [];
  counts.forEach((n, idx) => {
    for (let k = 0; k < n; k += 1) {
      bag.push(idx);
    }
  });
  const rand = mulberry32(seed);
  for (let i = bag.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  return bag;
}

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
        posts.push({ type: "message", ts, channel: payload.channel, ...payload });
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
  return {
    client,
    action(match, handler) {
      actions.push({ match, handler });
    },
    view() {},
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
      await hit.handler({ ack: async () => {}, body, client: c });
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

describe("45 named voters — classic kapali / gizli, 7 options", () => {
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

  it("records 45 mixed closed ballots without Slack-limit or privacy leaks", async () => {
    const poll = pollService.createPoll({
      channelId: CHANNEL,
      creatorId: CREATOR,
      creatorSlackIds: [CREATOR],
      title: "Flowmaze 45",
      skipSuggestionCollect: true,
    });

    await finalizeStartVotingFromWizard({
      client,
      body: { user: { id: CREATOR } },
      wizard: {
        pollId: poll.id,
        channelId: CHANNEL,
        flow: "direct",
        voteMode: "classic",
        privacy: "closed",
        lines: GAMES,
      },
      hours: 48,
      actingIds: [CREATOR],
    });

    const live = pollService.getPollById(poll.id);
    assert.equal(live.phase, "voting");
    assert.equal(live.vote_mode, "classic");
    assert.equal(pollService.isOpenVotePoll(live), false);

    const shortlist = pollService.getShortlistedSuggestions(poll.id);
    assert.equal(shortlist.length, 7);

    const announce = client.posts.find((p) => p.type === "message" && p.channel === CHANNEL);
    assert.ok(announce);
    const blocks = announce.blocks;
    assert.ok(blocks.length <= 50, `too many Slack blocks: ${blocks.length}`);
    const actionBlocks = blocks.filter((b) => b.type === "actions" && classicVoteButtons([b]).length);
    assert.equal(actionBlocks.length, 2, "7 options must split into 5 + 2 button rows");
    assert.equal(actionBlocks[0].elements.length, 5);
    assert.equal(actionBlocks[1].elements.length, 2);
    for (const row of actionBlocks) {
      assert.ok(row.elements.length <= 5);
    }
    const labels = classicVoteButtons(blocks).map((b) => b.text.text);
    assert.deepEqual(labels, GAMES);
    assert.match(collectSectionTexts(blocks), /Oy gorunurlugu: \*kapali\*/);

    const assignment = shuffledVoteBag(7, 45, 20260814);
    const expectedCounts = Array(7).fill(0);
    assignment.forEach((idx) => {
      expectedCounts[idx] += 1;
    });
    assert.equal(expectedCounts.reduce((a, b) => a + b, 0), 45);
    assert.ok(expectedCounts.every((n) => n >= 6 && n <= 7), `unbalanced bag: ${expectedCounts}`);

    const publicBefore = client.posts.filter((p) => p.type === "message").length;

    for (let i = 0; i < USERS.length; i += 1) {
      const suggestionId = shortlist[assignment[i]].id;
      const actionId = `classic_vote__${poll.id}__${suggestionId}`;
      await app.invokeAction(actionId, {
        client,
        body: {
          user: { id: USERS[i].id },
          channel: { id: CHANNEL },
          actions: [{ action_id: actionId, value: JSON.stringify({ pollId: poll.id, suggestionId }) }],
        },
      });
    }

    for (const user of USERS) {
      assert.equal(pollService.hasUserClassicVoteForPoll(poll.id, user.id), true, `${user.name} missing vote`);
    }

    const dup = pollService.castClassicVote({
      pollId: poll.id,
      userId: USERS[12].id,
      suggestionId: shortlist[(assignment[12] + 1) % 7].id,
    });
    assert.equal(dup.ok, false);
    assert.match(dup.reason, /degistirilemez/);
    assert.equal(dup.openVote, false);

    const results = pollService.buildResults(poll.id);
    assert.equal(results.results.length, 7);
    const total = results.results.reduce((sum, row) => sum + Number(row.score), 0);
    assert.equal(total, 45);
    for (const game of GAMES) {
      const row = results.results.find((r) => r.display_name === game);
      assert.ok(row, `missing tally for ${game}`);
      const idx = GAMES.indexOf(game);
      assert.equal(row.score, expectedCounts[idx], `${game} expected ${expectedCounts[idx]} got ${row.score}`);
    }

    const publicAfter = client.posts.filter((p) => p.type === "message");
    assert.equal(publicAfter.length, publicBefore, "kapali oy must not spam the channel");
    assert.ok(!publicAfter.some((p) => String(p.text || "").includes("oy kullandi")));

    const blob = JSON.stringify(client.posts);
    for (const user of USERS) {
      assert.ok(!blob.includes(user.name), `voter name leaked in Slack posts: ${user.name}`);
    }

    const sample = [0, 7, 21, 44];
    for (const i of sample) {
      const lines = pollService.getUserVoteSummaryLines({
        pollId: poll.id,
        actingUserIds: [USERS[i].id],
      });
      const picked = GAMES[assignment[i]];
      assert.ok(lines[0].includes(picked), `${USERS[i].name} summary mismatch`);
      for (const game of GAMES) {
        if (game === picked) {
          continue;
        }
        assert.ok(!lines.join("\n").includes(game), `${USERS[i].name} summary leaked ${game}`);
      }
    }

    await app.invokeAction("show_my_votes", {
      client,
      body: {
        user: { id: USERS[0].id },
        channel: { id: CHANNEL },
        actions: [{ action_id: "show_my_votes", value: poll.id }],
      },
    });
    const mine = client.posts.filter((p) => p.type === "ephemeral" && p.user === USERS[0].id);
    const mineText = JSON.stringify(mine);
    assert.ok(mineText.includes(GAMES[assignment[0]]));
    for (let j = 1; j < USERS.length; j += 1) {
      assert.ok(!mineText.includes(USERS[j].id), "show_my_votes leaked another user id");
    }

    const creatorBlocks = creatorResultsBlocks({ poll: live, results: results.results, close: false });
    const channelBlocks = channelResultsBlocks({ poll: live, results: results.results });
    for (const pack of [creatorBlocks, channelBlocks]) {
      assert.ok(pack.length <= 50);
      for (const block of pack) {
        if (block.type === "section" && block.text?.text) {
          assert.ok(block.text.text.length <= 3000, "Slack section over 3000 chars");
        }
      }
    }
    const published = collectSectionTexts(channelBlocks);
    assert.ok(!published.includes("U_"));
    for (const game of GAMES) {
      assert.ok(published.includes(game));
    }

    const raw = fs.readFileSync(storeFile(), "utf8");
    assert.ok(raw.length < 200_000, `store unexpectedly large: ${raw.length}`);
    const parsed = JSON.parse(raw);
    assert.equal(parsed.votes_classic.length, 45);
  });
});
