const { v4: uuidv4 } = require("uuid");
const { getState, persist } = require("../db/store");
const { addHoursIso, addMinutesIso, nowIso, isPastIso } = require("../utils/time");
const env = require("../config/env");

const MAX_OPTIONS = 10;

function resolveDeadlineFromHours(hours) {
  if (env.fastTestMode) {
    return addMinutesIso(env.fastTestMinutes);
  }
  return addHoursIso(hours);
}

function createPoll({ channelId, creatorId, title, suggestionHours }) {
  const state = getState();
  const id = uuidv4();
  const createdAt = nowIso();
  const suggestionDeadline = resolveDeadlineFromHours(suggestionHours || env.defaultSuggestionHours);

  state.polls.push({
    id,
    channel_id: channelId,
    creator_id: creatorId,
    title: title || "Unico Poll",
    phase: "suggestion",
    vote_mode: "classic",
    is_open_vote: 0,
    suggestion_deadline_at: suggestionDeadline,
    voting_deadline_at: null,
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

function getActivePollInChannel(channelId) {
  const state = getState();
  const open = state.polls
    .filter((p) => p.channel_id === channelId && p.phase !== "closed")
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return open[0] || null;
}

function addSuggestion({ pollId, userId, parsed }) {
  const state = getState();
  const poll = getPollById(pollId);
  if (!poll || poll.phase !== "suggestion" || isPastIso(poll.suggestion_deadline_at)) {
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
    const idSet = new Set(shortlistRows.map((ps) => ps.suggestion_id));
    return state.suggestions
      .filter((s) => s.poll_id === pollId && idSet.has(s.id))
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  }
  return listSuggestions(pollId).slice(0, MAX_OPTIONS);
}

function startVoting({ pollId, voteMode, isOpenVote, votingHours }) {
  const state = getState();
  const poll = getPollById(pollId);
  if (!poll || !["suggestion", "ready_for_voting"].includes(poll.phase)) {
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
  state.polls[idx] = {
    ...state.polls[idx],
    phase: "voting",
    vote_mode: voteMode,
    is_open_vote: isOpenVote ? 1 : 0,
    voting_deadline_at: resolveDeadlineFromHours(votingHours || env.defaultVotingHours),
    updated_at: nowIso(),
  };
  persist();
  return getPollById(pollId);
}

function markSuggestionClosed(pollId) {
  const state = getState();
  const idx = state.polls.findIndex((p) => p.id === pollId && p.phase === "suggestion");
  if (idx !== -1) {
    state.polls[idx] = {
      ...state.polls[idx],
      phase: "ready_for_voting",
      updated_at: nowIso(),
    };
    persist();
  }
  return getPollById(pollId);
}

function castClassicVote({ pollId, userId, suggestionId }) {
  const state = getState();
  const poll = getPollById(pollId);
  if (!poll || poll.phase !== "voting" || poll.vote_mode !== "classic" || isPastIso(poll.voting_deadline_at)) {
    return { ok: false, reason: "Classic voting is closed." };
  }

  const existing = state.votes_classic.find((v) => v.poll_id === pollId && v.user_id === userId);
  const ts = nowIso();
  if (existing) {
    existing.suggestion_id = suggestionId;
    existing.created_at = ts;
  } else {
    state.votes_classic.push({
      id: uuidv4(),
      poll_id: pollId,
      suggestion_id: suggestionId,
      user_id: userId,
      created_at: ts,
    });
  }
  persist();
  return { ok: true };
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
  const ts = nowIso();
  if (existing) {
    existing.rating = score;
    existing.created_at = ts;
  } else {
    state.votes_rating.push({
      id: uuidv4(),
      poll_id: pollId,
      suggestion_id: suggestionId,
      user_id: userId,
      rating: score,
      created_at: ts,
    });
  }
  persist();
  return { ok: true };
}

function closePoll(pollId) {
  const state = getState();
  const idx = state.polls.findIndex((p) => p.id === pollId);
  if (idx !== -1) {
    state.polls[idx] = {
      ...state.polls[idx],
      phase: "closed",
      updated_at: nowIso(),
    };
    persist();
  }
  return getPollById(pollId);
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

function createRunoff({ sourcePollId, creatorId, channelId, suggestionIds, hours }) {
  const source = getPollById(sourcePollId);
  if (!source) {
    throw new Error("Source poll not found.");
  }
  const poll = createPoll({
    channelId,
    creatorId,
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
    isOpenVote: Boolean(source.is_open_vote),
    votingHours: hours || env.defaultRunoffHours,
  });
}

module.exports = {
  MAX_OPTIONS,
  createPoll,
  getPollById,
  getActivePollInChannel,
  addSuggestion,
  getUserSuggestionCountSince,
  listSuggestions,
  saveShortlist,
  getShortlistedSuggestions,
  startVoting,
  castClassicVote,
  castRatingVote,
  closePoll,
  getExpiredSuggestionPolls,
  getExpiredVotingPolls,
  markSuggestionClosed,
  buildResults,
  isCloseResult,
  createRunoff,
};
