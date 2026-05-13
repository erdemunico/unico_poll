# Unico Poll (Slack Bolt + Node.js + JSON store)

Unico Poll, Slack uzerinde **oneri toplama** ve **oylamayi** ayiran bir akistir:
- **1. asama (istege bagli):** Kanalda serbest metinle oneri toplanir; `direkt` / `onersiz` ile bu adim atlanip secenekler yalniz yonetici tarafindan girilir.
- **2. asama:** Anketi acan kullanici hangi onerilerin oylamaya girecegini secer (kanal oneri modunda); direkt modda bu adim modal ile birlestirilir.
- **3. asama:** Oylama ve sonuclar; gerekirse run-off.

Kanal mesajinda gorunen **baslik**, `/unico-poll` komutunda `|` karakterinden once yazdigin metindir. Ornek: `/unico-poll Test | 1h` → baslik *Test*.

## Oylama turu ve acik oy

- **Klasik (tek oy):** Katilimci tek secenek secer. Istersen *acik oy* secilebilir: oy veren kisi kanalda kisa bir bildirimle gorunur (spam riski dusuk).
- **Puanlama (1-5):** Her secenek ayri puanlanir; **acik oy secenegi yoktur** — oy her zaman kapalidir. Kanala secenek basina puan dokulmesi pratik olmadigi icin bu modda acik oy desteklenmez.

## 1) Project Structure

```text
unico-poll/
  .env.example
  .gitignore
  package.json
  README.md
  PM_KOMUTLAR.md
  data/
    .gitkeep
  src/
    index.js
    config/env.js
    db/store.js
    services/pollService.js
    services/scheduler.js
    slack/actions.js
    slack/blocks.js
    slack/commands.js
    utils/parser.js
    utils/time.js
    utils/logger.js
```

## 2) package.json ve kurulum komutlari

```bash
cd unico-poll
npm install
copy .env.example .env
```

`.env` dosyasini doldurun (anket acanlar icin asgari alanlar):

```env
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_SIGNING_SECRET=your-signing-secret
SLACK_APP_TOKEN=xapp-your-app-token
PORT=3000
DATABASE_PATH=./data/unico-poll.db
DEFAULT_SUGGESTION_HOURS=48
DEFAULT_VOTING_HOURS=48
DEFAULT_RUNOFF_HOURS=24
FAST_TEST_MODE=false
FAST_TEST_MINUTES=5
SUGGESTION_RATE_LIMIT_COUNT=5
SUGGESTION_RATE_LIMIT_WINDOW_MINUTES=1
```

Not: `DATABASE_PATH` `.db` ile biterse veri otomatik olarak ayni konumda `unico-poll.json` dosyasina yazilir (Windows'ta derleme gerektirmez). Istersen dogrudan `./data/unico-poll.json` da kullanabilirsin.

Calistirma:

```bash
npm run dev
```

Hizli test modu icin:

```env
FAST_TEST_MODE=true
FAST_TEST_MINUTES=5
```

Bu mod aktifken suggestion/voting/run-off sureleri saat yerine belirtilen dakika ile otomatik ayarlanir. **Canliya cikarken** `.env` icinde `FAST_TEST_MODE=false` yap ve botu yeniden baslat.

Oneri spam korumasi icin:
- `SUGGESTION_RATE_LIMIT_COUNT`: pencere icindeki max oneriler
- `SUGGESTION_RATE_LIMIT_WINDOW_MINUTES`: pencere suresi (dakika)

### Workspace yoneticileri (opsiyonel kisit)

`/unico-poll` komutunu **sadece belirli Slack kullanicilarina** acmak istersen `.env` icinde:

```env
ALLOWED_CREATOR_IDS=U12345678,U87654321
```

Bos birakilir: kanal uyeleri (Slack uygulama izinlerine gore) komutu kullanabilir. Bu ayar **poll acanlari** degil, **workspace / bot yonetimini** ilgilendirir; komut ozeti icin `PM_KOMUTLAR.md` dosyasina bakman yeterli.

## 3) Slash command kullanimi

```text
/unico-poll Turnuva Ismi | 48h
/unico-poll Turnuva Ismi | direkt
```

- `|` oncesi metin kanalda gorunen **baslik**dir.
- Kanal oneri modunda: `|` sonrasi `48h` gibi ifade oneri toplama suresidir (varsayilan `.env` de kullanilabilir).
- **Onerisiz / direkt:** `|` sonrasina `direkt`, `onersiz`, `kanalsiz` veya `no-suggestions` yazarsan kanalda oneri toplanmaz. Kanal uyeleri oylama mesajini **gormeden once** yonetici secenekleri girer: komut cevabinda (yalnizca sana gorunen) *Secenekleri gir* dugmesi gelir; ayrica bota **DM** (tercih) ve DM acilmazsa kanalda yalnizca seni etiketleyen yedek mesaj kullanilabilir. Oylama baslayinca `<!channel>` ile kanal duyurusu normal sekilde yapilir. Ornek: `/unico-poll Lig maci | direkt`. `48h direkt` gibi yazsan bile direkt modda oneri suresi kullanilmaz.
- Katilimcilar kanala **tek satir** mesaj yazarak oneri verir; `:` yoksa tum satir oylamaya *cikarilabilecek* aday olarak kaydedilir.
- Istege bagli ayrintili format: `Oneri Ismi : PM kodu ; not` — oylamada gorunen kisim `:` oncesidir; sonrasi sadece kayit icindir.
- Aktif anketi **yalnizca baslatan** kapatabilir: `/unico-poll iptal` veya `/unico-poll cancel` (`|` kullanma).
- Oneri suresi bitince **2'den az** oneri varsa anket otomatik kapanir; kanal blokta kalmaz.

## 4) Veri modeli (tek JSON dosyasi)

`data/unico-poll.json` icinde koleksiyonlar:

- `polls`: anket temel bilgileri ve faz/sure alanlari
- `suggestions`: ham yazi + gorunen isim + pm keyword + extra
- `poll_shortlist`: ankete girecek secenekler (max 10)
- `votes_classic`: klasik oylar
- `votes_rating`: 1-5 puanlar

## 5) Slack app gerekli izinleri

- OAuth scopes: `commands`, `chat:write`, `chat:write.public`, `channels:history`, `groups:history`, `im:history`, `im:write`, `mpim:history` (`im:write` direkt modda kurulum icin bota DM acmak icin; yoksa yedek kanal mesaji kullanilir.)
- Slash command: `/unico-poll`
- Event subscription: `message.channels`, `message.groups`

**Kanala ekleme:** Uygulama workspace'e bir kez yuklendikten sonra uyeler genelde `/invite @UnicoPoll` (veya bot adin ne ise) ile botu kanala davet edebilir; bunu Slack workspace yonetimi engellemiyorsa herkes yapabilir. Dagitim icin Slack App ayarlarinda **Manage Distribution** / Install adimlarini tamamlaman gerekir.

## 6) Git commit ve push

```bash
cd unico-poll
git add -A
git commit -m "Describe your change"
git push
```
