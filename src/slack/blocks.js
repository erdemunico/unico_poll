const { formatSlackDate } = require("../utils/time");
const { formatPollResultRowMrkdwn } = require("../utils/suggestionMeta");
const pollService = require("../services/pollService");

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
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `<!channel> *Unico Poll* — *${poll.title}*\n` +
          `*Ne yapacaksin?* Asagidaki *Oneri gonder (form)* dugmesini kullan **veya** bu kanala *slash yazmadan* ana mesaj olarak tek satir yaz.\n` +
          `*(Thread / yanit olarak yazma; bot ana mesajlari ve formu dinler.)*\n` +
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
          `• *Sadece isim:* \`Yaz Kampi\`\n` +
          `• *PM kodu + not (istege bagli):* \`Yaz Kampi : PM_KODU ; kisa aciklama\`\n` +
          `_\`:\` oncesi kisim oylamada gorunen isimdir; PM ve not zorunlu degil._`,
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
  const voteMode = voteModeFromPreserved(st);
  const intro = {
    type: "section",
    text: {
      type: "mrkdwn",
      text:
        `*${poll.title}* — *direkt oylama* secenekleri (en az *2*, en fazla *10*).\n` +
        `Her kutuya *tek satir* yaz (slash kullanma). Bos satirlar yok sayilir.\n` +
        `• *Sadece isim:* \`Yaz Kampi\`\n` +
        `• *PM + not (istege bagli):* \`Yaz Kampi : PM_KODU ; kisa aciklama\`\n` +
        `_\`:\` oncesi kisim oylamada gorunur; PM/not sadece kayit icin tutulur._`,
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
  blocks.push({
    type: "input",
    dispatch_action: true,
    block_id: "vote_mode",
    label: { type: "plain_text", text: "Oylama Turu" },
    element: {
      type: "static_select",
      action_id: "vote_mode_select",
      options: [
        { text: { type: "plain_text", text: "Klasik (tek oy)" }, value: "classic" },
        { text: { type: "plain_text", text: "Puanlama (1-5)" }, value: "rating" },
      ],
      initial_option:
        st.vote_mode?.vote_mode_select?.selected_option ||
        ({ text: { type: "plain_text", text: "Klasik (tek oy)" }, value: "classic" }),
    },
  });
  if (voteMode === "rating") {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "_Puanlamada oy gorunurlugu yalnizca *kapali*dir (her secenek icin ayri puan; kanalda acik oy secenegi yok)._",
        },
      ],
    });
  } else {
    blocks.push({
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
        initial_option:
          st.vote_privacy?.vote_privacy_select?.selected_option ||
          ({ text: { type: "plain_text", text: "Kapali (anonim - varsayilan)" }, value: "closed" }),
      },
    });
  }
  blocks.push({
    type: "input",
    block_id: "vote_duration",
    label: { type: "plain_text", text: "Oylama Suresi (saat)" },
    element: {
      type: "plain_text_input",
      action_id: "vote_duration_input",
      initial_value: String(st.vote_duration?.vote_duration_input?.value || "48").trim() || "48",
    },
  });

  return {
    type: "modal",
    callback_id: "direct_ballot_submit",
    private_metadata: JSON.stringify({ pollId: poll.id, channelId: poll.channel_id }),
    title: { type: "plain_text", text: "Direkt oylama" },
    submit: { type: "plain_text", text: "Oylamayi baslat" },
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
          `Asagida toplanan oneriler listelenir. *Oylama listesini sec* ile acilan ekranda *10 siraya* kadar: ` +
          `onerilerden secim ve/veya *yeni secenek metni* girebilirsin (en az 2 secenek).`,
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

  const footerVoteMode = voteModeFromPreserved(st);

  blocks.push({
    type: "input",
    dispatch_action: true,
    block_id: "vote_mode",
    label: { type: "plain_text", text: "Oylama Turu" },
    element: {
      type: "static_select",
      action_id: "vote_mode_select",
      options: [
        { text: { type: "plain_text", text: "Klasik (tek oy)" }, value: "classic" },
        { text: { type: "plain_text", text: "Puanlama (1-5)" }, value: "rating" },
      ],
      initial_option:
        st.vote_mode?.vote_mode_select?.selected_option ||
        ({ text: { type: "plain_text", text: "Klasik (tek oy)" }, value: "classic" }),
    },
  });
  if (footerVoteMode === "rating") {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "_Puanlamada oy gorunurlugu yalnizca *kapali*dir (kanalda acik oy secenegi yok)._",
        },
      ],
    });
  } else {
    blocks.push({
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
        initial_option:
          st.vote_privacy?.vote_privacy_select?.selected_option ||
          ({ text: { type: "plain_text", text: "Kapali (anonim - varsayilan)" }, value: "closed" }),
      },
    });
  }
  blocks.push({
    type: "input",
    block_id: "vote_duration",
    label: { type: "plain_text", text: "Oylama Suresi (saat)" },
    element: {
      type: "plain_text_input",
      action_id: "vote_duration_input",
      initial_value: String(st.vote_duration?.vote_duration_input?.value || "48").trim() || "48",
    },
  });

  return {
    type: "modal",
    callback_id: "start_voting_submit",
    private_metadata: JSON.stringify({ pollId: poll.id, channelId: poll.channel_id }),
    title: { type: "plain_text", text: "Unico Poll" },
    submit: { type: "plain_text", text: "Oylamayi Baslat" },
    close: { type: "plain_text", text: "Iptal" },
    blocks,
  };
}

function votingBlocks({ poll, suggestions }) {
  const isClassic = String(poll.vote_mode || "").trim().toLowerCase() === "classic";
  const isOpenClassic = pollService.isOpenVotePoll(poll);
  const visibilityLine = !isClassic
    ? "Oy gorunurlugu: *kapali* — puanlama modunda acik oy yok (kanal sismesin diye)."
    : isOpenClassic
      ? "Oy gorunurlugu: *acik* — oy kullananlar kanalda kisa bir bildirimle gorunur."
      : "Oy gorunurlugu: *kapali* — ara sonuclar gizlidir; yalnizca kendi oyunu gorursun.";
  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${poll.title}* oylamasi acik.\nBitis: ${formatSlackDate(poll.voting_deadline_at)}\n${visibilityLine}`,
      },
    },
  ];

  if (isClassic) {
    // Slack: action_id must be unique within the whole message (duplicate -> invalid_blocks).
    blocks.push({
      type: "actions",
      block_id: `classic_vote_${poll.id}`,
      elements: suggestions.slice(0, 5).map((s) => ({
        type: "button",
        text: { type: "plain_text", text: s.display_name.slice(0, 75) },
        action_id: `classic_vote__${poll.id}__${s.id}`,
        value: JSON.stringify({ pollId: poll.id, suggestionId: s.id }),
      })),
    });
    if (suggestions.length > 5) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: "_Tum secenekler icin acilan modal ekranini kullanin._" },
        accessory: {
          type: "button",
          text: { type: "plain_text", text: "Tum Secenekleri Ac" },
          action_id: "open_classic_vote_modal",
          value: poll.id,
        },
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
          `*${poll.title}* — oylama *kapandi*.\n` +
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
  const winner = results[0];
  const lines = results.map((r, idx) => formatPollResultRowMrkdwn(r, idx + 1));
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${poll.title}* sonuclari yayinlandi.` },
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
          text: `Kazanan: *${winner ? winner.display_name : "Yok"}*`,
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
            `Ornek: \`Yaz Kampi\` veya \`Yaz Kampi : PM123 ; kisa not\``,
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
  creatorSuggestionControlBlocks,
  buildStartVotingModal,
  votingBlocks,
  votingClosedBlocks,
  buildClassicVoteModal,
  buildRatingModal,
  creatorResultsBlocks,
  channelResultsBlocks,
  SLOT_MODE_SKIP,
};
