/**
 * Slack may surface different user id fields across slash commands vs Block Kit / modals
 * (e.g. Enterprise Grid). Collect all plausible ids for the acting human.
 */
function collectCreatorCandidateIds(body, command) {
  const out = new Set();
  const add = (x) => {
    const v = String(x || "").trim();
    if (v) {
      out.add(v);
    }
  };

  if (body) {
    add(body.user_id);
    if (body.user && typeof body.user === "object") {
      add(body.user.id);
      if (body.user.enterprise_user && typeof body.user.enterprise_user === "object") {
        add(body.user.enterprise_user.id);
      }
    }
    if (Array.isArray(body.authorizations)) {
      for (const a of body.authorizations) {
        if (a && a.user_id) {
          add(a.user_id);
        }
      }
    }
  }
  if (command) {
    add(command.user_id);
  }
  return Array.from(out);
}

/** Prefer stable interactive user id for votes / modals. */
function primarySlackUserId(body) {
  if (body && body.user && body.user.id) {
    return String(body.user.id).trim();
  }
  const ids = collectCreatorCandidateIds(body);
  return ids[0] || "";
}

module.exports = {
  collectCreatorCandidateIds,
  primarySlackUserId,
};
