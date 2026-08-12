const { formatSlackDate } = require("../utils/time");
const { formatPollResultRowMrkdwn, formatWinnersLabel } = require("../utils/suggestionMeta");
const pollService = require("../services/pollService");
const env = require("../config/env");

/** static_select value: bu sirayi kullanma */
const SLOT_MODE_SKIP = "__mode_skip__";
const SLACK_OPTION_PLAIN_TEXT_MAX = 75;

/** Oylama listesi modalinda: tam oneri satiri (PM/not dahil); Slack plain_text max 75. */
function shortlistPickOptionPlainText(s) {
  const full = String(s.raw_text || s.display_name || "")
    .replace(/\s+/g, " ")
    .trim();
  const base = full || String(s.display_name || "?").trim();
  if (base.length <= SLACK_OPTION_PLAIN_TEXT_MAX) {
    return base || "?";
  }
  return `${base.slice(0, SLACK_OPTION_PLAIN_TEXT_MAX - 1)}…`;
}

function shortlistModeSelectOptions() {
  return [
    { text: { type: "plain_text", text: "(bos)" }, value: SLOT_MODE_SKIP },
    { text: { type: "plain_text", text: "Onerilerden sec" }, value: "list" },
    { text: { type: "plain_text", text: "Elle yaz" }, value: "manual" },
  ];
}

function initialModeOptionForRow(preservedValues, rowIndex) {
  const v =
    preservedValues?.[`slot_mode_${rowIndex}`]?.[`slot_mode_${rowIndex}_select`]?.selected_option?.value ||
    SLOT_MODE_SKIP;
  const opts = shortlistModeSelectOptions();
  return opts.find((o) => o.value === v) || opts[0];
}

function voteModeFromPreserved(st) {
  return st?.vote_mode?.vote_mode_select?.selected_option?.value === "rating" ? "rating" : "classic";
}

function suggestionAnnouncementBlocks(poll) {
  const maxPerUser = Math.max(1, env.suggestionMaxPerUser || 5);
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `<!channel> *Unico Poll* — *${poll.title}*\n` +
          `*Ne yapacaksin?* Asagidaki *Oneri gonder (form)* dugmesine basarak onerini gonder.\n` +
          `Her kisi en fazla *${maxPerUser}* oneri verebilir.\n` +
          `*Son oneri zamani:* ${formatSlackDate(poll.suggestion_deadline_at)}`,
      },
    },
    {
      type: "actions",
      block_id: `suggestion_open_modal_${poll.id}`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Oneri gonder (form)" },
          action_id: "open_suggestion_modal",
          value: poll.id,
          style: "primary",
        },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*Oneri nasil yazilir?*\n` +
          `• *Sadece oyun ismi:* \`Onerilen Oyun ismi\`\n` +
          `• *Isim + not (istege bagli):* \`Onerilen Oyun ismi : Isminiz ; Varsa notunuz\`\n` +
          `_\`:\` oncesi kisim oylamada gorunen oyun ismidir; isminiz ve not zorunlu degil._`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text:
            "Oneri suresi bitince *yonetici* hangi onerilerin oylamaya girecegini ayri olarak secer; bu mesajda liste yok.",
        },
      ],
    },
  ];
}

/**
 * Direkt anket: secenek giris dugmesi.
 * @param {"dm"|"channel_ephemeral"} variant — alt satir metni (DM mi, kanalda gizli bildirim mi).
 */
function directPollCreatorDmBlocks(poll, pollChannelId, variant = "dm") {
  const isEphemeral = variant === "channel_ephemeral";
  const foot = isEphemeral
    ? "_Bu blok kanalda yalnizca sana gorunur; modal yalnizca anketi acan kullaniciya acilir._"
    : "_Bu konusma yalnizca sana; modal yalnizca anketi acan kullaniciya acilir._";
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*Unico Poll — direkt oylama*\n` +
          `*${poll.title}*\n` +
          `Hedef kanal: <#${pollChannelId}>\n` +
          `Kanal uyeleri *oylama mesajini* ancak asagidan secenekleri girip oylamayi baslattiginda gorur.`,
      },
    },
    {
      type: "actions",
      block_id: `direct_ballot_open_${poll.id}`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Secenekleri gir (yonetici)" },
          action_id: "open_direct_ballot_modal",
          value: poll.id,
          style: "primary",
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: foot,
        },
      ],
    },
  ];
}

/** DM basarisiz olursa: <!channel> yok; yalnizca olusturucu mention. */
function directPollCreatorFallbackChannelBlocks(poll, creatorId) {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `<@${creatorId}> *Unico Poll — direkt oylama*\n` +
          `*${poll.title}*\n` +
          `Bot sana *ozel mesaj (DM)* atamadi; bu yuzden secenek girisi bu mesajda. ` +
          `Oylama basladiginda kanal ayri bir mesajla duyurulur.`,
      },
    },
    {
      type: "actions",
      block_id: `direct_ballot_open_${poll.id}`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Secenekleri gir (yonetici)" },
          action_id: "open_direct_ballot_modal",
          value: poll.id,
          style: "primary",
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "_Dugmeye baska kullanicilar bassa da modal yalnizca anketi acan kisiye acilir._",
        },
      ],
    },
  ];
}

function directPollChannelBlocks(poll) {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `<!channel> *Unico Poll* — *${poll.title}*\n` +
          `Bu ankette *kanalda oneri toplama yok*. ` +
          `Asagidaki dugmeyi *yalnizca anketi baslatan kisi* kullanarak oylama seceneklerini gir.`,
      },
    },
    {
      type: "actions",
      block_id: `direct_ballot_open_${poll.id}`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Secenekleri gir (yonetici)" },
          action_id: "open_direct_ballot_modal",
          value: poll.id,
          style: "primary",
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "_Dugme herkese gorunur; modal yalnizca anketi acan kullaniciya acilir._",
        },
      ],
    },
  ];
}

function buildDirectBallotModal({ poll, preservedValues = null }) {
  const st = preservedValues || {};
  const intro = {
    type: "section",
    text: {
      type: "mrkdwn",
      text:
        `*${poll.title}* — *direkt oylama* secenekleri (en az *2*, en fazla *10*).\n` +
        `Her kutuya *tek satir* yaz (slash kullanma). Bos satirlar yok sayilir.\n` +
        `• *Sadece oyun ismi:* \`Onerilen Oyun ismi\`\n` +
        `• *Isim + not (istege bagli):* \`Onerilen Oyun ismi : Isminiz ; Varsa notunuz\`\n` +
        `_\`:\` oncesi kisim oylamada gorunur; isim/not sadece kayit icin tutulur._`,
    },
  };

  const optionInputs = [];
  for (let i = 1; i <= 10; i += 1) {
    optionInputs.push({
      type: "input",
      optional: true,
      block_id: `direct_ballot_slot_${i}`,
      label: { type: "plain_text", text: `Secenek ${i}` },
      element: {
        type: "plain_text_input",
        action_id: `direct_ballot_slot_${i}_input`,
        multiline: false,
        max_length: 300,
      },
    });
  }

  const blocks = [intro, ...optionInputs];

  return {
    type: "modal",
    callback_id: "direct_ballot_options",
    private_metadata: JSON.stringify({ pollId: poll.id, channelId: poll.channel_id, flow: "direct" }),
    title: { type: "plain_text", text: "Adim 1 — Secenekler" },
    submit: { type: "plain_text", text: "Devam" },
    close: { type: "plain_text", text: "Iptal" },
    blocks,
  };
}

function creatorSuggestionControlBlocks(poll, suggestions, maxOptions) {
  const items = suggestions.map((s, idx) => `*${idx + 1}.* ${s.display_name}`).join("\n");
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*${poll.title}* — oneri toplama suresi bitti.\n` +
          `Asagida toplanan oneriler listelenir. *Oylama listesini sec* ile once oylama listesi, ` +
          `sonra sirasiyla *oylama turu*, *oy gorunurlugu* (klasik) ve *oylama suresi* adimlari gelir.`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: items || "_Henuz oneriler yok._",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `En fazla *${maxOptions}* secenek oylamaya alinabilir. ` +
          `Kanalda toplanan oneri sayisinin bir ust siniri yok; oylamaya hangilerinin girecegini sen belirlersin.`,
      },
      accessory: {
        type: "button",
        text: { type: "plain_text", text: "Oylama listesini sec" },
        action_id: "open_start_voting_modal",
        value: poll.id,
        style: "primary",
      },
    },
  ];
}

function buildStartVotingModal({ poll, suggestions, preservedValues = null }) {
  const maxInSelect = 90;
  const sliced = suggestions.slice(0, maxInSelect);
  const suggestionSelectOptions = [
    { text: { type: "plain_text", text: "(bos)" }, value: "__skip__" },
    ...sliced.map((s) => ({
      text: { type: "plain_text", text: shortlistPickOptionPlainText(s) },
      value: s.id,
    })),
  ];

  const st = preservedValues || {};

  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*Oylamaya girecek secenekler* (en az *2*, en fazla *10*; sira onemli).\n` +
          `Her sira icin *turu* sec: *(bos)* | *Onerilerden sec* | *Elle yaz*. Tur degistiginde form yenilenir; ` +
          `ayni anda hem liste hem yazi kutusu gorunmez.\n` +
          `_Onerilerden sec: tam gonderilen satir gorunur; oylama ekraninda yalnizca kisa isim gorunur._\n` +
          (suggestions.length > maxInSelect
            ? `_Oneri asamasinda ilk ${maxInSelect} secim listesinde; fazlasi icin Elle yaz kullan._\n`
            : "") +
          "_Ayni oneriyi iki sirada secemezsin._",
      },
    },
  ];

  for (let i = 1; i <= 10; i += 1) {
    const modeVal =
      st[`slot_mode_${i}`]?.[`slot_mode_${i}_select`]?.selected_option?.value || SLOT_MODE_SKIP;

    blocks.push({
      type: "input",
      dispatch_action: true,
      optional: true,
      block_id: `slot_mode_${i}`,
      label: { type: "plain_text", text: `Secim ${i} — turu` },
      element: {
        type: "static_select",
        action_id: `slot_mode_${i}_select`,
        options: shortlistModeSelectOptions(),
        initial_option: initialModeOptionForRow(st, i),
      },
    });

    if (modeVal === "list") {
      const pickRaw = st[`slot_pick_${i}`]?.[`slot_pick_${i}_select`]?.selected_option?.value;
      const initialPick =
        pickRaw && pickRaw !== "__skip__"
          ? suggestionSelectOptions.find((o) => o.value === pickRaw)
          : undefined;
      const pickBlock = {
        type: "input",
        optional: true,
        block_id: `slot_pick_${i}`,
        label: { type: "plain_text", text: `Secim ${i} — oneri` },
        element: {
          type: "static_select",
          action_id: `slot_pick_${i}_select`,
          placeholder: { type: "plain_text", text: "Oneri sec" },
          options: suggestionSelectOptions,
        },
      };
      if (initialPick) {
        pickBlock.element.initial_option = initialPick;
      }
      blocks.push(pickBlock);
    } else if (modeVal === "manual") {
      const tv = st[`slot_text_${i}`]?.[`slot_text_${i}_input`]?.value ?? "";
      const textBlock = {
        type: "input",
        optional: true,
        block_id: `slot_text_${i}`,
        label: { type: "plain_text", text: `Secim ${i} — metin` },
        element: {
          type: "plain_text_input",
          action_id: `slot_text_${i}_input`,
          multiline: false,
          max_length: 300,
        },
      };
      if (String(tv).trim().length > 0) {
        textBlock.element.initial_value = String(tv);
      }
      blocks.push(textBlock);
    }
  }

  return {
    type: "modal",
    callback_id: "start_voting_shortlist",
    private_metadata: JSON.stringify({ pollId: poll.id, channelId: poll.channel_id }),
    title: { type: "plain_text", text: "Adim 1 — Oylama listesi" },
    submit: { type: "plain_text", text: "Devam" },
    close: { type: "plain_text", text: "Iptal" },
    blocks,
  };
}

function buildVoteTypeWizardModal({ poll, wizardMeta }) {
  return {
    type: "modal",
    callback_id: "voting_wizard_type",
    private_metadata: JSON.stringify(wizardMeta),
    title: { type: "plain_text", text: "Adim 2 — Oylama turu" },
    submit: { type: "plain_text", text: "Devam" },
    close: { type: "plain_text", text: "Iptal" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `*${poll.title}*\n` +
            "Oylama turunu sec. Sonraki adimda (klasik secersen) oy gorunurlugu, en sonda oylama suresi sorulur.",
        },
      },
      {
        type: "input",
        block_id: "vote_mode",
        label: { type: "plain_text", text: "Oylama Turu" },
        element: {
          type: "static_select",
          action_id: "vote_mode_select",
          options: [
            { text: { type: "plain_text", text: "Klasik (tek oy)" }, value: "classic" },
            { text: { type: "plain_text", text: "Puanlama (1-5)" }, value: "rating" },
          ],
          initial_option: { text: { type: "plain_text", text: "Klasik (tek oy)" }, value: "classic" },
        },
      },
    ],
  };
}

function buildVotePrivacyWizardModal({ poll, wizardMeta }) {
  return {
    type: "modal",
    callback_id: "voting_wizard_privacy",
    private_metadata: JSON.stringify(wizardMeta),
    title: { type: "plain_text", text: "Adim 3 — Oy gorunurlugu" },
    submit: { type: "plain_text", text: "Devam" },
    close: { type: "plain_text", text: "Iptal" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `*${poll.title}* — *klasik oylama*\n` +
            "*Kapali:* ara sonuclar gizli, yalniz kendi oyunu gorursun.\n" +
            "*Acik:* oy kullananlar kanalda kisa bildirimle gorunur.",
        },
      },
      {
        type: "input",
        block_id: "vote_privacy",
        label: { type: "plain_text", text: "Oy Gorunurlugu" },
        element: {
          type: "static_select",
          action_id: "vote_privacy_select",
          options: [
            { text: { type: "plain_text", text: "Kapali (anonim - varsayilan)" }, value: "closed" },
            { text: { type: "plain_text", text: "Acik (kullanici secimi gorunebilir)" }, value: "open" },
          ],
          initial_option: {
            text: { type: "plain_text", text: "Kapali (anonim - varsayilan)" },
            value: "closed",
          },
        },
      },
    ],
  };
}

function buildVoteDurationWizardModal({ poll, wizardMeta }) {
  const isRating = String(wizardMeta.voteMode || "").trim().toLowerCase() === "rating";
  const stepLabel = isRating ? "Adim 3" : "Adim 4";
  return {
    type: "modal",
    callback_id: "voting_wizard_duration",
    private_metadata: JSON.stringify(wizardMeta),
    title: { type: "plain_text", text: `${stepLabel} — Oylama suresi` },
    submit: { type: "plain_text", text: "Oylamayi Baslat" },
    close: { type: "plain_text", text: "Iptal" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `*${poll.title}*\n` +
            (isRating
              ? "Puanlama modunda oy gorunurlugu *kapali*dir."
              : wizardMeta.privacy === "open"
                ? "Secim: *acik oy* (kanalda bildirim)."
                : "Secim: *kapali oy* (anonim).") +
            `\nOylama kac saat acik kalsin?`,
        },
      },
      {
        type: "input",
        block_id: "vote_duration",
        label: { type: "plain_text", text: "Oylama Suresi (saat)" },
        element: {
          type: "plain_text_input",
          action_id: "vote_duration_input",
          initial_value: String(env.defaultVotingHours),
        },
      },
    ],
  };
}

function votingBlocks({ poll, suggestions }) {
  const isClassic = String(poll.vote_mode || "").trim().toLowerCase() === "classic";
  const isOpenClassic = pollService.isOpenVotePoll(poll);
  const visibilityLine = !isClassic
    ? "Oy gorunurlugu: *kapali* — puanlama modunda acik oy yok."
    : isOpenClassic
      ? "Oy gorunurlugu: *acik* — oy kullananlar kanalda kisa bir bildirimle gorunur."
      : "Oy gorunurlugu: *kapali* — ara sonuclar gizlidir; yalnizca kendi oyunu gorursun.";
  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `<!channel> *${poll.title}* oylamasi acik.\n` +
          `Bitis: ${formatSlackDate(poll.voting_deadline_at)}\n${visibilityLine}`,
      },
    },
  ];

  if (isClassic) {
    // Slack: max 5 buttons per actions block; action_id must be unique in the message.
    // Chunk so all shortlist options (up to MAX_OPTIONS) appear as buttons, not only the first 5.
    const chunkSize = 5;
    for (let i = 0; i < suggestions.length; i += chunkSize) {
      const chunk = suggestions.slice(i, i + chunkSize);
      const chunkIndex = Math.floor(i / chunkSize);
      blocks.push({
        type: "actions",
        block_id: `classic_vote_${poll.id}_${chunkIndex}`,
        elements: chunk.map((s) => ({
          type: "button",
          text: { type: "plain_text", text: s.display_name.slice(0, 75) },
          action_id: `classic_vote__${poll.id}__${s.id}`,
          value: JSON.stringify({ pollId: poll.id, suggestionId: s.id }),
        })),
      });
    }
  } else {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Her secenegi 1-5 arasi puanlayin.",
      },
      accessory: {
        type: "button",
        text: { type: "plain_text", text: "Puanlama Ekranini Ac" },
        action_id: "open_rating_modal",
        value: poll.id,
        style: "primary",
      },
    });
  }

  return blocks;
}

function votingClosedBlocks({ poll }) {
  const showOpenFootnote = pollService.isOpenVotePoll(poll);
  const extra = showOpenFootnote ? "\n_Acik oy doneminde kanala dusen bildirimler kalir._" : "";
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `<!channel> *${poll.title}* — oylama *kapandi*.\n` +
          `Oylar artik degistirilemez. Asagidan yalnizca *kendi oylarini* gorursun (salt okunur).` +
          extra,
      },
    },
    {
      type: "actions",
      block_id: `my_votes_${poll.id}`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Oylarini gor" },
          action_id: "show_my_votes",
          value: poll.id,
        },
      ],
    },
  ];
}

function buildClassicVoteModal({ poll, suggestions }) {
  return {
    type: "modal",
    callback_id: "classic_vote_submit",
    private_metadata: JSON.stringify({ pollId: poll.id, channelId: poll.channel_id }),
    title: { type: "plain_text", text: "Tek Oy Kullan" },
    submit: { type: "plain_text", text: "Kaydet" },
    close: { type: "plain_text", text: "Iptal" },
    blocks: [
      {
        type: "input",
        block_id: "classic_vote_choice",
        label: { type: "plain_text", text: "Secimin" },
        element: {
          type: "static_select",
          action_id: "classic_vote_select",
          options: suggestions.map((s) => ({
            text: { type: "plain_text", text: s.display_name.slice(0, 75) },
            value: s.id,
          })),
        },
      },
    ],
  };
}

function buildRatingModal({ poll, suggestions }) {
  const blocks = suggestions.map((s) => ({
    type: "input",
    block_id: `rating_${s.id}`,
    label: { type: "plain_text", text: s.display_name.slice(0, 75) },
    element: {
      type: "static_select",
      action_id: "rating_value",
      options: [1, 2, 3, 4, 5].map((score) => ({
        text: { type: "plain_text", text: `${score} / 5` },
        value: String(score),
      })),
    },
  }));

  return {
    type: "modal",
    callback_id: "rating_vote_submit",
    private_metadata: JSON.stringify({ pollId: poll.id, channelId: poll.channel_id }),
    title: { type: "plain_text", text: "Puanlama" },
    submit: { type: "plain_text", text: "Kaydet" },
    close: { type: "plain_text", text: "Iptal" },
    blocks,
  };
}

function creatorResultsBlocks({ poll, results, close }) {
  const rows = results.map((r, i) => formatPollResultRowMrkdwn(r, i + 1)).join("\n");
  const showRunoff = Array.isArray(results) && results.length >= 2;

  const actionElements = [
    {
      type: "button",
      text: { type: "plain_text", text: "Sonuclari Kanala Yayinla" },
      style: "primary",
      action_id: "publish_results",
      value: poll.id,
    },
  ];

  if (showRunoff) {
    actionElements.push({
      type: "button",
      text: { type: "plain_text", text: "Run-off baslat (ilk 3)" },
      action_id: "start_runoff",
      value: poll.id,
    });
  }

  const blocks = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${poll.title}* sonucu hazir (creator-only).` },
    },
    { type: "section", text: { type: "mrkdwn", text: rows || "_Oy yok._" } },
  ];

  if (showRunoff) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: close
            ? "_Ilk iki skor birbirine yakin; run-off ozellikle mantikli olabilir. Zorunlu degil — kanala yayinlayip bitirebilirsin._"
            : "_Run-off: mevcut siralamadaki *ilk 3* secenekle yeni oylama acar. Istemezsen bu adimi atlayip yalnizca kanala yayinla._",
        },
      ],
    });
  }

  blocks.push({ type: "actions", elements: actionElements });

  return blocks;
}

function channelResultsBlocks({ poll, results }) {
  const winnersLabel = formatWinnersLabel(results);
  const lines = results.map((r, idx) => formatPollResultRowMrkdwn(r, idx + 1));
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `<!channel> *${poll.title}* sonuclari yayinlandi.` },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: lines.join("\n"),
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Kazanan: *${winnersLabel}*`,
        },
      ],
    },
  ];
}

function buildSuggestionModal({ poll }) {
  return {
    type: "modal",
    callback_id: "suggestion_submit",
    private_metadata: JSON.stringify({ pollId: poll.id, channelId: poll.channel_id }),
    title: { type: "plain_text", text: "Oneri gonder" },
    submit: { type: "plain_text", text: "Gonder" },
    close: { type: "plain_text", text: "Iptal" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `*${poll.title}* — *tek satir* (slash yazma).\n` +
            `Ornek: \`Onerilen Oyun ismi\` veya \`Onerilen Oyun ismi : Isminiz ; Varsa notunuz\`\n` +
            `_Bu ankette en fazla ${Math.max(1, env.suggestionMaxPerUser || 5)} oneri verebilirsin._`,
        },
      },
      {
        type: "input",
        block_id: "suggestion_line",
        label: { type: "plain_text", text: "Oneri metni" },
        element: {
          type: "plain_text_input",
          action_id: "suggestion_line_input",
          multiline: false,
          max_length: 300,
        },
      },
    ],
  };
}

module.exports = {
  suggestionAnnouncementBlocks,
  directPollChannelBlocks,
  directPollCreatorDmBlocks,
  directPollCreatorFallbackChannelBlocks,
  buildDirectBallotModal,
  buildSuggestionModal,
  buildVoteTypeWizardModal,
  buildVotePrivacyWizardModal,
  buildVoteDurationWizardModal,
  creatorSuggestionControlBlocks,
  votingBlocks,
  votingClosedBlocks,
  buildClassicVoteModal,
  buildRatingModal,
  creatorResultsBlocks,
  channelResultsBlocks,
  SLOT_MODE_SKIP,
};
