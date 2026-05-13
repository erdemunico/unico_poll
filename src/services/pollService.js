const { v4: uuidv4 } = require("uuid");
const { getState, persist } = require("../db/store");
const { addHoursIso, addMinutesIso, nowIso, isPastIso } = require("../utils/time");
const { parseSuggestionInput } = require("../utils/parser");
const env = require("../config/env");

const MAX_OPTIONS = 10;

function resolveDeadlineFromHours(hours) {
  if (env.fastTestMode) {
    return addMinutesIso(env.fastTestMinutes);
  }
  return addHoursIso(hours);
}

function createPoll({ channelId, creatorId, creatorSlackIds, title, suggestionHours, skipSuggestionCollect }) {
  const state = getState();
  const id = uuidv4();
  const createdAt = nowIso();
  const skip = Boolean(skipSuggestionCollect);
  const phase = skip ? "ballot_setup" : "suggestion";
  const suggestionDeadline = skip ? null : resolveDeadlineFromHours(suggestionHours || env.defaultSuggestionHours);

  const mergedIds = [
    ...new Set(
      [creatorId, ...(creatorSlackIds || [])].map((x) => String(x || "").trim()).filter(Boolean)
    ),
  ];
  const primaryCreator = mergedIds[0] || String(creatorId || "").trim();

  state.polls.push({
    id,
    channel_id: channelId,
    creator_id: primaryCreator,
    creator_slack_ids: mergedIds,
    title: title || "Unico Poll",
    phase,
    vote_mode: "classic",
    is_open_vote: 0,
    suggestion_deadline_at: suggestionDeadline,
    voting_deadline_at: null,
    voting_message_ts: null,
    voting_message_channel: null,
    creator_results_sent_at: null,
    channel_results_published_at: null,
    suggestion_phase_close_claimed_at: null,
    voting_close_claimed_at: null,
    created_at: createdAt,
    updated_at: createdAt,
  });
  persist();
  return getPollById(id);
}

function getPollById(pollId) {
  const state = getState();
  return state.polls.find((p) => p.id === pollId) || null;
}

function normalizedPollCreatorIdSet(poll) {
  const ids = [];
  if (poll && poll.creator_slack_ids && Array.isArray(poll.creator_slack_ids) && poll.creator_slack_ids.length > 0) {
    ids.push(...poll.creator_slack_ids);
  }
  if (poll && poll.creator_id) {
    ids.push(poll.creator_id);
  }
  return new Set(ids.map((x) => String(x || "").trim()).filter(Boolean));
}

function pollManagedByAnyOf(poll, candidateIds) {
  const allowed = normalizedPollCreatorIdSet(poll);
  const cands = (candidateIds || []).map((x) => String(x || "").trim()).filter(Boolean);
  return cands.some((c) => allowed.has(c));
}

function getActivePollInChannel(channelId) {
  const state = getState();
  const open = state.polls
    .filter((p) => p.channel_id === channelId && p.phase !== "closed")
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return open[0] || null;
}

/** Only someone matching stored creator Slack ids may cancel; moves poll to `closed`. */
function cancelActivePollInChannel({ channelId, actingSlackUserIds }) {
  const poll = getActivePollInChannel(channelId);
  if (!poll) {
    return { ok: false, reason: "no_poll" };
  }
  if (!pollManagedByAnyOf(poll, actingSlackUserIds)) {
    return { ok: false, reason: "not_creator" };
  }
  closePoll(poll.id);
  return { ok: true, poll };
}

function addSuggestion({ pollId, userId, parsed }) {
  const state = getState();
  const poll = getPollById(pollId);
  if (
    !poll ||
    poll.phase !== "suggestion" ||
    !poll.suggestion_deadline_at ||
    isPastIso(poll.suggestion_deadline_at)
  ) {
    return { ok: false, reason: "Suggestion phase is closed." };
  }

  const exists = state.suggestions.some(
    (s) => s.poll_id === pollId && s.display_name.toLowerCase() === parsed.displayName.toLowerCase()
  );
  if (exists) {
    return { ok: false, reason: "This suggestion already exists." };
  }

  const id = uuidv4();
  state.suggestions.push({
    id,
    poll_id: pollId,
    submitted_by: userId,
    raw_text: parsed.rawText,
    display_name: parsed.displayName,
    pm_keyword: parsed.pmKeyword,
    extra: parsed.extra,
    created_at: nowIso(),
  });
  persist();
  return { ok: true, suggestionId: id };
}

function getUserSuggestionCountSince({ pollId, userId, sinceIso }) {
  const state = getState();
  const since = new Date(sinceIso).getTime();
  return state.suggestions.filter((s) => {
    if (s.poll_id !== pollId || s.submitted_by !== userId) {
      return false;
    }
    return new Date(s.created_at).getTime() >= since;
  }).length;
}

function listSuggestions(pollId) {
  const state = getState();
  return state.suggestions
    .filter((s) => s.poll_id === pollId)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

function lineToSuggestionPayload(line) {
  const t = String(line || "").trim();
  if (!t) {
    return null;
  }
  const parsed = parseSuggestionInput(t);
  if (parsed) {
    return parsed;
  }
  return {
    rawText: t,
    displayName: t.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80),
    pmKeyword: "",
    extra: "",
  };
}

/** Yonetici oylama listesine tek satir ekler (mevcut onerilerden bagimsiz yeni secenek). */
function appendCreatorShortlistLine({ pollId, actingSlackUserIds, line }) {
  const poll = getPollById(pollId);
  if (!poll || !["suggestion", "ready_for_voting"].includes(poll.phase)) {
    return null;
  }
  if (!pollManagedByAnyOf(poll, actingSlackUserIds)) {
    return null;
  }
  const payload = lineToSuggestionPayload(line);
  if (!payload || !payload.displayName) {
    return null;
  }
  const state = getState();
  const id = uuidv4();
  const ts = nowIso();
  const uid = (actingSlackUserIds && actingSlackUserIds[0]) || poll.creator_id;
  state.suggestions.push({
    id,
    poll_id: pollId,
    submitted_by: uid,
    raw_text: payload.rawText,
    display_name: payload.displayName,
    pm_keyword: payload.pmKeyword || "",
    extra: payload.extra || "",
    created_at: ts,
  });
  persist();
  return id;
}

/** Replaces all suggestions for a poll in `ballot_setup` with lines from the creator (direct ballot). */
function replacePollSuggestionsFromLines({ pollId, actingSlackUserIds, lines }) {
  const poll = getPollById(pollId);
  if (!poll) {
    throw new Error("Poll not found.");
  }
  if (poll.phase === "closed") {
    throw new Error("Poll is closed.");
  }
  if (!pollManagedByAnyOf(poll, actingSlackUserIds)) {
    throw new Error("Not poll creator.");
  }
  if (poll.phase !== "ballot_setup") {
    throw new Error(`Poll is not in ballot_setup (phase=${poll.phase}).`);
  }
  const state = getState();
  const payloads = [];
  const seen = new Set();
  for (const line of lines) {
    const p = lineToSuggestionPayload(line);
    if (!p || !p.displayName) {
      continue;
    }
    const key = p.displayName.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    payloads.push(p);
  }
  if (payloads.length < 2) {
    throw new Error("At least 2 ballot lines are required.");
  }
  const capped = payloads.slice(0, MAX_OPTIONS);
  state.suggestions = state.suggestions.filter((s) => s.poll_id !== pollId);
  state.poll_shortlist = state.poll_shortlist.filter((row) => row.poll_id !== pollId);
  const ts = nowIso();
  const submittedBy = poll.creator_id;
  for (const p of capped) {
    state.suggestions.push({
      id: uuidv4(),
      poll_id: pollId,
      submitted_by: submittedBy,
      raw_text: p.rawText,
      display_name: p.displayName,
      pm_keyword: p.pmKeyword || "",
      extra: p.extra || "",
      created_at: ts,
    });
  }
  persist();
  return listSuggestions(pollId);
}

function saveShortlist({ pollId, suggestionIds }) {
  const state = getState();
  const cleanIds = [...new Set(suggestionIds)].slice(0, MAX_OPTIONS);
  state.poll_shortlist = state.poll_shortlist.filter((row) => row.poll_id !== pollId);
  for (const suggestionId of cleanIds) {
    state.poll_shortlist.push({ poll_id: pollId, suggestion_id: suggestionId });
  }
  persist();
  return cleanIds;
}

function getShortlistedSuggestions(pollId) {
  const state = getState();
  const shortlistRows = state.poll_shortlist.filter((ps) => ps.poll_id === pollId);
  if (shortlistRows.length > 0) {
    const suggById = new Map(
      state.suggestions.filter((s) => s.poll_id === pollId).map((s) => [s.id, s])
    );
    const ordered = [];
    for (const row of shortlistRows) {
      const s = suggById.get(row.suggestion_id);
      if (s) {
        ordered.push(s);
      }
    }
    return ordered;
  }
  return listSuggestions(pollId).slice(0, MAX_OPTIONS);
}

function startVoting({ pollId, voteMode, isOpenVote, votingHours }) {
  const state = getState();
  const poll = getPollById(pollId);
  if (!poll || !["suggestion", "ready_for_voting", "ballot_setup"].includes(poll.phase)) {
    throw new Error("Poll is not in suggestion phase.");
  }
  const shortlisted = getShortlistedSuggestions(pollId);
  if (shortlisted.length < 2) {
    throw new Error("At least 2 suggestions are required to start voting.");
  }

  const idx = state.polls.findIndex((p) => p.id === pollId);
  if (idx === -1) {
    throw new Error("Poll not found.");
  }
  const allowOpen = voteMode === "classic" && Boolean(isOpenVote);
  state.polls[idx] = {
    ...state.polls[idx],
    phase: "voting",
    vote_mode: voteMode,
    is_open_vote: allowOpen ? 1 : 0,
    voting_deadline_at: resolveDeadlineFromHours(votingHours || env.defaultVotingHours),
    updated_at: nowIso(),
  };
  persist();
  return getPollById(pollId);
}

/** If channel postMessage fails after startVoting, restore phase so the creator can retry from the modal/button. */
function revertVotingStart({ pollId, previousPhase }) {
  const allowed = new Set(["suggestion", "ready_for_voting", "ballot_setup"]);
  if (!allowed.has(previousPhase)) {
    return getPollById(pollId);
  }
  const state = getState();
  const idx = state.polls.findIndex((p) => p.id === pollId);
  if (idx === -1) {
    return null;
  }
  const p = state.polls[idx];
  if (p.phase !== "voting") {
    return getPollById(pollId);
  }
  state.polls[idx] = {
    ...p,
    phase: previousPhase,
    voting_deadline_at: null,
    updated_at: nowIso(),
  };
  persist();
  return getPollById(pollId);
}

/**
 * Tekillestirme: oneri suresi doldu bildirimi (ve faz gecisi) ayni anda birden fazla tetiklenmesin
 * (coklu bot sureci / cron ust uste binmesi).
 */
function tryClaimSuggestionPhaseClose(pollId) {
  const state = getState();
  const idx = state.polls.findIndex((p) => p.id === pollId);
  if (idx === -1) {
    return false;
  }
  const p = state.polls[idx];
  if (p.phase !== "suggestion" || !p.suggestion_deadline_at || !isPastIso(p.suggestion_deadline_at)) {
    return false;
  }
  if (p.suggestion_phase_close_claimed_at) {
    return false;
  }
  const ts = nowIso();
  state.polls[idx] = {
    ...p,
    suggestion_phase_close_claimed_at: ts,
    updated_at: ts,
  };
  persist();
  return true;
}

function clearSuggestionPhaseCloseClaim(pollId) {
  const state = getState();
  const idx = state.polls.findIndex((p) => p.id === pollId);
  if (idx === -1) {
    return;
  }
  state.polls[idx] = {
    ...state.polls[idx],
    suggestion_phase_close_claimed_at: null,
    updated_at: nowIso(),
  };
  persist();
}

function markSuggestionClosed(pollId) {
  const state = getState();
  const idx = state.polls.findIndex((p) => p.id === pollId && p.phase === "suggestion");
  if (idx !== -1) {
    state.polls[idx] = {
      ...state.polls[idx],
      phase: "ready_for_voting",
      suggestion_phase_close_claimed_at: null,
      updated_at: nowIso(),
    };
    persist();
  }
  return getPollById(pollId);
}

function castClassicVote({ pollId, userId, suggestionId }) {
  const state = getState();
  const poll = getPollById(pollId);
  const mode = String(poll?.vote_mode || "").trim().toLowerCase();
  if (!poll || poll.phase !== "voting" || mode !== "classic" || isPastIso(poll.voting_deadline_at)) {
    return { ok: false, reason: "Classic voting is closed." };
  }

  const existing = state.votes_classic.find((v) => v.poll_id === pollId && v.user_id === userId);
  if (existing) {
    if (existing.suggestion_id !== suggestionId) {
      return {
        ok: false,
        reason: "Bu ankette oy kullandin; oy degistirilemez.",
      };
    }
    return { ok: true, recorded: false };
  }
  const ts = nowIso();
  state.votes_classic.push({
    id: uuidv4(),
    poll_id: pollId,
    suggestion_id: suggestionId,
    user_id: userId,
    created_at: ts,
  });
  persist();
  return { ok: true, recorded: true };
}

function hasUserRatingSubmissionForPoll(pollId, userId) {
  const state = getState();
  return state.votes_rating.some((v) => v.poll_id === pollId && v.user_id === userId);
}

function hasUserClassicVoteForPoll(pollId, userId) {
  const state = getState();
  return state.votes_classic.some((v) => v.poll_id === pollId && v.user_id === userId);
}

function castRatingVote({ pollId, userId, suggestionId, rating }) {
  const state = getState();
  const poll = getPollById(pollId);
  if (!poll || poll.phase !== "voting" || poll.vote_mode !== "rating" || isPastIso(poll.voting_deadline_at)) {
    return { ok: false, reason: "Rating voting is closed." };
  }

  const score = Number.parseInt(rating, 10);
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    return { ok: false, reason: "Rating must be between 1 and 5." };
  }

  const existing = state.votes_rating.find(
    (v) => v.poll_id === pollId && v.suggestion_id === suggestionId && v.user_id === userId
  );
  if (existing) {
    if (Number(existing.rating) !== score) {
      return {
        ok: false,
        reason: "Bu secenek icin puan zaten verildi; degistirilemez.",
      };
    }
    return { ok: true, recorded: false };
  }
  const ts = nowIso();
  state.votes_rating.push({
    id: uuidv4(),
    poll_id: pollId,
    suggestion_id: suggestionId,
    user_id: userId,
    rating: score,
    created_at: ts,
  });
  persist();
  return { ok: true, recorded: true };
}

function closePoll(pollId) {
  const state = getState();
  const idx = state.polls.findIndex((p) => p.id === pollId);
  if (idx !== -1) {
    state.polls[idx] = {
      ...state.polls[idx],
      phase: "closed",
      suggestion_phase_close_claimed_at: null,
      voting_close_claimed_at: null,
      updated_at: nowIso(),
    };
    persist();
  }
  return getPollById(pollId);
}

function setVotingMessageMeta({ pollId, channel, ts }) {
  const state = getState();
  const idx = state.polls.findIndex((p) => p.id === pollId);
  if (idx === -1) {
    return;
  }
  state.polls[idx] = {
    ...state.polls[idx],
    voting_message_channel: channel,
    voting_message_ts: ts,
    updated_at: nowIso(),
  };
  persist();
}

/**
 * Atomically reserve creator-results delivery. Call before postEphemeral; on Slack failure use clearCreatorResultsSent.
 * Prevents duplicate notifications when the scheduler overlaps or multiple bot processes share the JSON file.
 */
function tryClaimCreatorResultsNotification(pollId) {
  const state = getState();
  const idx = state.polls.findIndex((p) => p.id === pollId);
  if (idx === -1) {
    return false;
  }
  if (state.polls[idx].creator_results_sent_at) {
    return false;
  }
  const ts = nowIso();
  state.polls[idx] = {
    ...state.polls[idx],
    creator_results_sent_at: ts,
    updated_at: ts,
  };
  persist();
  return true;
}

function clearCreatorResultsSent(pollId) {
  const state = getState();
  const idx = state.polls.findIndex((p) => p.id === pollId);
  if (idx === -1) {
    return;
  }
  state.polls[idx] = {
    ...state.polls[idx],
    creator_results_sent_at: null,
    updated_at: nowIso(),
  };
  persist();
}

function isVotingCurrentlyOpen(poll) {
  return (
    poll &&
    poll.phase === "voting" &&
    poll.voting_deadline_at &&
    !isPastIso(poll.voting_deadline_at)
  );
}

function getUserVoteSummaryLines({ pollId, actingUserIds }) {
  const state = getState();
  const poll = getPollById(pollId);
  if (!poll) {
    return ["Anket bulunamadi."];
  }
  const uidSet = new Set((actingUserIds || []).map((x) => String(x || "").trim()).filter(Boolean));
  if (poll.vote_mode === "classic") {
    const v = state.votes_classic.find((x) => x.poll_id === pollId && uidSet.has(x.user_id));
    if (!v) {
      return ["Bu anket icin klasik oy kaydin bulunamadi."];
    }
    const sugg = state.suggestions.find((s) => s.id === v.suggestion_id);
    return [`*Tek oy:* ${sugg ? sugg.display_name : "?"}`];
  }
  const rows = state.votes_rating.filter((x) => x.poll_id === pollId && uidSet.has(x.user_id));
  if (!rows.length) {
    return ["Bu anket icin puan kaydin bulunamadi."];
  }
  return rows.map((r) => {
    const sugg = state.suggestions.find((s) => s.id === r.suggestion_id);
    const name = sugg ? sugg.display_name : "?";
    return `*${name}:* ${r.rating}/5`;
  });
}

/** Atomically reserve a single channel publish for this poll; clear on postMessage failure. */
function tryClaimChannelResultsPublished(pollId) {
  const state = getState();
  const idx = state.polls.findIndex((p) => p.id === pollId);
  if (idx === -1) {
    return false;
  }
  if (state.polls[idx].channel_results_published_at) {
    return false;
  }
  const ts = nowIso();
  state.polls[idx] = {
    ...state.polls[idx],
    channel_results_published_at: ts,
    updated_at: ts,
  };
  persist();
  return true;
}

function clearChannelResultsPublished(pollId) {
  const state = getState();
  const idx = state.polls.findIndex((p) => p.id === pollId);
  if (idx === -1) {
    return;
  }
  state.polls[idx] = {
    ...state.polls[idx],
    channel_results_published_at: null,
    updated_at: nowIso(),
  };
  persist();
}

function getExpiredSuggestionPolls() {
  const state = getState();
  const now = nowIso();
  return state.polls.filter(
    (p) => p.phase === "suggestion" && p.suggestion_deadline_at && p.suggestion_deadline_at <= now
  );
}

function getExpiredVotingPolls() {
  const state = getState();
  const now = nowIso();
  return state.polls.filter(
    (p) => p.phase === "voting" && p.voting_deadline_at && p.voting_deadline_at <= now
  );
}

const VOTING_CLOSE_CLAIM_STALE_MS = 15 * 60 * 1000;

/**
 * Reserve voting-close work for this poll (same idea as suggestion phase claim).
 * Stale claims (>15m) can be stolen so a crashed worker does not block forever.
 */
function tryClaimVotingCloseDelivery(pollId) {
  const state = getState();
  const idx = state.polls.findIndex((p) => p.id === pollId);
  if (idx === -1) {
    return false;
  }
  const p = state.polls[idx];
  if (p.phase !== "voting" || !p.voting_deadline_at || !isPastIso(p.voting_deadline_at)) {
    return false;
  }
  const existing = p.voting_close_claimed_at;
  if (existing) {
    const t = new Date(existing).getTime();
    if (Number.isFinite(t) && Date.now() - t < VOTING_CLOSE_CLAIM_STALE_MS) {
      return false;
    }
  }
  const ts = nowIso();
  state.polls[idx] = {
    ...p,
    voting_close_claimed_at: ts,
    updated_at: ts,
  };
  persist();
  return true;
}

function clearVotingCloseDeliveryClaim(pollId) {
  const state = getState();
  const idx = state.polls.findIndex((p) => p.id === pollId);
  if (idx === -1) {
    return;
  }
  state.polls[idx] = {
    ...state.polls[idx],
    voting_close_claimed_at: null,
    updated_at: nowIso(),
  };
  persist();
}

function buildResults(pollId) {
  const state = getState();
  const poll = getPollById(pollId);
  if (!poll) {
    return null;
  }
  const shortlist = getShortlistedSuggestions(pollId);

  let rows = [];
  if (poll.vote_mode === "classic") {
    rows = shortlist.map((s) => {
      const score = state.votes_classic.filter((v) => v.poll_id === pollId && v.suggestion_id === s.id).length;
      return {
        id: s.id,
        display_name: s.display_name,
        pm_keyword: s.pm_keyword,
        extra: s.extra,
        score,
      };
    });
  } else {
    rows = shortlist.map((s) => {
      const ratings = state.votes_rating
        .filter((v) => v.poll_id === pollId && v.suggestion_id === s.id)
        .map((v) => v.rating);
      const avg = ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 100) / 100 : 0;
      return {
        id: s.id,
        display_name: s.display_name,
        pm_keyword: s.pm_keyword,
        extra: s.extra,
        score: avg,
      };
    });
  }

  rows.sort((a, b) => b.score - a.score || a.display_name.localeCompare(b.display_name));
  return { poll, results: rows };
}

function isCloseResult(results) {
  if (!results || results.length < 2) {
    return false;
  }
  const top = Number(results[0].score);
  const second = Number(results[1].score);
  const diff = Math.abs(top - second);
  return diff <= (top > 10 ? 2 : 0.5);
}

function isOpenVotePoll(poll) {
  const mode = String(poll?.vote_mode || "").trim().toLowerCase();
  if (mode !== "classic") {
    return false;
  }
  const v = poll?.is_open_vote;
  if (v === true || v === 1) {
    return true;
  }
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "1" || s === "true" || s === "yes") {
      return true;
    }
  }
  const n = Number(v);
  return Number.isFinite(n) && n === 1;
}

function getSuggestionDisplayNameForPoll({ pollId, suggestionId }) {
  const state = getState();
  const s = state.suggestions.find((x) => x.id === suggestionId && x.poll_id === pollId);
  return s ? s.display_name : "?";
}

function createRunoff({ sourcePollId, creatorId, channelId, suggestionIds, hours }) {
  const source = getPollById(sourcePollId);
  if (!source) {
    throw new Error("Source poll not found.");
  }
  const poll = createPoll({
    channelId,
    creatorId,
    creatorSlackIds: source.creator_slack_ids?.length
      ? source.creator_slack_ids
      : [source.creator_id].filter(Boolean),
    title: `${source.title} (Run-off)`,
    suggestionHours: 1,
  });

  const sourceSuggestions = listSuggestions(sourcePollId).filter((s) => suggestionIds.includes(s.id));
  for (const suggestion of sourceSuggestions) {
    addSuggestion({
      pollId: poll.id,
      userId: creatorId,
      parsed: {
        rawText: suggestion.raw_text,
        displayName: suggestion.display_name,
        pmKeyword: suggestion.pm_keyword || "",
        extra: suggestion.extra || "",
      },
    });
  }

  const newSuggestions = listSuggestions(poll.id);
  saveShortlist({
    pollId: poll.id,
    suggestionIds: newSuggestions.map((item) => item.id).slice(0, 3),
  });

  return startVoting({
    pollId: poll.id,
    voteMode: source.vote_mode,
    isOpenVote: isOpenVotePoll(source),
    votingHours: hours || env.defaultRunoffHours,
  });
}

module.exports = {
  MAX_OPTIONS,
  createPoll,
  getPollById,
  getActivePollInChannel,
  cancelActivePollInChannel,
  replacePollSuggestionsFromLines,
  appendCreatorShortlistLine,
  pollManagedByAnyOf,
  addSuggestion,
  getUserSuggestionCountSince,
  listSuggestions,
  saveShortlist,
  getShortlistedSuggestions,
  startVoting,
  revertVotingStart,
  castClassicVote,
  castRatingVote,
  hasUserRatingSubmissionForPoll,
  hasUserClassicVoteForPoll,
  closePoll,
  getExpiredSuggestionPolls,
  getExpiredVotingPolls,
  tryClaimVotingCloseDelivery,
  clearVotingCloseDeliveryClaim,
  markSuggestionClosed,
  tryClaimSuggestionPhaseClose,
  clearSuggestionPhaseCloseClaim,
  buildResults,
  isCloseResult,
  createRunoff,
  setVotingMessageMeta,
  tryClaimCreatorResultsNotification,
  clearCreatorResultsSent,
  tryClaimChannelResultsPublished,
  clearChannelResultsPublished,
  isVotingCurrentlyOpen,
  getUserVoteSummaryLines,
  isOpenVotePoll,
  getSuggestionDisplayNameForPoll,
};
