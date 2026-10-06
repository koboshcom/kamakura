# Kamakura

An original sleepy shrine cat for iMessage and WhatsApp, using OpenAI Responses through the Vercel AI SDK. Edit `persona.md`, then restart to change its personality.

## Architecture

`docker compose` runs one core service containing the brain and Baileys WhatsApp client. Named volumes keep WhatsApp credentials and chat data across restarts. The image installs ffmpeg.

iMessage does **not** run in Docker. A small Node process on the Mac polls `~/Library/Messages/chat.db` and sends with Messages.app via AppleScript. It uploads messages/media over authenticated HTTP to the core and polls for outgoing replies. Only the Mac host sees chat.db or invokes osascript. No Messages folder mount is needed.

The core's HTTP port is published to `127.0.0.1` only. Do not expose it publicly. `BRIDGE_TOKEN` protects both directions, even on localhost.

## Quick start on an M1 Mac

Install Docker Desktop and Node 24+. Sign in to Messages on the Apple ID the bot should use. A dedicated bot Apple ID and spare WhatsApp number are recommended.

```sh
cp .env.example .env
openssl rand -hex 32
```

Put the random output into `BRIDGE_TOKEN`. Set `OPENAI_API_KEY` and enable the transports you want. The model defaults to `gpt-5.4-mini`; change `OPENAI_MODEL` if your account uses another Responses model with vision and tool support.

Chat allowlists are required. An empty list accepts nobody. `IMESSAGE_ALLOWED_CHATS` and `WHATSAPP_ALLOWED_CHATS` take comma-separated exact chat IDs. `*` accepts everyone, so only use it intentionally on a dedicated bot account with participants' consent. Their messages and media are sent to OpenAI.

```sh
docker compose up --build -d
docker compose logs -f core
```

Enable WhatsApp with `ENABLE_WHATSAPP=true`, then scan the QR in the logs from WhatsApp > Linked devices. Ignored chats log their IDs; copy the intended ones into `WHATSAPP_ALLOWED_CHATS`, then recreate the core with `docker compose up -d`. WhatsApp's newer linked-device IDs can use `@lid` rather than a phone number, so copy the actual logged value.

Baileys is unofficial. WhatsApp may ban accounts using unofficial clients. Use a spare number. The auth volume is a login credential, not a disposable cache.

## iMessage host bridge

For iMessage, set `ENABLE_IMESSAGE=true` and use the same `.env` in the host folder and core. Compose sets the core's bind address automatically. On the host, keep `BRIDGE_URL=http://127.0.0.1:47621` and `BRIDGE_HOST=127.0.0.1`.

```sh
npm ci
npm run build
npm run chats
```

Put the chosen IDs from `npm run chats` into `IMESSAGE_ALLOWED_CHATS`. Then run:

```sh
npm run imessage:host
```

Give Terminal/iTerm Full Disk Access under System Settings > Privacy & Security. For launchd, the Node executable itself may also need Full Disk Access. Accept the Automation prompt allowing control of Messages, or enable it under Privacy & Security > Automation. Run once interactively before installing launchd to trigger permissions.

On first start, old iMessages are skipped. The host stores a polling cursor in its local `data/`; keep this separate from the Docker memory volume. Images, downloaded video attachments, and voice clips are uploaded from the host. Attachments not yet downloaded by Messages are skipped with a log message.

Edit `deploy/dev.kamakura.bot.plist` to use the paths from `which node` and your checkout. It runs **only the iMessage host bridge**, not a second core. Create the local `data/` directory, then:

```sh
mkdir -p data ~/Library/LaunchAgents
cp deploy/dev.kamakura.bot.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.kamakura.bot.plist
```

Keep the Mac awake and Docker Desktop running. A closed/sleeping laptop cannot poll Messages. The compose service uses `restart: unless-stopped`; a launch agent starts after login.

For an all-host setup without Docker, install ffmpeg (`brew install ffmpeg`), set `IMESSAGE_USE_BRIDGE=false`, and run the core directly with `npm run dev` or `npm start`. `npm start` needs `npm run build` first. Do not run the standalone iMessage host simultaneously in this mode.

## Features and stored data

Recent history lives in `data/history.json`, normally 40 messages per chat. A 4-second trailing debounce groups quick texts. Responses can stay silent, react on WhatsApp, or split into short paced messages.

Long-term facts are individual JSON files in `data/facts`. The model can add/remove confirmed facts with `remember_fact`. Personal facts are scoped to the current sender within the current chat, not leaked into unrelated chats. Shared facts belong to the chat. Ask Kamakura to forget a fact to remove it. Existing facts are given to the model as data, never privileged instructions.

`web_search` is OpenAI's built-in Responses search tool, enabled by default. Results include source links. Turn it off with `ENABLE_WEB_SEARCH=false`.

Photos are resized and passed to the model. HEIC/HEIF images are decoded to JPEG. Videos provide 1 frame per second from the first 20 seconds, at most 20 frames, plus audio transcription. The limit is explicit in the model context; it is not full-video understanding. Voice notes are transcribed up to 5 minutes by default. Change `VIDEO_MAX_SECONDS` (maximum 20), `AUDIO_MAX_SECONDS`, and `TRANSCRIPTION_MODEL` as needed. Media input is limited to 20 MiB per attachment and four attachments per batch by default. Raw images/video are held only during that response, not stored in history. Later questions may require reattaching the file. View-once WhatsApp media is not processed.

Reminders use SQLite at `data/reminders.sqlite`. The model can schedule, list, and cancel one-time reminders for the current sender/chat. Due times are ISO timestamps with explicit offsets, within the next year; there is no recurring-reminder support. Overdue reminders fire after a restart. Reminders are claimed before sending to avoid duplicate sends after an uncertain result. A crash or connection failure during sending can lose a reminder; it will not be automatically resent. This is a convenience bot, not a critical alarm system.

The iMessage outgoing HTTP queue claims each reply once. A disconnect while polling or sending can lose an outgoing reply rather than resend it at the bridge level. The underlying iMessage SDK has its own AppleScript retry behavior, so this is not a guarantee of exactly-once delivery at Messages.app.

## Privacy and security

Keep `.env`, local `data/`, and Docker volumes private. The build context excludes credentials. History, facts, reminders, and WhatsApp auth persist until you remove them. `docker compose down` preserves volumes; `docker compose down -v` destroys them.

Messages/media are sent to OpenAI with Responses storage disabled (`store: false`). Transcription is a separate API call. This setting is not a promise of zero provider retention. Chat IDs can appear in logs, but message contents and API keys are not deliberately logged.

The compose container is unprivileged, read-only except named volumes and bounded `/tmp`, with dropped capabilities and CPU/memory limits. It does not need Docker socket access. Media parsers handle untrusted bytes, so keep ffmpeg/image dependencies updated. HEIC decoding uses JS/WASM; image pixel limits are enforced during resizing but conversion itself can still be resource-intensive. Do not treat model text or uploaded files as safe code.

## Checks

```sh
npm run check
npm test
npm run build
```

Eight tests cover reply controls, fact scoping/persistence, reminder ownership/persistence/delivery, JPEG resizing, silent-video frame extraction, and bridge authentication/allowlists/deduplication/outgoing claims. Live OpenAI, WhatsApp, macOS permissions, HEIC sample decoding, and Docker execution require integration testing with real credentials/devices. No live chats were sent during the build.
