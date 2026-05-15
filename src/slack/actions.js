const pollService = require("../services/pollService");
const env = require("../config/env");
const logger = require("../utils/logger");
const store = require("../db/store");
const { collectCreatorCandidateIds, primarySlackUserId } = require("../utils/slackActor");
const {
  buildStartVotingModal,
  buildDirectBallotModal,
  votingBlocks,
  votingClosedBlocks,
  buildClassicVoteModal,
  buildRatingModal,
  creatorResultsBlocks,
  channelResultsBlocks,
  SLOT_MODE_SKIP,
} = require("./blocks");

function parseMetadata(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch (err) {
    return {};
  }
}

function metadataChannelId(meta) {
  return meta.channelId || meta.channel_id || null;
}

function describeVotingStartFailure(message) {
  const m = String(message || "");
  if (m.includes("Poll is closed")) {
    return (
      "Bu anket *iptal edilmis veya kapatilmis*. Acik kalan modal veya *eski* \"Secenekleri gir\" dugmesi artik gecerli degil. " +
      "Yeni anket ac: `/unico-poll Baslik | direkt` ve *en son* DM veya kanal kurulum mesajindaki dugmeyi kullan (iptal ettigin ankete ait mesaja tiklama)."
    );
  }
  if (m.includes("Poll not found")) {
    return "Anket bulunamadi. Yeni anket acip tekrar dene.";
  }
  if (m.includes("Not poll creator")) {
    return "Bu islemi yalnizca anketi baslatan kullanici yapabilir.";
  }
  if (m.includes("Poll is not in ballot_setup")) {
    return "Anket bu islem icin uygun fazda degil (ornegin oylama baslamis veya iptal edilmis). Kanali kontrol et; gerekirse yeni `/unico-poll ... | direkt` ac.";
  }
  if (m.includes("At least 2 ballot lines") || m.includes("At least 2 suggestions")) {
    return "En az 2 *farkli* secenek gerekir (ayni isim iki kez yazilirsa tek sayilir).";
  }
  if (m.includes("Poll is not in suggestion phase")) {
    return "Bu anket bu modali kullanamayacak fazda (ornegin oylama zaten baslamis).";
  }
  return `Islem tamamlanamadi: ${m}`;
}

/** Oylama listesi modalindaki 10 sirayi oku (her sirada slot_mode: bos | list | manual). */
function parseShortlistSlotsFromView(st, allSuggestions) {
  const validIds = new Set(allSuggestions.map((s) => s.id));
  const errors = {};
  const ordered = [];
  for (let i = 1; i <= 10; i += 1) {
    const mode =
      st[`slot_mode_${i}`]?.[`slot_mode_${i}_select`]?.selected_option?.value || SLOT_MODE_SKIP;
    if (mode === SLOT_MODE_SKIP) {
      continue;
    }
    if (mode === "list") {
      const pickRaw = st[`slot_pick_${i}`]?.[`slot_pick_${i}_select`]?.selected_option?.value;
      const hasPick = pickRaw && pickRaw !== "__skip__";
      if (!hasPick) {
        errors[`slot_pick_${i}`] = "Onerilerden birini sec.";
        continue;
      }
      if (!validIds.has(pickRaw)) {
        errors[`slot_pick_${i}`] = "Bu oneri bu ankette bulunamadi.";
        continue;
      }
      ordered.push({ type: "pick", id: pickRaw, slot: i });
    } else if (mode === "manual") {
      const textVal = String(st[`slot_text_${i}`]?.[`slot_text_${i}_input`]?.value || "").trim();
      if (!textVal) {
        errors[`slot_text_${i}`] = "Metin yaz veya turu (bos) yap.";
        continue;
      }
      ordered.push({ type: "manual", text: textVal, slot: i });
    }
  }
  const seenPick = new Set();
  for (const item of ordered) {
    if (item.type !== "pick") {
      continue;
    }
    if (seenPick.has(item.id)) {
      errors[`slot_pick_${item.slot}`] = "Bu oneri baska bir sirada zaten sectin.";
    }
    seenPick.add(item.id);
  }
  if (Object.keys(errors).length) {
    return { ok: false, errors };
  }
  if (ordered.length < 2) {
    return { ok: false, errors: { slot_mode_1: "En az 2 sirada tur sec (oneri veya elle yaz)." } };
  }
  return { ok: true, ordered };
}

function collectDirectBallotOptionLines(view) {
  const st = view.state.values;
  const lines = [];
  for (let i = 1; i <= 10; i += 1) {
    const bid = `direct_ballot_slot_${i}`;
    const raw = st[bid]?.[`direct_ballot_slot_${i}_input`]?.value;
    const t = String(raw || "").trim();
    if (t) {
      lines.push(t);
    }
  }
  if (lines.length < 2) {
    return {
      ok: false,
      errors: { direct_ballot_slot_1: "En az 2 kutuya secenek yaz (her biri tek satir)." },
    };
  }
  if (lines.length > pollService.MAX_OPTIONS) {
    return {
      ok: false,
      errors: { direct_ballot_slot_1: `En fazla ${pollService.MAX_OPTIONS} dolu kutu olabilir.` },
    };
  }
  return { ok: true, lines };
}

async function notifyOpenClassicVote(client, body, pollId, suggestionId, { openVote } = {}) {
  store.reloadStoreFromDisk();
  const poll = pollService.getPollById(pollId);
  const isOpen = openVote === true || (openVote !== false && pollService.isOpenVotePoll(poll));
  if (!poll || !isOpen) {
    logger.warn("Open vote notice skipped", {
      pollId,
      openVoteFlag: openVote,
      is_open_vote: poll?.is_open_vote,
      vote_mode: poll?.vote_mode,
    });
    return;
  }
  const uid = primarySlackUserId(body) || body?.user?.id;
  const label = pollService.getSuggestionDisplayNameForPoll({ pollId, suggestionId });
  const safeLabel = String(label || "?")
    .replace(/[*_`]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  const voterTag = uid ? `<@${uid}>` : "Bir kullanici";
  const mrkdwn = `${voterTag} oy kullandi: ${safeLabel || "?"}`;
  const plain = mrkdwn;
  const ch = poll.voting_message_channel || poll.channel_id;
  if (!ch) {
    logger.warn("Open vote: poll has no channel_id", { pollId });
    return;
  }

  const payload = {
    channel: ch,
    text: plain,
    blocks: [{ type: "section", text: { type: "mrkdwn", text: mrkdwn } }],
    link_names: true,
  };

  try {
    if (poll.voting_message_ts) {
      await client.chat.postMessage({
        ...payload,
        thread_ts: poll.voting_message_ts,
        reply_broadcast: true,
      });
    } else {
      await client.chat.postMessage(payload);
    }
    logger.info("Open vote notice posted", { pollId, channel: ch, userId: uid, thread: Boolean(poll.voting_message_ts) });
  } catch (err) {
    logger.error("Open vote post failed (thread/broadcast)", {
      pollId,
      channel: ch,
      error: err.message,
      slack: err.data?.error,
    });
    try {
      await client.chat.postMessage({ ...payload, channel: poll.channel_id || ch });
      logger.info("Open vote notice posted (channel fallback)", { pollId });
    } catch (err2) {
      logger.error("Open vote channel fallback failed", { pollId, error: err2.message, slack: err2.data?.error });
    }
  }
}

function votePrivacyFromModalState(st, mode) {
  if (String(mode || "").trim().toLowerCase() === "rating") {
    return "closed";
  }
  const raw = st.vote_privacy?.vote_privacy_select?.selected_option?.value;
  if (raw == null || String(raw).trim() === "") {
    return null;
  }
  return String(raw).trim().toLowerCase();
}

function slackErrorDetail(err) {
  if (!err) {
    return "bilinmeyen hata";
  }
  const bits = [err.message].filter(Boolean);
  if (err.data && err.data.error) {
    bits.push(String(err.data.error));
  }
  return bits.join(" — ") || "bilinmeyen Slack hatasi";
}

async function safePostEphemeral(client, { channelId, user, text }) {
  if (!channelId || !user || !text) {
    return;
  }
  try {
    await client.chat.postEphemeral({
      channel: channelId,
      user,
      text,
    });
  } catch (err) {
    logger.error("postEphemeral failed", { channelId, user, error: err.message });
  }
}

async function refreshVotingChannelMessageClosed(client, pollId) {
  const poll = pollService.getPollById(pollId);
  if (!poll?.voting_message_ts || !poll?.voting_message_channel) {
    return;
  }
  try {
    await client.chat.update({
      channel: poll.voting_message_channel,
      ts: poll.voting_message_ts,
      text: `<!channel> ${poll.title}: oylama kapandi.`,
      blocks: votingClosedBlocks({ poll }),
    });
  } catch (err) {
    logger.error("Failed to update voting channel message", { pollId, error: err.message });
  }
}

function withChannelMention(text, fallback) {
  const base = String(text || fallback || "").trim();
  if (!base) {
    return "<!channel>";
  }
  if (base.includes("<!channel>")) {
    return base;
  }
  return `<!channel> ${base}`;
}

async function postVotingEndedChannelNotice(client, poll) {
  if (!poll?.channel_id) {
    return;
  }
  const body =
    `<!channel> *${poll.title}* — oylama *bitti*.\n` +
    "_Sonuclar anketi baslatan kisiye gonderildi; kanala yayin icin onun paylasmasini bekle._";
  try {
    await client.chat.postMessage({
      channel: poll.channel_id,
      text: `<!channel> ${poll.title} — oylama bitti.`,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: body } }],
    });
  } catch (err) {
    logger.error("Voting ended channel notice failed", { pollId: poll.id, error: err.message });
  }
}

async function postChannelVotingMessage(client, { poll, suggestions, text }) {
  const p = pollService.getPollById(poll.id);
  if (!p) {
    return null;
  }
  const fallbackText = `<!channel> ${p.title} oylamasi basladi.`;
  const res = await client.chat.postMessage({
    channel: p.channel_id,
    text: withChannelMention(text, fallbackText),
    blocks: votingBlocks({ poll: p, suggestions }),
  });
  if (res.ok && res.ts && res.channel) {
    pollService.setVotingMessageMeta({ pollId: p.id, channel: res.channel, ts: res.ts });
  }
  return res;
}

async function sendCreatorResults(app, pollId) {
  try {
    store.reloadStoreFromDisk();
    const pollPre = pollService.getPollById(pollId);
    if (!pollPre) {
      return;
    }
    if (pollPre.creator_results_sent_at) {
      logger.info("Skipping duplicate creator results notification (already sent)", { pollId });
      return;
    }
    const claim = pollService.tryClaimCreatorResultsNotification(pollId);
    if (!claim.ok) {
      logger.info("Skipping duplicate creator results notification (claim lost)", { pollId });
      return;
    }
    try {
      const data = pollService.buildResults(pollId);
      if (!data) {
        pollService.clearCreatorResultsSent(pollId, claim.claimTs);
        return;
      }
      const close = pollService.isCloseResult(data.results);

      await app.client.chat.postEphemeral({
        channel: data.poll.channel_id,
        user: data.poll.creator_id,
        text: "Oylama bitti.",
        blocks: creatorResultsBlocks({ poll: data.poll, results: data.results, close }),
      });
      await postVotingEndedChannelNotice(app.client, data.poll);
    } catch (error) {
      pollService.clearCreatorResultsSent(pollId, claim.claimTs);
      throw error;
    }
    try {
      await refreshVotingChannelMessageClosed(app.client, pollId);
    } catch (error) {
      logger.error("Failed to refresh voting channel message after creator results", {
        pollId,
        error: error.message,
      });
    }
  } catch (error) {
    logger.error("Failed to send creator results", { pollId, error: error.message });
  }
}

function registerActions(app) {
  app.action("open_start_voting_modal", async ({ ack, body, client }) => {
    await ack();
    const pollId = body.actions?.[0]?.value;
    const poll = pollService.getPollById(pollId);
    if (!poll || !pollService.pollManagedByAnyOf(poll, collectCreatorCandidateIds(body))) {
      return;
    }
    const suggestions = pollService.listSuggestions(pollId);

    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildStartVotingModal({ poll, suggestions }),
    });
  });

  app.action(/^slot_mode_\d+_select$/, async ({ ack, body, client }) => {
    await ack();
    const view = body.view;
    if (!view || view.callback_id !== "start_voting_submit") {
      return;
    }
    const meta = parseMetadata(view.private_metadata);
    const poll = pollService.getPollById(meta.pollId);
    if (!poll || !pollService.pollManagedByAnyOf(poll, collectCreatorCandidateIds(body))) {
      return;
    }
    const suggestions = pollService.listSuggestions(poll.id);
    try {
      await client.views.update({
        view_id: view.id,
        hash: view.hash,
        view: buildStartVotingModal({
          poll,
          suggestions,
          preservedValues: view.state.values,
        }),
      });
    } catch (error) {
      logger.error("start_voting modal views.update failed", { pollId: meta.pollId, error: error.message });
    }
  });

  app.action("vote_mode_select", async ({ ack, body, client }) => {
    await ack();
    const view = body.view;
    if (!view || !["start_voting_submit", "direct_ballot_submit"].includes(view.callback_id)) {
      return;
    }
    const meta = parseMetadata(view.private_metadata);
    const poll = pollService.getPollById(meta.pollId);
    if (!poll || !pollService.pollManagedByAnyOf(poll, collectCreatorCandidateIds(body))) {
      return;
    }
    try {
      if (view.callback_id === "start_voting_submit") {
        const suggestions = pollService.listSuggestions(poll.id);
        await client.views.update({
          view_id: view.id,
          hash: view.hash,
          view: buildStartVotingModal({
            poll,
            suggestions,
            preservedValues: view.state.values,
          }),
        });
      } else {
        await client.views.update({
          view_id: view.id,
          hash: view.hash,
          view: buildDirectBallotModal({
            poll,
            preservedValues: view.state.values,
          }),
        });
      }
    } catch (error) {
      logger.error("vote_mode modal views.update failed", { pollId: meta.pollId, error: error.message });
    }
  });

  app.action("open_direct_ballot_modal", async ({ ack, body, client }) => {
    await ack();
    const pollId = body.actions?.[0]?.value;
    const poll = pollService.getPollById(pollId);
    const channelId = body.channel?.id;
    const userId = body.user.id;
    const actingIds = collectCreatorCandidateIds(body);

    if (!poll) {
      await safePostEphemeral(client, {
        channelId,
        user: userId,
        text: "Bu anket bulunamadi veya silinmis.",
      });
      return;
    }
    if (!pollService.pollManagedByAnyOf(poll, actingIds)) {
      await safePostEphemeral(client, {
        channelId,
        user: userId,
        text: "Bu anketi yalnizca *baslatan kullanici* yonetir. Secenekleri girmek icin anketi `/unico-poll` ile acan kisi dugmeye basmali.",
      });
      return;
    }
    if (poll.phase !== "ballot_setup") {
      if (poll.phase === "closed") {
        await safePostEphemeral(client, {
          channelId,
          user: userId,
          text:
            "Bu anket *kapatilmis / iptal edilmis*. Bu mesajdaki dugme artik gecerli degil. " +
            "Yeni anket: `/unico-poll Baslik | direkt` — *en son* DM veya kanaldaki \"Secenekleri gir\" dugmesini kullan.",
        });
        return;
      }
      const hint =
        poll.phase === "voting"
          ? "Bu anket icin oylama zaten baslamis. Kanalda son oylama mesajina bak."
          : "Bu anket bu adimi artik desteklemiyor. Gerekirse `/unico-poll iptal` ile kapatip yeniden dene.";
      await safePostEphemeral(client, {
        channelId,
        user: userId,
        text: hint,
      });
      return;
    }

    try {
      await client.views.open({
        trigger_id: body.trigger_id,
        view: buildDirectBallotModal({ poll }),
      });
    } catch (err) {
      logger.error("open_direct_ballot_modal views.open failed", {
        pollId,
        userId,
        error: err.message,
      });
      await safePostEphemeral(client, {
        channelId,
        user: userId,
        text: `Modal acilamadi: _${slackErrorDetail(err)}_. Trigger suresi dolmus olabilir; DM veya kanaldaki *Secenekleri gir* dugmesine tekrar bas.`,
      });
    }
  });

  app.view("direct_ballot_submit", async ({ ack, body, view, client }) => {
    const collected = collectDirectBallotOptionLines(view);
    if (!collected.ok) {
      await ack({
        response_action: "errors",
        errors: collected.errors,
      });
      return;
    }
    const lines = collected.lines;

    const st = view.state.values;
    const mode = st.vote_mode?.vote_mode_select?.selected_option?.value;
    const privacy = votePrivacyFromModalState(st, mode);
    if (!mode) {
      await ack({
        response_action: "errors",
        errors: { vote_mode: "Oylama turunu sec." },
      });
      return;
    }
    const hours = Number.parseInt(st.vote_duration?.vote_duration_input?.value, 10) || env.defaultVotingHours;
    if (mode === "classic" && !privacy) {
      await ack({
        response_action: "errors",
        errors: {
          vote_privacy: "Oy gorunurlugunu listeden sec (Acik veya Kapali).",
        },
      });
      return;
    }
    const openVote = mode === "classic" && privacy === "open";

    await ack();
    const meta = parseMetadata(view.private_metadata);
    const channelId = metadataChannelId(meta);
    const poll = pollService.getPollById(meta.pollId);
    const replyCh = channelId || poll?.channel_id;

    if (!poll) {
      await safePostEphemeral(client, {
        channelId: replyCh,
        user: body.user.id,
        text: "Anket bulunamadi veya silinmis.",
      });
      return;
    }
    if (!pollService.pollManagedByAnyOf(poll, collectCreatorCandidateIds(body))) {
      await safePostEphemeral(client, {
        channelId: poll.channel_id,
        user: body.user.id,
        text: "Bu islemi yalnizca anketi baslatan kullanici yapabilir.",
      });
      return;
    }
    if (poll.phase === "closed") {
      await safePostEphemeral(client, {
        channelId: poll.channel_id,
        user: body.user.id,
        text:
          "Bu anket *iptal edilmis*. Acik modal gecersiz; girdigin isimler kaydedilmedi. " +
          "Yeni anket: `/unico-poll Baslik | direkt` — yalnizca *yeni* DM veya kanal kurulum mesajindaki dugmeyi kullan.",
      });
      return;
    }
    if (poll.phase === "voting") {
      await safePostEphemeral(client, {
        channelId: poll.channel_id,
        user: body.user.id,
        text:
          "*Oylama zaten baslamis.* Kanalda son oylama mesajina bakabilirsin. Cift tiklama yaptiysan ekstra bir sey yapmana gerek yok.",
      });
      return;
    }
    if (poll.phase !== "ballot_setup") {
      await safePostEphemeral(client, {
        channelId: poll.channel_id,
        user: body.user.id,
        text:
          "Bu modali bu ankette simdi kullanamazsin (faz degismis). " +
          "Iptal ettiysen yeni `/unico-poll ... | direkt` ile ac ve *en son* DM veya kanal kurulum mesajindaki dugmeyi kullan.",
      });
      return;
    }

    const previousPhase = poll.phase;

    let updatedPoll;
    let shortlist;
    try {
      pollService.replacePollSuggestionsFromLines({
        pollId: poll.id,
        actingSlackUserIds: collectCreatorCandidateIds(body),
        lines,
      });
      const suggestions = pollService.listSuggestions(poll.id);
      pollService.saveShortlist({
        pollId: poll.id,
        suggestionIds: suggestions.map((s) => s.id),
      });
      updatedPoll = pollService.startVoting({
        pollId: poll.id,
        voteMode: mode,
        isOpenVote: openVote,
        votingHours: hours,
      });
      shortlist = pollService.getShortlistedSuggestions(poll.id);
    } catch (error) {
      logger.error("Failed direct ballot start (data)", {
        pollId: meta.pollId,
        userId: body.user.id,
        error: error.message,
      });
      await safePostEphemeral(client, {
        channelId: poll.channel_id,
        user: body.user.id,
        text: describeVotingStartFailure(error.message),
      });
      return;
    }

    try {
      await postChannelVotingMessage(client, { poll: updatedPoll, suggestions: shortlist });
    } catch (error) {
      pollService.revertVotingStart({ pollId: poll.id, previousPhase });
      logger.error("Failed direct ballot postMessage", {
        pollId: poll.id,
        userId: body.user.id,
        error: error.message,
      });
      await safePostEphemeral(client, {
        channelId: poll.channel_id,
        user: body.user.id,
        text:
          `*Oylama kaydi acildi* (oylar toplanabilir) fakat *kanala duyuru atilamadi*: _${slackErrorDetail(error)}_. ` +
          `Anket *yeniden secenek girme* fazina alindi; DM veya kanalda *Secenekleri gir* dugmesinden tekrar dene. ` +
          `Botu kanala \`/invite @bot\` ile ekle ve Slack uygulamasinda \`chat:write\` / \`chat:write.public\` izinlerini kontrol et.`,
      });
    }
  });

  app.view("start_voting_submit", async ({ ack, body, view, client }) => {
    const meta = parseMetadata(view.private_metadata);
    const channelFallback = metadataChannelId(meta);
    const poll = pollService.getPollById(meta.pollId);
    const actingIds = collectCreatorCandidateIds(body);
    const uid = body.user?.id;

    if (!poll || !pollService.pollManagedByAnyOf(poll, actingIds)) {
      await ack();
      await safePostEphemeral(client, {
        channelId: channelFallback || poll?.channel_id,
        user: uid,
        text: !poll ? "Anket bulunamadi." : "Bu islemi yalnizca anketi baslatan kullanici yapabilir.",
      });
      return;
    }

    if (poll.phase === "voting") {
      await ack();
      await safePostEphemeral(client, {
        channelId: poll.channel_id,
        user: uid,
        text:
          "*Oylama zaten baslamis.* Kanalda son oylama mesajina bakabilirsin. Cift tiklama yaptiysan ekstra bir sey yapmana gerek yok.",
      });
      return;
    }

    if (!["suggestion", "ready_for_voting"].includes(poll.phase)) {
      await ack();
      await safePostEphemeral(client, {
        channelId: poll.channel_id,
        user: uid,
        text: "Bu anket su an bu modali kullanarak oylama baslatamaz.",
      });
      return;
    }

    const st = view.state.values;
    const mode = st.vote_mode?.vote_mode_select?.selected_option?.value;
    const privacy = votePrivacyFromModalState(st, mode);
    const hours = Number.parseInt(st.vote_duration?.vote_duration_input?.value, 10) || env.defaultVotingHours;
    if (!mode) {
      await ack({
        response_action: "errors",
        errors: { vote_mode: "Oylama turunu sec." },
      });
      return;
    }
    if (mode === "classic" && !privacy) {
      await ack({
        response_action: "errors",
        errors: {
          vote_privacy: "Oy gorunurlugunu listeden sec (Acik veya Kapali).",
        },
      });
      return;
    }
    const openVote = mode === "classic" && privacy === "open";

    const allSuggestions = pollService.listSuggestions(poll.id);
    const slotParse = parseShortlistSlotsFromView(st, allSuggestions);
    if (!slotParse.ok) {
      await ack({ response_action: "errors", errors: slotParse.errors });
      return;
    }

    const finalIds = [];
    for (const item of slotParse.ordered) {
      if (item.type === "pick") {
        finalIds.push(item.id);
      } else {
        const newId = pollService.appendCreatorShortlistLine({
          pollId: poll.id,
          actingSlackUserIds: actingIds,
          line: item.text,
        });
        if (!newId) {
          await ack({
            response_action: "errors",
            errors: {
              [`slot_text_${item.slot}`]: "Gecersiz metin. Ornek: Isim veya Isim : PM ; not",
            },
          });
          return;
        }
        finalIds.push(newId);
      }
    }

    const deduped = [...new Set(finalIds)].slice(0, pollService.MAX_OPTIONS);
    if (deduped.length < 2) {
      await ack({
        response_action: "errors",
        errors: { slot_pick_1: "En az 2 gecerli secenek (sec veya yaz) gerekir." },
      });
      return;
    }

    const previousPhase = poll.phase;
    pollService.saveShortlist({ pollId: poll.id, suggestionIds: deduped });

    await ack();

    let updatedPoll;
    let shortlist;
    try {
      updatedPoll = pollService.startVoting({
        pollId: poll.id,
        voteMode: mode,
        isOpenVote: openVote,
        votingHours: hours,
      });
      shortlist = pollService.getShortlistedSuggestions(poll.id);
    } catch (error) {
      logger.error("Failed to start voting (data)", { pollId: poll.id, userId: uid, error: error.message });
      await safePostEphemeral(client, {
        channelId: poll.channel_id,
        user: uid,
        text: describeVotingStartFailure(error.message),
      });
      return;
    }

    try {
      await postChannelVotingMessage(client, { poll: updatedPoll, suggestions: shortlist });
    } catch (error) {
      pollService.revertVotingStart({ pollId: poll.id, previousPhase });
      logger.error("Failed start_voting postMessage", {
        pollId: poll.id,
        userId: uid,
        error: error.message,
      });
      await safePostEphemeral(client, {
        channelId: poll.channel_id,
        user: uid,
        text:
          `*Oylama kaydi acildi* fakat *kanala duyuru atilamadi*: _${slackErrorDetail(error)}_. ` +
          `Anket *oylama oncesi* fazina geri alindi; oylamayi baslatmayi *Oylama listesini sec* (veya yonetici bildirimindeki ayni akisi acan dugme) uzerinden tekrar dene. ` +
          `Botu kanala davet et ve \`chat:write\` / \`chat:write.public\` izinlerini kontrol et.`,
      });
    }
  });

  app.action(/^classic_vote__/, async ({ ack, body, client }) => {
    await ack();
    const value = parseMetadata(body.actions?.[0]?.value);
    const uid = primarySlackUserId(body) || body.user?.id;
    const pollRow = pollService.getPollById(value.pollId);
    const ephemeralChannel =
      body.channel?.id || body.container?.channel_id || pollRow?.channel_id;
    const vote = pollService.castClassicVote({
      pollId: value.pollId,
      userId: uid,
      suggestionId: value.suggestionId,
    });
    await safePostEphemeral(client, {
      channelId: ephemeralChannel,
      user: uid,
      text: !vote.ok
        ? vote.reason
        : vote.recorded === false
          ? "Oyun bu secenekle zaten kayitli."
          : "Oyun kaydedildi.",
    });
    if (vote.ok && vote.recorded && vote.openVote) {
      await notifyOpenClassicVote(client, body, value.pollId, value.suggestionId, { openVote: true });
    }
  });

  app.action("open_classic_vote_modal", async ({ ack, body, client }) => {
    await ack();
    const pollId = body.actions?.[0]?.value;
    const poll = pollService.getPollById(pollId);
    if (!poll) {
      return;
    }
    if (!pollService.isVotingCurrentlyOpen(poll)) {
      await safePostEphemeral(client, {
        channelId: body.channel?.id,
        user: body.user.id,
        text:
          "Oylama kapandi veya sure bitti; oylari buradan degistiremezsin. Kanaldaki *Oylarini gor* ile kendi kaydina bak.",
      });
      return;
    }
    if (pollService.hasUserClassicVoteForPoll(pollId, body.user.id)) {
      await safePostEphemeral(client, {
        channelId: body.channel?.id,
        user: body.user.id,
        text: "Bu ankette oy kullandin; oy degistirilemez. *Oylarini gor* ile kaydina bakabilirsin.",
      });
      return;
    }
    const suggestions = pollService.getShortlistedSuggestions(pollId);
    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildClassicVoteModal({ poll, suggestions }),
    });
  });

  app.view("classic_vote_submit", async ({ ack, body, view, client }) => {
    await ack();
    const meta = parseMetadata(view.private_metadata);
    const uid = primarySlackUserId(body) || body.user?.id;
    const pollRow = pollService.getPollById(meta.pollId);
    const channelId = metadataChannelId(meta) || pollRow?.channel_id;
    const suggestionId = view.state.values.classic_vote_choice.classic_vote_select.selected_option.value;
    const vote = pollService.castClassicVote({
      pollId: meta.pollId,
      userId: uid,
      suggestionId,
    });
    await client.chat.postEphemeral({
      channel: channelId || pollRow?.channel_id,
      user: uid,
      text: !vote.ok
        ? vote.reason
        : vote.recorded === false
          ? "Oyun bu secenekle zaten kayitli."
          : "Oyun kaydedildi.",
    });
    if (vote.ok && vote.recorded && vote.openVote) {
      await notifyOpenClassicVote(client, body, meta.pollId, suggestionId, { openVote: true });
    }
  });

  app.action("open_rating_modal", async ({ ack, body, client }) => {
    await ack();
    const pollId = body.actions?.[0]?.value;
    const poll = pollService.getPollById(pollId);
    if (!poll) {
      return;
    }
    if (!pollService.isVotingCurrentlyOpen(poll)) {
      await safePostEphemeral(client, {
        channelId: body.channel?.id,
        user: body.user.id,
        text:
          "Oylama kapandi veya sure bitti; puanlari buradan degistiremezsin. Kanaldaki *Oylarini gor* ile kendi kaydina bak.",
      });
      return;
    }
    if (pollService.hasUserRatingSubmissionForPoll(pollId, body.user.id)) {
      await safePostEphemeral(client, {
        channelId: body.channel?.id,
        user: body.user.id,
        text: "Bu ankette puanlarini zaten gonderdin; degistirilemez. *Oylarini gor* ile kaydina bakabilirsin.",
      });
      return;
    }
    const suggestions = pollService.getShortlistedSuggestions(pollId);
    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildRatingModal({ poll, suggestions }),
    });
  });

  app.view("rating_vote_submit", async ({ ack, body, view, client }) => {
    await ack();
    const meta = parseMetadata(view.private_metadata);
    const poll = pollService.getPollById(meta.pollId);
    const uid = primarySlackUserId(body) || body.user?.id;
    const channelId = metadataChannelId(meta) || poll?.channel_id;
    if (!poll) {
      await safePostEphemeral(client, {
        channelId,
        user: uid,
        text: "Anket bulunamadi.",
      });
      return;
    }
    if (!pollService.isVotingCurrentlyOpen(poll)) {
      await safePostEphemeral(client, {
        channelId,
        user: uid,
        text:
          "Oylama kapandi veya sure bitti; puanlari artik kaydedemezsin. Kanaldaki *Oylarini gor* ile kendi kaydina bak.",
      });
      return;
    }

    if (pollService.hasUserRatingSubmissionForPoll(poll.id, uid)) {
      await safePostEphemeral(client, {
        channelId,
        user: uid,
        text: "Bu ankette puanlarini zaten gonderdin; degistirilemez.",
      });
      return;
    }

    const stateValues = view.state.values;
    let firstErr = "";
    const openParts = [];
    for (const [blockId, value] of Object.entries(stateValues)) {
      if (!blockId.startsWith("rating_")) {
        continue;
      }
      const suggestionId = blockId.replace("rating_", "");
      const rating = value?.rating_value?.selected_option?.value;
      if (rating == null) {
        continue;
      }
      const r = pollService.castRatingVote({
        pollId: poll.id,
        userId: uid,
        suggestionId,
        rating,
      });
      if (!r.ok && !firstErr) {
        firstErr = r.reason;
      } else if (r.ok && r.recorded) {
        const label = pollService.getSuggestionDisplayNameForPoll({
          pollId: poll.id,
          suggestionId,
        });
        openParts.push(`*${label}:* ${rating}/5`);
      }
    }

    if (firstErr) {
      await safePostEphemeral(client, {
        channelId,
        user: uid,
        text: firstErr,
      });
      return;
    }

    await safePostEphemeral(client, {
      channelId,
      user: uid,
      text: "Puanlarin kaydedildi.",
    });


  });

  app.action("show_my_votes", async ({ ack, body, client }) => {
    await ack();
    const pollId = body.actions?.[0]?.value;
    const lines = pollService.getUserVoteSummaryLines({
      pollId,
      actingUserIds: [
        ...new Set(
          [primarySlackUserId(body), ...collectCreatorCandidateIds(body)].map((x) => String(x || "").trim()).filter(Boolean)
        ),
      ],
    });
    await safePostEphemeral(client, {
      channelId: body.channel?.id,
      user: body.user.id,
      text: "Oylarini (salt okunur)",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: lines.join("\n") } }],
    });
  });

  app.action("publish_results", async ({ ack, body, client }) => {
    await ack();
    const pollId = body.actions?.[0]?.value;
    const livePoll = pollService.getPollById(pollId);
    const actingIds = collectCreatorCandidateIds(body);
    const ephemeralUser = primarySlackUserId(body) || body.user?.id;
    const ephemeralChannel = body.channel?.id || livePoll?.channel_id;

    if (!livePoll) {
      await safePostEphemeral(client, {
        channelId: ephemeralChannel,
        user: ephemeralUser,
        text: "Anket bulunamadi veya silindi.",
      });
      return;
    }
    if (!pollService.pollManagedByAnyOf(livePoll, actingIds)) {
      await safePostEphemeral(client, {
        channelId: ephemeralChannel,
        user: ephemeralUser,
        text: "Bu islemi yalnizca anketi baslatan / yonetici kullanici yapabilir.",
      });
      return;
    }

    const data = pollService.buildResults(pollId);
    if (!data) {
      await safePostEphemeral(client, {
        channelId: ephemeralChannel,
        user: ephemeralUser,
        text: "Sonuclar hesaplanamadi (anket verisi eksik olabilir).",
      });
      return;
    }

    store.reloadStoreFromDisk();
    const freshPoll = pollService.getPollById(pollId);
    if (freshPoll?.channel_results_published_at) {
      await safePostEphemeral(client, {
        channelId: ephemeralChannel,
        user: ephemeralUser,
        text: "Sonuclar zaten bu anket icin kanala yayinlanmis.",
      });
      return;
    }
    const publishClaim = pollService.tryClaimChannelResultsPublished(pollId);
    if (!publishClaim.ok) {
      await safePostEphemeral(client, {
        channelId: ephemeralChannel,
        user: ephemeralUser,
        text: "Sonuclar zaten bu anket icin kanala yayinlanmis.",
      });
      return;
    }

    try {
      await client.chat.postMessage({
        channel: data.poll.channel_id,
        text: withChannelMention(null, `${data.poll.title} sonuclari`),
        blocks: channelResultsBlocks(data),
      });
      logger.info("Results published", { pollId, userId: ephemeralUser });
    } catch (error) {
      pollService.clearChannelResultsPublished(pollId, publishClaim.claimTs);
      logger.error("Failed to publish results", { pollId, error: error.message });
      await safePostEphemeral(client, {
        channelId: ephemeralChannel,
        user: ephemeralUser,
        text: `Kanala yayinlanamadi: _${slackErrorDetail(error)}_`,
      });
    }
  });

  app.action("start_runoff", async ({ ack, body, client }) => {
    await ack();
    const pollId = body.actions?.[0]?.value;
    const livePoll = pollService.getPollById(pollId);
    const actingIds = collectCreatorCandidateIds(body);
    const ephemeralUser = primarySlackUserId(body) || body.user?.id;
    const ephemeralChannel = body.channel?.id || livePoll?.channel_id;
    const data = pollService.buildResults(pollId);
    if (!data || !pollService.pollManagedByAnyOf(data.poll, actingIds)) {
      await safePostEphemeral(client, {
        channelId: ephemeralChannel,
        user: ephemeralUser,
        text: !data
          ? "Sonuclar yuklenemedi."
          : "Bu islemi yalnizca anketi baslatan / yonetici kullanici yapabilir.",
      });
      return;
    }
    try {
      const topIds = data.results.slice(0, 3).map((row) => row.id);
      const runoff = pollService.createRunoff({
        sourcePollId: pollId,
        creatorId: data.poll.creator_id,
        channelId: data.poll.channel_id,
        suggestionIds: topIds,
        hours: env.defaultRunoffHours,
      });
      const shortlist = pollService.getShortlistedSuggestions(runoff.id);

      await postChannelVotingMessage(client, {
        poll: runoff,
        suggestions: shortlist,
        text: `<!channel> ${runoff.title} run-off oylamasi basladi.`,
      });
      logger.info("Runoff started", { sourcePollId: pollId, runoffPollId: runoff.id, userId: ephemeralUser });
    } catch (error) {
      logger.error("Failed to start runoff", { pollId, error: error.message });
      await safePostEphemeral(client, {
        channelId: ephemeralChannel,
        user: ephemeralUser,
        text: `Run-off baslatilirken hata: _${slackErrorDetail(error)}_`,
      });
    }
  });
}

module.exports = {
  registerActions,
  sendCreatorResults,
};
