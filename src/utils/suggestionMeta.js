/** Sonuc satirlari: yalnizca oylamada gorunen kisa isim + skor (PM/not yok). */
function formatPollResultRowMrkdwn(r, rank) {
  return `*${rank}.* ${r.display_name} - ${r.score}`;
}

module.exports = {
  formatPollResultRowMrkdwn,
};
