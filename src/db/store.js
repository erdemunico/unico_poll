const fs = require("fs");
const path = require("path");
const env = require("../config/env");

function resolveStorePath() {
  const base = env.databasePath;
  if (String(base).endsWith(".json")) {
    return path.resolve(base);
  }
  if (String(base).endsWith(".db")) {
    return path.resolve(String(base).replace(/\.db$/i, ".json"));
  }
  return path.resolve(`${base}.json`);
}

let state = null;
let storePath = null;

function defaultState() {
  return {
    polls: [],
    suggestions: [],
    poll_shortlist: [],
    votes_classic: [],
    votes_rating: [],
  };
}

function ensureLoaded() {
  if (state) {
    return;
  }
  storePath = resolveStorePath();
  const dir = path.dirname(storePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (fs.existsSync(storePath)) {
    const raw = fs.readFileSync(storePath, "utf8");
    state = JSON.parse(raw);
    state.polls ||= [];
    state.suggestions ||= [];
    state.poll_shortlist ||= [];
    state.votes_classic ||= [];
    state.votes_rating ||= [];
  } else {
    state = defaultState();
  }
}

function getState() {
  ensureLoaded();
  return state;
}

function persist() {
  ensureLoaded();
  fs.writeFileSync(storePath, JSON.stringify(state, null, 2), "utf8");
}

module.exports = {
  getState,
  persist,
};
