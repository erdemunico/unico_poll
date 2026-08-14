const { parseHoursArg, parseSuggestionInput, parseSkipChannelSuggestions, stripSkipChannelKeywords } = require("../utils/parser");
const { collectCreatorCandidateIds } = require("../utils/slackActor");
const { isPastIso, formatSlackDate } = require("../utils/time");
const env = require("../config/env");
const pollService = require("../services/pollService");
const store = require("../db/store");
const logger = require("../utils/logger");
const {
  suggestionAnnouncementBlocks,
  directPollCreatorDmBlocks,
  directPollCreatorFallbackChannelBlocks,
  creatorSuggestionControlBlocks,
  buildSuggestionModal,
} = require("./blocks");

function parseCommandText(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return { title: "Unico Poll", hours: env.defaultSuggestionHours, skipSuggestionCollect: false };
  }

  const [titleRaw, optionsRaw = ""] = raw.split("|").map((p) => p.trim());
  const opt = optionsRaw || "";
  const skipSuggestionCollect = parseSkipChannelSuggestions(opt);
  const hoursPart = stripSkipChannelKeywords(opt);
  return {
    title: titleRaw.trim() || "Unico Poll",
    hours: parseHoursArg(hoursPart, env.defaultSuggestionHours),
    skipSuggestionCollect,
  };
}

function isCancelCommandText(text) {
  const raw = String(text || "").trim();
  if (!raw || raw.includes("|")) {
    return false;
  }
  const lower = raw.toLowerCase();
  return lower === "cancel" || lower === "iptal";
}

function isStatusCommandText(text) {
  const raw = String(text || "").trim();
  if (!raw || raw.includes("|")) {
    return false;
  }
  const lower = raw.toLowerCase();
  return lower === "durum" || lower === "status" || lower === "info";
}

function formatActivePollStatus(poll) {
  const suggestions = pollService.listSuggestions(poll.id);
  const lines = [
    `*Aktif anket:* ${poll.title}`,
    `*Faz:* ${phaseDescriptionTr(poll.phase)}`,
    `*Oneri sayisi:* ${suggestions.length}`,
  ];
  if (poll.suggestion_deadline_at) {
    lines.push(`*Oneri bitis:* ${formatSlackDate(poll.suggestion_deadline_at)}`);
  }
  if (poll.voting_deadline_at) {
    lines.push(`*Oylama bitis:* ${formatSlackDate(poll.voting_deadline_at)}`);
  }
  if (poll.phase === "ready_for_voting") {
    lines.push(
      "Oneri suresi bitmis; anketi acan kisi `/unico-poll` yazarak *Oylama listesini sec* ekranini alabilir."
    );
  }
  if (poll.phase === "suggestion" && poll.suggestion_deadline_at && isPastIso(poll.suggestion_deadline_at)) {
    lines.push("Oneri suresi dolmus; anketi acan kisi `/unico-poll` yazarak secim ekranini tetikleyebilir.");
  }
  return lines.join("\n");
}

function phaseDescriptionTr(phase) {
  if (phase === "suggestion") {
    return "oneri toplama";
  }
  if (phase === "ready_for_voting") {
    return "oylama listesi bekleniyor (yonetici)";
  }
  if (phase === "voting") {
    return "oylama";
  }
  if (phase === "ballot_setup") {
    return "direkt oylama (yonetici secenek girisi)";
  }
  return phase;
}

function registerCommands(app) {
  app.command("/unico-poll", async ({ ack, body, client, command }) => {
    const channelId = body.channel_id;
    const actingSlackUserIds = collectCreatorCandidateIds(body, command);
    const creatorId = actingSlackUserIds[0] || body.user_id;
    let acknowledged = false;
    const safeAck = async (payload) => {
      if (acknowledged) {
        return;
      }
      if (payload === undefined) {
        await ack();
      } else {
        await ack(payload);
      }
      acknowledged = true;
    };

    try {
      if (
        env.allowedCreatorIds.length > 0 &&
        !actingSlackUserIds.some((id) => env.allowedCreatorIds.includes(id))
      ) {
        await safeAck({
          response_type: "ephemeral",
          text: "Bu komutu kullanma yetkin yok.",
        });
        logger.warn("Unauthorized poll creation attempt", { userId: creatorId, channelId });
        return;
      }

      if (isStatusCommandText(command.text)) {
        store.reloadStoreFromDisk();
        const poll = pollService.getActivePollInChannel(channelId);
        await safeAck({
          response_type: "ephemeral",
          text: poll
            ? formatActivePollStatus(poll)
            : "Bu kanalda *aktif anket kaydi yok.* Yeni anket: `/unico-poll Baslik | 48h`",
        });
        return;
      }

      if (isCancelCommandText(command.text)) {
        store.reloadStoreFromDisk();
        const cancelResult = pollService.cancelActivePollInChannel({
          channelId,
          actingSlackUserIds,
        });
        if (!cancelResult.ok) {
          const msg =
            cancelResult.reason === "not_creator"
              ? "Bu kanaldaki aktif anketi yalnizca onu baslatan kullanici kapatabilir. Komut: `/unico-poll iptal`"
              : "Bu kanalda kapatilacak *aktif anket kaydi* yok. " +
                "Kanalda eski \"oylama acik\" mesaji kalmis olabilir (Railway redeploy sonrasi veri silinince mesaj guncellenmez). " +
                "Yeni anket acabilirsin; eski mesajdaki dugmelere basma.";
          await safeAck({
            response_type: "ephemeral",
            text: msg,
          });
          return;
        }
        await safeAck({
          response_type: "ephemeral",
          text: `*${cancelResult.poll.title}* anketi kapatildi. Yeni anket acabilirsin.`,
        });
        try {
          const { refreshVotingChannelMessageClosed } = require("./actions");
          await refreshVotingChannelMessageClosed(client, cancelResult.poll.id);
        } catch (err) {
          logger.warn("Cancel: could not refresh voting channel message", {
            pollId: cancelResult.poll.id,
            error: err.message,
          });
        }
        logger.info("Poll cancelled via command", { pollId: cancelResult.poll.id, channelId, userId: creatorId });
        return;
      }

      const activePoll = pollService.getActivePollInChannel(channelId);
      if (activePoll) {
        const isCreator = pollService.pollManagedByAnyOf(activePoll, actingSlackUserIds);
        const suggestionExpired =
          activePoll.phase === "suggestion" &&
          activePoll.suggestion_deadline_at &&
          isPastIso(activePoll.suggestion_deadline_at);

        if (isCreator && (activePoll.phase === "ready_for_voting" || suggestionExpired)) {
          await safeAck({
            response_type: "ephemeral",
            text:
              `*${activePoll.title}* — oneri suresi bitti. Secim ekranini DM ve bu kanala tekrar gonderiyorum ` +
              `(kaybolan ephemeral yerine).`,
          });
          try {
            if (suggestionExpired) {
              await closeSuggestionPhaseAndNotify({ app, poll: activePoll });
            } else {
              await deliverCreatorSuggestionSetup({ client, poll: activePoll });
            }
          } catch (err) {
            logger.error("Failed to resend suggestion setup", {
              pollId: activePoll.id,
              error: err.message,
            });
            await client.chat.postEphemeral({
              channel: channelId,
              user: creatorId,
              text: `Secim ekrani gonderilemedi: _${err.message}_`,
            });
          }
          return;
        }

        const extra =
          activePoll.phase === "ready_for_voting"
            ? "\nOneri suresi bitmis; anketi acan kisi `/unico-poll` yazarak *Oylama listesini sec* ekranini tekrar alabilir."
            : "";
        await safeAck({
          response_type: "ephemeral",
          text:
            `Bu kanalda zaten aktif bir anket var: *${activePoll.title}* (${phaseDescriptionTr(
              activePoll.phase
            )}).\n` +
            `Yeni anket icin once mevcut anketi kapatin (yalnizca baslatan): \`/unico-poll iptal\` veya \`/unico-poll cancel\`` +
            extra,
        });
        return;
      }

      const { title, hours, skipSuggestionCollect } = parseCommandText(command.text);
      const poll = pollService.createPoll({
        channelId,
        creatorId,
        creatorSlackIds: actingSlackUserIds,
        title,
        suggestionHours: hours,
        skipSuggestionCollect,
      });

      if (skipSuggestionCollect) {
        const ephemeralFallbackText = `Unico Poll — ${poll.title}: "Secenekleri gir (yonetici)" dugmesine bas.`;
        try {
          await safeAck({
            response_type: "ephemeral",
            text: ephemeralFallbackText,
            blocks: directPollCreatorDmBlocks(poll, channelId, "channel_ephemeral"),
          });
        } catch (ackErr) {
          logger.error("Direct poll ack with blocks failed", {
            pollId: poll.id,
            error: ackErr.message,
          });
          await safeAck({
            response_type: "ephemeral",
            text:
              `*${poll.title}* — direkt anket olusturuldu.\n` +
              `Slack bu mesaja dugme koymadi; *Apps* > *Mesajlar* bolumunden bota gelen DM'i ac veya kanalda botun son mesajina bak.\n` +
              `Hata: _${ackErr.message}_`,
          });
        }

        try {
          let dmOk = false;
          try {
            const im = await client.conversations.open({ users: creatorId });
            if (im.ok && im.channel?.id) {
              await client.chat.postMessage({
                channel: im.channel.id,
                text: `Unico Poll — ${poll.title}: direkt oylama, secenek gir`,
                blocks: directPollCreatorDmBlocks(poll, channelId, "dm"),
              });
              dmOk = true;
            } else {
              logger.warn("Direct poll DM: conversations.open not ok", {
                pollId: poll.id,
                creatorId,
                error: im.error,
              });
            }
          } catch (err) {
            logger.error("Direct poll DM failed", { pollId: poll.id, creatorId, error: err.message });
          }

          if (!dmOk) {
            await client.chat.postMessage({
              channel: channelId,
              text: `Unico Poll — ${title}: direkt oylama (yonetici secenek girisi; DM basarisiz).`,
              blocks: directPollCreatorFallbackChannelBlocks(poll, creatorId),
            });
          }
        } catch (sideErr) {
          logger.error("Direct poll post-ack side effects failed", {
            pollId: poll.id,
            error: sideErr.message,
          });
        }

        logger.info("Poll created", { pollId: poll.id, channelId, userId: creatorId });
        return;
      }

      await safeAck();
      await client.chat.postMessage({
        channel: channelId,
        text: `<!channel> Unico Poll — ${title}: oneri toplama basladi.`,
        blocks: suggestionAnnouncementBlocks(poll),
      });

      await client.chat.postEphemeral({
        channel: channelId,
        user: creatorId,
        text:
          "Anket olusturuldu; *sen yoneticisin*. Katilimcilar *Oneri gonder (form)* ile oneri verir (kanal mesaji dinlenmez). " +
          `Her kisi en fazla *${Math.max(1, env.suggestionMaxPerUser || 5)}* oneri verebilir. ` +
          "Oneri listesi ve oylama kisa listesi sana bu kanalda *ozel (ephemeral)* bildirimlerle gidecek.\n\n" +
          "*Baslik nerden geliyor?* Komutta `|` *oncesi* yazdigin metin bu anketin basligidir (ornek: `/unico-poll Yaz Turnuvasi | 48h` → baslik *Yaz Turnuvasi*). " +
          "`|` *sonrasi* (or. `48h`) sadece *oneri suresi* icindi; kanal mesajinda saat *tarih/saat olarak* son oneri zamani satirinda gorunur, slash ornegi degil.",
      });
      logger.info("Poll created", { pollId: poll.id, channelId, userId: creatorId });
    } catch (error) {
      logger.error("Failed to handle /unico-poll", {
        userId: creatorId,
        channelId,
        error: error.message,
      });
      try {
        await safeAck({
          response_type: "ephemeral",
          text: `Anket olusturulurken bir hata olustu: _${error.message || "bilinmeyen"}_`,
        });
      } catch (ackErr) {
        logger.error("Failed to ack /unico-poll error path", { error: ackErr.message });
      }
    }
  });

  app.action("open_suggestion_modal", async ({ ack, body, client }) => {
    await ack();
    const pollId = body.actions?.[0]?.value;
    store.reloadStoreFromDisk();
    const poll = pollService.getPollById(pollId);
    const channelId = body.channel?.id;
    const uid = body.user?.id;
    if (!channelId || !uid) {
      return;
    }
    if (!poll) {
      logger.warn("open_suggestion_modal: poll not found (store may have been reset)", { pollId });
      await client.chat.postEphemeral({
        channel: channelId,
        user: uid,
        text:
          "Bu anket kaydi bulunamadi (bot yeniden baslatilinca Railway'de veri silinmis olabilir). " +
          "Eski mesajdaki dugmeyi kullanma; yeni anket ac: `/unico-poll Baslik | 1h`",
      });
      return;
    }
    if (
      poll.phase !== "suggestion" ||
      !poll.suggestion_deadline_at ||
      isPastIso(poll.suggestion_deadline_at)
    ) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: uid,
        text: "Bu anket icin oneri zamani doldu veya anket oneri fazinda degil.",
      });
      return;
    }

    const maxPerUser = Math.max(0, env.suggestionMaxPerUser);
    if (maxPerUser > 0) {
      const used = pollService.getUserSuggestionCount({ pollId: poll.id, userId: uid });
      if (used >= maxPerUser) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: uid,
          text:
            `Bu ankette en fazla *${maxPerUser}* oneri verebilirsin; limitine ulastin (*${used}/${maxPerUser}*). ` +
            `Form artik acilmiyor.`,
        });
        return;
      }
    }

    try {
      await client.views.open({
        trigger_id: body.trigger_id,
        view: buildSuggestionModal({ poll }),
      });
    } catch (error) {
      logger.error("open_suggestion_modal failed", { pollId, error: error.message });
      await client.chat.postEphemeral({
        channel: channelId,
        user: uid,
        text: "Form acilamadi. Biraz sonra *Oneri gonder (form)* dugmesine tekrar bas.",
      });
    }
  });

  app.view("suggestion_submit", async ({ ack, body, view, client }) => {
    const raw = String(view.state.values.suggestion_line?.suggestion_line_input?.value || "").trim();
    const parsed = parseSuggestionInput(raw);
    if (!parsed) {
      await ack({
        response_action: "errors",
        errors: {
          suggestion_line:
            "Bos olamaz. Ornek: Onerilen Oyun ismi veya Onerilen Oyun ismi : Isminiz ; Varsa notunuz",
        },
      });
      return;
    }

    let meta = {};
    try {
      meta = JSON.parse(view.private_metadata || "{}");
    } catch (err) {
      meta = {};
    }
    const pollId = meta.pollId;
    const poll = pollService.getPollById(pollId);
    const replyChannel = meta.channelId || poll?.channel_id;
    const uid = body.user?.id;
    if (!uid) {
      await ack({
        response_action: "errors",
        errors: { suggestion_line: "Oturum bilgisi alinamadi; modali kapatip tekrar dene." },
      });
      return;
    }

    if (
      !poll ||
      poll.phase !== "suggestion" ||
      !poll.suggestion_deadline_at ||
      isPastIso(poll.suggestion_deadline_at)
    ) {
      await ack({
        response_action: "errors",
        errors: {
          suggestion_line: "Oneri suresi bitti veya anket bu fazda degil.",
        },
      });
      return;
    }

    const maxPerUser = Math.max(0, env.suggestionMaxPerUser);
    if (maxPerUser > 0) {
      const used = pollService.getUserSuggestionCount({ pollId: poll.id, userId: uid });
      if (used >= maxPerUser) {
        await ack({
          response_action: "errors",
          errors: {
            suggestion_line: `Limit: bu ankette en fazla ${maxPerUser} oneri (*${used}/${maxPerUser}*).`,
          },
        });
        return;
      }
    }

    const windowMinutes = Math.max(1, env.suggestionRateLimitWindowMinutes);
    const limitCount = Math.max(1, env.suggestionRateLimitCount);
    if (env.suggestionRateLimitCount > 0) {
      const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
      const recentCount = pollService.getUserSuggestionCountSince({
        pollId: poll.id,
        userId: uid,
        sinceIso: since,
      });
      if (recentCount >= limitCount) {
        await ack({
          response_action: "errors",
          errors: {
            suggestion_line: `Cok hizli: ${windowMinutes} dakikada en fazla ${limitCount} oneri.`,
          },
        });
        return;
      }
    }

    const result = pollService.addSuggestion({
      pollId: poll.id,
      userId: uid,
      parsed,
    });
    if (!result.ok) {
      let msg = result.reason;
      if (result.reason === "This suggestion already exists.") {
        msg = "Bu isimde bir oneri zaten var.";
      } else if (result.reason === "User suggestion limit reached.") {
        msg = `Bu ankette en fazla ${maxPerUser || env.suggestionMaxPerUser} oneri verebilirsin.`;
      }
      await ack({
        response_action: "errors",
        errors: { suggestion_line: msg },
      });
      return;
    }

    await ack();
    if (replyChannel && uid) {
      const usedAfter = pollService.getUserSuggestionCount({ pollId: poll.id, userId: uid });
      const limitHint =
        maxPerUser > 0 ? ` (*${usedAfter}/${maxPerUser}*)` : "";
      try {
        await client.chat.postEphemeral({
          channel: replyChannel,
          user: uid,
          text: `Onerin alindi: *${parsed.displayName}*${limitHint}`,
        });
      } catch (err) {
        logger.error("suggestion_submit ephemeral failed", { error: err.message });
      }
    }
  });
}

async function deliverCreatorSuggestionSetup({ client, poll }) {
  const suggestions = pollService.listSuggestions(poll.id);
  const blocks = creatorSuggestionControlBlocks(poll, suggestions, pollService.MAX_OPTIONS);
  const text = `${poll.title} — oneri toplama suresi bitti. Oylama listesini sec.`;
  const delivered = { dm: false, ephemeral: false, channel: false };

  try {
    const im = await client.conversations.open({ users: poll.creator_id });
    if (im.ok && im.channel?.id) {
      await client.chat.postMessage({
        channel: im.channel.id,
        text,
        blocks,
      });
      delivered.dm = true;
    } else {
      logger.warn("Suggestion-end DM: conversations.open not ok", {
        pollId: poll.id,
        creatorId: poll.creator_id,
        error: im.error,
      });
    }
  } catch (err) {
    logger.warn("Suggestion-end DM failed", { pollId: poll.id, error: err.message });
  }

  try {
    await client.chat.postEphemeral({
      channel: poll.channel_id,
      user: poll.creator_id,
      text,
      blocks,
    });
    delivered.ephemeral = true;
  } catch (err) {
    logger.warn("Suggestion-end ephemeral failed", { pollId: poll.id, error: err.message });
  }

  if (!delivered.dm) {
    try {
      await client.chat.postMessage({
        channel: poll.channel_id,
        text: `<@${poll.creator_id}> ${text}`,
        blocks: creatorSuggestionControlBlocks(poll, suggestions, pollService.MAX_OPTIONS, {
          mentionUserId: poll.creator_id,
        }),
      });
      delivered.channel = true;
    } catch (err) {
      logger.error("Suggestion-end channel fallback failed", { pollId: poll.id, error: err.message });
    }
  }

  if (!delivered.dm && !delivered.ephemeral && !delivered.channel) {
    throw new Error("Could not deliver suggestion-end controls (DM, ephemeral, and channel all failed)");
  }

  logger.info("Suggestion-end controls delivered", {
    pollId: poll.id,
    channelId: poll.channel_id,
    suggestionCount: suggestions.length,
    ...delivered,
  });
  return delivered;
}

async function closeSuggestionPhaseAndNotify({ app, poll }) {
  const suggestions = pollService.listSuggestions(poll.id);
  if (suggestions.length < 2) {
    if (!pollService.tryClaimSuggestionPhaseClose(poll.id) && poll.phase === "suggestion") {
      return;
    }
    pollService.closePoll(poll.id);
    await notifyPollClosedInsufficientSuggestions({ app, poll, count: suggestions.length });
    return;
  }

  if (poll.phase === "suggestion") {
    if (!pollService.tryClaimSuggestionPhaseClose(poll.id)) {
      const fresh = pollService.getPollById(poll.id);
      if (fresh && ["suggestion", "ready_for_voting"].includes(fresh.phase)) {
        await deliverCreatorSuggestionSetup({ client: app.client, poll: fresh });
      }
      return;
    }
  }

  await deliverCreatorSuggestionSetup({ client: app.client, poll });
  if (poll.phase === "suggestion") {
    pollService.markSuggestionClosed(poll.id);
  }
}

async function notifySuggestionPhaseEnded({ app, poll }) {
  await deliverCreatorSuggestionSetup({ client: app.client, poll });
}

async function notifyPollClosedInsufficientSuggestions({ app, poll, count }) {
  try {
    await app.client.chat.postEphemeral({
      channel: poll.channel_id,
      user: poll.creator_id,
      text:
        `*${poll.title}* — oneri suresi bitti; oylama icin en az *2* oneri gerekir, gelen: *${count}*. ` +
        `Anket otomatik kapatildi. Yeni anket: \`/unico-poll Baslik | 48h\``,
    });
  } catch (error) {
    logger.error("Failed to notify insufficient suggestions close", {
      pollId: poll.id,
      error: error.message,
    });
  }
}

module.exports = {
  registerCommands,
  notifySuggestionPhaseEnded,
  notifyPollClosedInsufficientSuggestions,
  deliverCreatorSuggestionSetup,
  closeSuggestionPhaseAndNotify,
};
