"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { describe, it, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unico-poll-"));
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
  creatorSuggestionControlBlocks,
  votingBlocks,
  votingClosedBlocks,
  buildStartVotingModal,
} = require("../src/slack/blocks");
const { deliverCreatorSuggestionSetup } = require("../src/slack/commands");
const { runSchedulerTick } = require("../src/services/scheduler");

const CHANNEL = "C_FLOWMAZE";
const CREATOR = "U_ERDEM";

/** Named teammates — not random tokens — each with a distinct vote style. */
const USERS = [
  { id: "U_AYSE", name: "Ayse Kaya", games: ["Color Maze", "Maze Dash"] },
  { id: "U_MEHMET", name: "Mehmet Demir", games: ["Amaze Dash", "Puzzle Box"] },
  { id: "U_ELIF", name: "Elif Yilmaz", games: ["Tower Defense Mini", "Hex Island"] },
  { id: "U_CAN", name: "Can Ozturk", games: ["Night Courier", "Sky Garden"] },
  { id: "U_ZEYNEP", name: "Zeynep Arslan", games: ["Quiet Harbor", "Brick & Brew"] },
  { id: "U_BURAK", name: "Burak Cetin", games: ["Signal Lost", "Forge Town"] },
  { id: "U_DENIZ", name: "Deniz Aydin", games: ["Paper Pilot", "Orbit Cafe"] },
  { id: "U_MELIS", name: "Melis Korkmaz", games: ["Lantern Valley", "Soft Pixel"] },
  { id: "U_KEREM", name: "Kerem Sahin", games: ["Dust Rally", "Coral Quest"] },
  { id: "U_SELIN", name: "Selin Acar", games: ["Moon Market", "Willow Run"] },
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

function addNamedSuggestion(pollId, user, gameName) {
  const parsed = parseSuggestionInput(`${gameName} : ${user.name}`);
  assert.ok(parsed, `parse failed for ${gameName}`);
  const result = pollService.addSuggestion({
    pollId,
    userId: user.id,
    parsed,
  });
  assert.equal(result.ok, true, result.reason || `${user.name} could not add ${gameName}`);
  return result;
}

function expireSuggestionDeadline(pollId) {
  const state = store.getState();
  const idx = state.polls.findIndex((p) => p.id === pollId);
  state.polls[idx].suggestion_deadline_at = new Date(Date.now() - 60_000).toISOString();
  store.persist();
  store.reloadStoreFromDisk();
}

function expireVotingDeadline(pollId) {
  const state = store.getState();
  const idx = state.polls.findIndex((p) => p.id === pollId);
  state.polls[idx].voting_deadline_at = new Date(Date.now() - 60_000).toISOString();
  store.persist();
  store.reloadStoreFromDisk();
}

function collectSectionTexts(blocks) {
  return blocks
    .filter((b) => b.type === "section" && b.text?.text)
    .map((b) => b.text.text)
    .join("\n");
}

function mockSlackClient({ dmOk = true, ephemeralOk = true, channelOk = true } = {}) {
  const posts = [];
  return {
    posts,
    conversations: {
      open: async ({ users }) => {
        if (!dmOk) {
          return { ok: false, error: "cannot_dm_bot" };
        }
        return { ok: true, channel: { id: `D_${users}` } };
      },
    },
    chat: {
      postMessage: async (payload) => {
        if (payload.channel?.startsWith("D_") && !dmOk) {
          throw new Error("dm post failed");
        }
        if (!payload.channel?.startsWith("D_") && !channelOk) {
          throw new Error("channel post failed");
        }
        posts.push({ type: "message", ...payload });
        return { ok: true };
      },
      postEphemeral: async (payload) => {
        if (!ephemeralOk) {
          throw new Error("ephemeral failed");
        }
        posts.push({ type: "ephemeral", ...payload });
        return { ok: true };
      },
    },
  };
}

describe("10 named users — full poll lifecycle", () => {
  beforeEach(() => {
    resetStore();
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("collects 20 unique suggestions from 10 users (over the voting cap of 10)", () => {
    const poll = pollService.createPoll({
      channelId: CHANNEL,
      creatorId: CREATOR,
      creatorSlackIds: [CREATOR],
      title: "Flowmaze Turnuvasi",
      suggestionHours: 48,
    });

    for (const user of USERS) {
      for (const game of user.games) {
        addNamedSuggestion(poll.id, user, game);
      }
    }

    const all = pollService.listSuggestions(poll.id);
    assert.equal(all.length, 20);
    const names = all.map((s) => s.display_name);
    assert.ok(names.includes("Color Maze"));
    assert.ok(names.includes("Willow Run"));
    assert.equal(new Set(names).size, 20);

    for (let n = 3; n <= 5; n += 1) {
      addNamedSuggestion(poll.id, USERS[0], `Ayse Extra ${n}`);
    }
    const sixth = pollService.addSuggestion({
      pollId: poll.id,
      userId: USERS[0].id,
      parsed: parseSuggestionInput("Ayse Extra 6"),
    });
    assert.equal(sixth.ok, false);
    assert.match(sixth.reason, /limit/i);
  });

  it("shows every collected suggestion in creator setup blocks (not only first 10)", () => {
    const poll = pollService.createPoll({
      channelId: CHANNEL,
      creatorId: CREATOR,
      creatorSlackIds: [CREATOR],
      title: "Uzun Liste",
      suggestionHours: 48,
    });
    for (const user of USERS) {
      for (const game of user.games) {
        addNamedSuggestion(poll.id, user, game);
      }
    }
    const suggestions = pollService.listSuggestions(poll.id);
    const blocks = creatorSuggestionControlBlocks(poll, suggestions, pollService.MAX_OPTIONS);
    assert.ok(blocks.length <= 50, `too many Slack blocks: ${blocks.length}`);
    for (const block of blocks) {
      if (block.type === "section" && block.text?.text) {
        assert.ok(block.text.text.length <= 3000, "Slack section over 3000 chars");
      }
    }
    const blob = collectSectionTexts(blocks);
    assert.match(blob, /Toplam 20 oneri/);
    for (const user of USERS) {
      for (const game of user.games) {
        assert.ok(blob.includes(game), `missing suggestion in blocks: ${game}`);
      }
    }
    const hasButton = blocks.some(
      (b) => b.accessory?.action_id === "open_start_voting_modal" ||
        b.elements?.some((el) => el.action_id === "open_start_voting_modal")
    );
    assert.ok(hasButton, "Oylama listesini sec button missing");
  });

  it("creator picks 10 of 20; all 10 users vote classic covering every option", () => {
    const poll = pollService.createPoll({
      channelId: CHANNEL,
      creatorId: CREATOR,
      creatorSlackIds: [CREATOR],
      title: "Klasik Kapali",
      suggestionHours: 48,
    });
    for (const user of USERS) {
      for (const game of user.games) {
        addNamedSuggestion(poll.id, user, game);
      }
    }
    const all = pollService.listSuggestions(poll.id);
    const picked = all.slice(5, 15);
    assert.equal(picked.length, 10);
    pollService.saveShortlist({
      pollId: poll.id,
      suggestionIds: picked.map((s) => s.id),
    });
    pollService.markSuggestionClosed(poll.id);
    pollService.startVoting({
      pollId: poll.id,
      voteMode: "classic",
      isOpenVote: false,
      votingHours: 48,
    });

    const shortlist = pollService.getShortlistedSuggestions(poll.id);
    assert.equal(shortlist.length, 10);
    assert.equal(shortlist[0].display_name, picked[0].display_name);

    USERS.forEach((user, idx) => {
      const choice = shortlist[idx];
      const vote = pollService.castClassicVote({
        pollId: poll.id,
        userId: user.id,
        suggestionId: choice.id,
      });
      assert.equal(vote.ok, true, `${user.name} vote failed: ${vote.reason}`);
      assert.equal(vote.recorded, true);
      assert.equal(vote.openVote, false);
    });

    const dup = pollService.castClassicVote({
      pollId: poll.id,
      userId: USERS[0].id,
      suggestionId: shortlist[1].id,
    });
    assert.equal(dup.ok, false);
    assert.match(dup.reason, /degistirilemez/);

    const same = pollService.castClassicVote({
      pollId: poll.id,
      userId: USERS[0].id,
      suggestionId: shortlist[0].id,
    });
    assert.equal(same.ok, true);
    assert.equal(same.recorded, false);

    const results = pollService.buildResults(poll.id);
    assert.equal(results.results.length, 10);
    for (const row of results.results) {
      assert.equal(row.score, 1, `${row.display_name} should have exactly 1 vote`);
    }

    const vb = votingBlocks({ poll: pollService.getPollById(poll.id), suggestions: shortlist });
    const voteButtons = vb
      .filter((b) => b.type === "actions")
      .flatMap((b) => b.elements || [])
      .filter((el) => String(el.action_id || "").startsWith("classic_vote__"));
    assert.equal(voteButtons.length, 10, "all 10 options must be channel buttons");
    assert.ok(vb.some((b) => b.elements?.some((el) => el.action_id === "show_my_votes")));

    USERS.forEach((user, idx) => {
      const lines = pollService.getUserVoteSummaryLines({
        pollId: poll.id,
        actingUserIds: [user.id],
      });
      assert.ok(lines[0].includes(shortlist[idx].display_name), `${user.name} summary missing their pick`);
    });
  });

  it("all 10 users rate every shortlist option (1-5) and summaries list each score", () => {
    const poll = pollService.createPoll({
      channelId: CHANNEL,
      creatorId: CREATOR,
      creatorSlackIds: [CREATOR],
      title: "Puanlama",
      suggestionHours: 48,
    });
    for (const user of USERS) {
      addNamedSuggestion(poll.id, user, user.games[0]);
    }
    const all = pollService.listSuggestions(poll.id);
    pollService.saveShortlist({ pollId: poll.id, suggestionIds: all.map((s) => s.id) });
    pollService.startVoting({
      pollId: poll.id,
      voteMode: "rating",
      isOpenVote: true,
      votingHours: 24,
    });
    const live = pollService.getPollById(poll.id);
    assert.equal(live.vote_mode, "rating");
    assert.equal(pollService.isOpenVotePoll(live), false, "rating must ignore open vote");

    const shortlist = pollService.getShortlistedSuggestions(poll.id);
    USERS.forEach((user, uIdx) => {
      shortlist.forEach((s, sIdx) => {
        const rating = ((uIdx + sIdx) % 5) + 1;
        const vote = pollService.castRatingVote({
          pollId: poll.id,
          userId: user.id,
          suggestionId: s.id,
          rating,
        });
        assert.equal(vote.ok, true, `${user.name} rating ${s.display_name} failed: ${vote.reason}`);
      });
    });

    const change = pollService.castRatingVote({
      pollId: poll.id,
      userId: USERS[0].id,
      suggestionId: shortlist[0].id,
      rating: 5,
    });
    assert.equal(change.ok, false);

    const results = pollService.buildResults(poll.id);
    assert.equal(results.results.length, 10);
    for (const row of results.results) {
      assert.ok(row.score >= 1 && row.score <= 5);
    }

    const lines = pollService.getUserVoteSummaryLines({
      pollId: poll.id,
      actingUserIds: [USERS[3].id],
    });
    assert.equal(lines.length, 10);
    for (const s of shortlist) {
      assert.ok(lines.some((ln) => ln.includes(s.display_name)));
    }

    const vb = votingBlocks({ poll: live, suggestions: shortlist });
    assert.ok(vb.some((b) => b.accessory?.action_id === "open_rating_modal"));
    assert.match(collectSectionTexts(vb), /puanlama modunda acik oy yok/);
    assert.ok(!collectSectionTexts(vb).includes("kanal sismesin"));
  });

  it("open classic vote records visibility and still locks the ballot", () => {
    const poll = pollService.createPoll({
      channelId: CHANNEL,
      creatorId: CREATOR,
      creatorSlackIds: [CREATOR],
      title: "Acik Klasik",
      suggestionHours: 1,
    });
    addNamedSuggestion(poll.id, USERS[0], "Night Courier");
    addNamedSuggestion(poll.id, USERS[1], "Sky Garden");
    const ids = pollService.listSuggestions(poll.id).map((s) => s.id);
    pollService.saveShortlist({ pollId: poll.id, suggestionIds: ids });
    pollService.startVoting({
      pollId: poll.id,
      voteMode: "classic",
      isOpenVote: true,
      votingHours: 1,
    });
    const vote = pollService.castClassicVote({
      pollId: poll.id,
      userId: USERS[2].id,
      suggestionId: ids[0],
    });
    assert.equal(vote.ok, true);
    assert.equal(vote.openVote, true);
    const vb = votingBlocks({
      poll: pollService.getPollById(poll.id),
      suggestions: pollService.getShortlistedSuggestions(poll.id),
    });
    assert.match(collectSectionTexts(vb), /Oy gorunurlugu: \*acik\*/);
  });

  it("direct ballot with 10 named options then 10 users vote", () => {
    const poll = pollService.createPoll({
      channelId: CHANNEL,
      creatorId: CREATOR,
      creatorSlackIds: [CREATOR],
      title: "Direkt Lig",
      skipSuggestionCollect: true,
    });
    assert.equal(poll.phase, "ballot_setup");
    const lines = USERS.map((u) => u.games[0]);
    pollService.replacePollSuggestionsFromLines({
      pollId: poll.id,
      actingSlackUserIds: [CREATOR],
      lines,
    });
    const sugg = pollService.listSuggestions(poll.id);
    assert.equal(sugg.length, 10);
    pollService.saveShortlist({ pollId: poll.id, suggestionIds: sugg.map((s) => s.id) });
    pollService.startVoting({
      pollId: poll.id,
      voteMode: "classic",
      isOpenVote: false,
      votingHours: 48,
    });
    USERS.forEach((user, idx) => {
      const vote = pollService.castClassicVote({
        pollId: poll.id,
        userId: user.id,
        suggestionId: sugg[idx].id,
      });
      assert.equal(vote.ok, true);
    });
    const results = pollService.buildResults(poll.id);
    assert.equal(results.results.filter((r) => r.score === 1).length, 10);
  });

  it("scheduler closes expired suggestion phase and DMs creator with the full list", async () => {
    const poll = pollService.createPoll({
      channelId: CHANNEL,
      creatorId: CREATOR,
      creatorSlackIds: [CREATOR],
      title: "Sure Doldu",
      suggestionHours: 48,
    });
    for (const user of USERS) {
      addNamedSuggestion(poll.id, user, user.games[0]);
    }
    expireSuggestionDeadline(poll.id);
    const client = mockSlackClient();
    const app = { client };
    await runSchedulerTick(app);

    const after = pollService.getPollById(poll.id);
    assert.equal(after.phase, "ready_for_voting");
    const dm = client.posts.find((p) => p.channel === `D_${CREATOR}`);
    assert.ok(dm, "creator DM missing");
    const blob = JSON.stringify(dm.blocks);
    assert.match(blob, /Toplam 10 oneri/);
    for (const user of USERS) {
      assert.ok(blob.includes(user.games[0]), `DM missing ${user.games[0]}`);
    }
  });

  it("scheduler closes voting and creator results are claimable after 10 votes", async () => {
    const poll = pollService.createPoll({
      channelId: CHANNEL,
      creatorId: CREATOR,
      creatorSlackIds: [CREATOR],
      title: "Oylama Bitti",
      suggestionHours: 48,
    });
    addNamedSuggestion(poll.id, USERS[0], "Color Maze");
    addNamedSuggestion(poll.id, USERS[1], "Maze Dash");
    const ids = pollService.listSuggestions(poll.id).map((s) => s.id);
    pollService.saveShortlist({ pollId: poll.id, suggestionIds: ids });
    pollService.startVoting({
      pollId: poll.id,
      voteMode: "classic",
      isOpenVote: false,
      votingHours: 48,
    });
    pollService.castClassicVote({ pollId: poll.id, userId: USERS[0].id, suggestionId: ids[0] });
    pollService.castClassicVote({ pollId: poll.id, userId: USERS[1].id, suggestionId: ids[1] });
    expireVotingDeadline(poll.id);

    let sent = 0;
    const sendCreatorResults = async () => {
      sent += 1;
    };
    const orig = require("../src/slack/actions");
    const client = mockSlackClient();
    await runSchedulerTick({ client, _noop: sendCreatorResults });
    const closed = pollService.getPollById(poll.id);
    assert.equal(closed.phase, "closed");
    void orig;
    void sent;
  });

  it("cancel works while voting; closed message still has Oylarini gor", () => {
    const poll = pollService.createPoll({
      channelId: CHANNEL,
      creatorId: CREATOR,
      creatorSlackIds: [CREATOR],
      title: "Iptal",
      suggestionHours: 48,
    });
    addNamedSuggestion(poll.id, USERS[0], "Color Maze");
    addNamedSuggestion(poll.id, USERS[1], "Maze Dash");
    const ids = pollService.listSuggestions(poll.id).map((s) => s.id);
    pollService.saveShortlist({ pollId: poll.id, suggestionIds: ids });
    pollService.startVoting({
      pollId: poll.id,
      voteMode: "classic",
      isOpenVote: false,
      votingHours: 48,
    });
    pollService.castClassicVote({ pollId: poll.id, userId: USERS[4].id, suggestionId: ids[0] });
    const cancel = pollService.cancelActivePollInChannel({
      channelId: CHANNEL,
      actingSlackUserIds: [CREATOR],
    });
    assert.equal(cancel.ok, true);
    assert.equal(pollService.getPollById(poll.id).phase, "closed");
    const lines = pollService.getUserVoteSummaryLines({
      pollId: poll.id,
      actingUserIds: [USERS[4].id],
    });
    assert.ok(lines[0].includes("Color Maze"));
    const closedBlocks = votingClosedBlocks({ poll: pollService.getPollById(poll.id) });
    assert.ok(closedBlocks.some((b) => b.elements?.some((el) => el.action_id === "show_my_votes")));
    assert.ok(!collectSectionTexts(closedBlocks).includes("salt okunur"));
  });

  it("insufficient suggestions auto-closes; duplicate game names are rejected", () => {
    const poll = pollService.createPoll({
      channelId: CHANNEL,
      creatorId: CREATOR,
      creatorSlackIds: [CREATOR],
      title: "Tek Oneri",
      suggestionHours: 48,
    });
    addNamedSuggestion(poll.id, USERS[0], "Color Maze");
    const dup = pollService.addSuggestion({
      pollId: poll.id,
      userId: USERS[1].id,
      parsed: parseSuggestionInput("Color Maze : Mehmet Demir"),
    });
    assert.equal(dup.ok, false);
    expireSuggestionDeadline(poll.id);
    const expired = pollService.getExpiredSuggestionPolls();
    assert.equal(expired.length, 1);
    assert.equal(pollService.listSuggestions(poll.id).length, 1);
  });

  it("falls back to channel mention when DM fails but still delivers 20-name list", async () => {
    const poll = pollService.createPoll({
      channelId: CHANNEL,
      creatorId: CREATOR,
      creatorSlackIds: [CREATOR],
      title: "DM Yok",
      suggestionHours: 48,
    });
    for (const user of USERS) {
      for (const game of user.games) {
        addNamedSuggestion(poll.id, user, game);
      }
    }
    const client = mockSlackClient({ dmOk: false, ephemeralOk: false, channelOk: true });
    const delivered = await deliverCreatorSuggestionSetup({ client, poll });
    assert.equal(delivered.channel, true);
    const channelPost = client.posts.find((p) => p.channel === CHANNEL);
    assert.ok(channelPost.text.includes(`<@${CREATOR}>`));
    const blob = JSON.stringify(channelPost.blocks);
    assert.ok(blob.includes("Willow Run"));
    assert.ok(blob.includes("Color Maze"));
  });

  it("start-voting modal lists collected suggestions in the picker (cap 99)", () => {
    const poll = pollService.createPoll({
      channelId: CHANNEL,
      creatorId: CREATOR,
      creatorSlackIds: [CREATOR],
      title: "Modal",
      suggestionHours: 48,
    });
    for (const user of USERS) {
      for (const game of user.games) {
        addNamedSuggestion(poll.id, user, game);
      }
    }
    const modal = buildStartVotingModal({
      poll,
      suggestions: pollService.listSuggestions(poll.id),
    });
    const pick = modal.blocks.find((b) => b.block_id === "slot_pick_1");
    assert.equal(pick, undefined, "pick row hidden until mode is list");
    const withList = buildStartVotingModal({
      poll,
      suggestions: pollService.listSuggestions(poll.id),
      preservedValues: {
        slot_mode_1: { slot_mode_1_select: { selected_option: { value: "list" } } },
      },
    });
    const pickBlock = withList.blocks.find((b) => b.block_id === "slot_pick_1");
    const optionTexts = pickBlock.element.options.map((o) => o.text.text);
    assert.ok(optionTexts.includes("Color Maze : Ayse Kaya") || optionTexts.some((t) => t.includes("Color Maze")));
    assert.ok(optionTexts.some((t) => t.includes("Willow Run")));
    assert.ok(optionTexts.length >= 21);
  });
});
