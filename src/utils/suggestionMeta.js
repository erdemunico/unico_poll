/** Sonuc satirlari: yalnizca oylamada gorunen kisa isim + skor (PM/not yok). */
function formatPollResultRowMrkdwn(r, rank) {
  return `*${rank}.* ${r.display_name} - ${r.score}`;
}

/** En yuksek skora sahip tum adaylar (beraberlikte hepsi). */
function formatWinnersLabel(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return "Yok";
  }
  const top = Number(results[0].score);
  if (!Number.isFinite(top)) {
    return results[0].display_name || "Yok";
  }
  const tied = results.filter((r) => Number(r.score) === top);
  if (tied.length === 0) {
    return "Yok";
  }
  return tied.map((r) => r.display_name).join(" — ");
}

module.exports = {
  formatPollResultRowMrkdwn,
  formatWinnersLabel,
};
