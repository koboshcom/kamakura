# Kamakura

Kamakura is a chat bot for iMessage and WhatsApp. It plays a sleepy shrine cat. Edit `persona.md` to change how it talks; restart the bot afterwards.

It uses the OpenAI Responses API through the Vercel AI SDK. It keeps the last 40 messages per chat in `data/history.json`, waits 4 seconds after the last message in a chat before replying, and can stay silent in groups.

## Setup

You need Node 24 or later on the Mac that will run the bot.

```sh
npm install
cp .env.example .env
npm run build
```

Put your key in `.env` as `OPENAI_API_KEY`. `OPENAI_MODEL` defaults to `gpt-5.4-mini`.

Turn transports on with `ENABLE_IMESSAGE=true` and `ENABLE_WHATSAPP=true`.

The bot only answers chats on its allowlist. An empty list means no chats. That is deliberate: without it, the bot would answer everyone who messages the Mac's Apple ID or the WhatsApp number, and send their messages to OpenAI.

## iMessage

Sign in to Messages on the Mac with the account the bot should use. A separate Apple ID is best, since the bot reads and writes as that account.

Give Full Disk Access to whatever runs Node (Terminal, iTerm, or the `node` binary for launchd) in System Settings > Privacy & Security > Full Disk Access. The bot reads `~/Library/Messages/chat.db` and needs it.

Run `npm run chats` to list recent chat IDs, then put the ones you want into `IMESSAGE_ALLOWED_CHATS`, separated by commas.

The first time the bot sends, macOS asks whether your terminal may control Messages. Allow it. If you missed it, turn it on in System Settings > Privacy & Security > Automation.

The bot polls the database every second. On first start it skips old messages.

## WhatsApp

This uses Baileys, an unofficial WhatsApp Web client. WhatsApp can ban numbers that use it. Use a spare number, not your own.

Set `ENABLE_WHATSAPP=true`, run `npm start` in a terminal, then scan the QR code from WhatsApp > Linked devices. The login is saved in `data/whatsapp-auth`. Keep that folder private; it is a login to the account. To log in again, delete it.

Messages from chats not on the list are ignored, but their chat ID is logged as `ignored chat not on allowlist`. Copy the IDs you want into `WHATSAPP_ALLOWED_CHATS`.

## Running

`npm run dev` restarts on file changes. `npm start` runs the build in `dist`.

To keep it running with pm2:

```sh
npm i -g pm2
pm2 start dist/index.js --name kamakura
pm2 save
pm2 startup
```

Or use launchd. Edit the paths in `deploy/dev.kamakura.bot.plist` (`which node` gives the node path), then:

```sh
cp deploy/dev.kamakura.bot.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/dev.kamakura.bot.plist
```

Turn off sleep in System Settings > Battery so the Mac stays awake with the lid open, or keep it plugged in and use `caffeinate -s`.

## Notes

`data/` holds chat history and logins. It is git-ignored.

Model replies can contain `<skip>` to stay quiet or `<react:😂>` to react on WhatsApp. Blank lines split a reply into separate texts, up to three by default.

Message text is sent to OpenAI with `store: false`. Logs leave out message text.

`npm test` checks reply parsing. `npm run check` type-checks.
