# Unico Poll — PM komut referansi

Bu dosya **hangi komut / metin ne is yapar** ozetidir (teknik kurulum yok). Sunucu veya `.env` ayarlari icin `README.md` dosyasina bakin (workspace yoneticileri).

---

## Slash komutu: `/unico-poll`

Kanalda yazilir; **o kanalda** anket acar veya kapatir. Ayni kanalda ayni anda tek aktif anket olabilir.

| Ne yazilir | Ne olur |
|------------|---------|
| `/unico-poll` | Varsayilan baslik (*Unico Poll*), varsayilan oneri suresi ile **oneri toplama** anketi baslar. |
| `/unico-poll Baslik` | Baslik *Baslik* olan oneri toplama anketi. Sure varsayilan. |
| `/unico-poll Baslik \| 48h` | Baslik *Baslik*, oneri suresi **48 saat** (`1h` … `336h` araligi; `48 hours` gibi yazim da sayilir). |
| `/unico-poll Baslik \| direkt` veya `\| onersiz` / `\| kanalsiz` / `\| no-suggestions` | Kanalda **oneri toplamaz**. Yonetici once **komut cevabinda** (yalnizca kendine gorunen) *Secenekleri gir* ile modal acar; istenirse ayrica bota **DM** ile ayni dugme gider. DM mumkun degilse kanalda yalnizca olusturucuyu etiketleyen yedek mesajda dugme olur. **Oylama** ancak secenekler kaydedilince kanala duser. Istege bagli sure: or. `\| 24h direkt`. |
| `/unico-poll iptal` veya `/unico-poll cancel` | Bu kanaldaki **aktif anketi** kapatir. **Yalnizca anketi baslatan** kullanici yapabilir. |

**Baslik kurali:** `|` (pipe) **oncesi** metin anket basligidir. Ornek: `/unico-poll Yaz Turnuvasi \| 48h` → baslik *Yaz Turnuvasi*.

---

## Slash olmayan kanal davranisi (bilgi)

| Ne yapilir | Ne olur |
|------------|---------|
| Kanala **normal mesaj** (slash ile baslamayan) | Sadece anket **oneri fazindaysa** mesaj, kurallara uygunsa **oneri** olarak kaydedilir (format: `Isim` veya `Isim : PM kodu ; not`). |

---

## Slack arayuzundeki dugmeler (slash degil; PM ozeti)

Kullanicilarin gordugu ana tetikleyiciler:

| Gorunen aksiyon | Kime | Ne yapar |
|-----------------|------|----------|
| Secenekleri gir (yonetici) | Anketi acan | **Direkt modda:** slash cevabinda (ephemeral), bota DM veya (DM yoksa) kanalda yalnizca sana gorunen/etiketli mesajdaki dugme. Tiklayinca oylama secenekleri + tur (klasik / puanlama, acik/kapali oy) modal ile girilir. |
| Oylama listesini sec | Anketi acan | Oneri suresi bitince gelen listeden oylamaya girecekleri secer, oylamayi baslatir. |
| Kanaldaki oy dugmeleri / modallar | Katilimcilar | Oy veya puan verir. |
| Oylarini gor | Katilimci | Oylama kapandiktan sonra **kendi** oyunu salt okunur gosterir. |
| Sonuclari Kanala Yayinla | Anketi acan | Final sonuclarini **kanala** bir kez yayinlar (tekrar tiklamada engellenir). |
| Run-off baslat (ilk 3) | Anketi acan | **Istege bagli.** Sonuc ozetinde en az 2 secenek varken gorunur; tiklayinca mevcut siralamadaki *ilk 3* ile yeni oylama anketi acilir. Kanala yayinlamadan once veya sonra kullanilabilir. |

**Not:** *Acik oy* (oy verenin kanalda kisa **ayri mesaj** olarak gorunmesi) yalnizca **klasik (tek oy)** modunda secilebilir. **Puanlama (1-5)** modunda oy her zaman kapalidir.

**Kanal sonuclari:** *Sonuclari Kanala Yayinla* sonunda *Kazanan* satirinda en yuksek skora sahip **tum** adaylar yazilir (beraberlikte or. *Ahmet — Kemal*).

---

*Dosya: Unico Poll uygulamasinin mevcut davranisina gore uretilmistir.*
