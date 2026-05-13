const { parseHoursArg, parseSuggestionInput, parseSkipChannelSuggestions, stripSkipChannelKeywords } = require("../utils/parser");
const { collectCreatorCandidateIds } = require("../utils/slackActor");
const { isPastIso } = require("../utils/time");
const env = require("../config/env");
const pollService = require("../services/pollService");
const logger = require("../utils/logger");
const {
  suggestionAnnouncementBlocks,
  directPollCreatorDmBlocks,
  directPollCreatorFallbackChannelBlocks,
  creatorSuggestionControlBlocks,
  buildSuggestionModal,
} = require("./blocks");

/** Bu subtype'lar kullanici onerisi degildir; digerlerinde metin varsa islenmeye calisilir. */
const IGNORED_MESSAGE_SUBTYPES = new Set([
  "bot_message",
  "message_changed",
  "message_deleted",
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_archive",
  "channel_unarchive",
  "pinned_item",
  "unpinned_item",
  "ekm",
  "file_share",
]);

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

      if (isCancelCommandText(command.text)) {
        const cancelResult = pollService.cancelActivePollInChannel({
          channelId,
          actingSlackUserIds,
        });
        if (!cancelResult.ok) {
          const msg =
            cancelResult.reason === "not_creator"
              ? "Bu kanaldaki aktif anketi yalnizca onu baslatan kullanici kapatabilir. Komut: `/unico-poll iptal`"
              : "Bu kanalda kapatilacak aktif anket yok.";
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
        logger.info("Poll cancelled via command", { pollId: cancelResult.poll.id, channelId, userId: creatorId });
        return;
      }

      const activePoll = pollService.getActivePollInChannel(channelId);
      if (activePoll) {
        await safeAck({
          response_type: "ephemeral",
          text:
            `Bu kanalda zaten aktif bir anket var: *${activePoll.title}* (${phaseDescriptionTr(
              activePoll.phase
            )}).\n` +
            `Yeni anket icin once mevcut anketi kapatin (yalnizca baslatan): \`/unico-poll iptal\` veya \`/unico-poll cancel\``,
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
          "Anket olusturuldu; *sen yoneticisin*. Kanaldaki mesaj *katilimcilara*: ne yazacaklari ve son tarih. " +
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

  app.message(async ({ message, client }) => {
    if (!message || !message.channel) {
      return;
    }
    if (message.subtype && IGNORED_MESSAGE_SUBTYPES.has(message.subtype)) {
      return;
    }
    const userId = message.user || message.user_id;
    const textRaw = message.text != null ? String(message.text) : "";
    const trimmed = textRaw.trim();
    if (!userId || !trimmed || trimmed.startsWith("/")) {
      return;
    }
    try {
      const poll = pollService.getActivePollInChannel(message.channel);
      if (!poll || poll.phase !== "suggestion") {
        return;
      }

      const parsed = parseSuggestionInput(message.text);
      if (!parsed) {
        return;
      }

      const windowMinutes = Math.max(1, env.suggestionRateLimitWindowMinutes);
      const limitCount = Math.max(1, env.suggestionRateLimitCount);
      if (env.suggestionRateLimitCount > 0) {
        const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
        const recentCount = pollService.getUserSuggestionCountSince({
          pollId: poll.id,
          userId,
          sinceIso: since,
        });
        if (recentCount >= limitCount) {
          logger.warn("Suggestion rate limit hit", {
            pollId: poll.id,
            userId,
            recentCount,
            limitCount,
            windowMinutes,
          });
          await client.chat.postEphemeral({
            channel: message.channel,
            user: userId,
            text: `Cok hizli oneride bulundun. Lutfen ${windowMinutes} dakika icinde en fazla ${limitCount} oneriyi gecme.`,
          });
          return;
        }
      }

      const result = pollService.addSuggestion({
        pollId: poll.id,
        userId,
        parsed,
      });

      if (!result.ok) {
        await client.chat.postEphemeral({
          channel: message.channel,
          user: userId,
          text:
            result.reason === "This suggestion already exists."
              ? "Bu isimde bir oneri zaten var; baska bir isim dene."
              : result.reason,
        });
        return;
      }

      await client.chat.postEphemeral({
        channel: message.channel,
        user: userId,
        text: `Onerin alindi: *${parsed.displayName}*`,
      });
    } catch (error) {
      logger.error("Suggestion processing failed", {
        userId: message.user || message.user_id,
        channelId: message.channel,
        error: error.message,
      });
    }
  });

  app.action("open_suggestion_modal", async ({ ack, body, client }) => {
    await ack();
    const pollId = body.actions?.[0]?.value;
    const poll = pollService.getPollById(pollId);
    const channelId = body.channel?.id;
    const uid = body.user?.id;
    if (!poll || !channelId || !uid) {
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
        text: "Form acilamadi. Biraz sonra tekrar dene veya onerini kanalin *ana mesajina* tek satir yaz.",
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
          suggestion_line: "Bos olamaz. Ornek: Yaz Kampi veya Yaz Kampi : PM ; not",
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
      const msg =
        result.reason === "This suggestion already exists."
          ? "Bu isimde bir oneri zaten var."
          : result.reason;
      await ack({
        response_action: "errors",
        errors: { suggestion_line: msg },
      });
      return;
    }

    await ack();
    if (replyChannel && uid) {
      try {
        await client.chat.postEphemeral({
          channel: replyChannel,
          user: uid,
          text: `Onerin alindi: *${parsed.displayName}*`,
        });
      } catch (err) {
        logger.error("suggestion_submit ephemeral failed", { error: err.message });
      }
    }
  });
}

async function notifySuggestionPhaseEnded({ app, poll }) {
  try {
    const suggestions = pollService.listSuggestions(poll.id);
    await app.client.chat.postEphemeral({
      channel: poll.channel_id,
      user: poll.creator_id,
      text: "Oneri toplama suresi doldu.",
      blocks: creatorSuggestionControlBlocks(poll, suggestions, pollService.MAX_OPTIONS),
    });
  } catch (error) {
    logger.error("Failed to notify suggestion end", { pollId: poll.id, error: error.message });
  }
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
};
