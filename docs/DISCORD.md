# Discord owner DMs

Create a Discord application and bot in the developer portal. Use its **bot token**, not a personal account token. Install the bot in a private test server so the owner can open a DM. The server is only for discovery; this adapter never processes guild messages or group DMs. Only the Direct Messages gateway intent is requested; privileged Message Content intent is not needed for bot DMs.

Keep `DISCORD_ENABLED=false` until configured. Set `DISCORD_BOT_TOKEN`, `DISCORD_ALLOWED_USERS` and `DISCORD_OWNER_IDS` in the private operator `.env`, then rebuild/restart through your normal deployment procedure. No command sync, webhook or public listening port is needed.

```dotenv
DISCORD_ENABLED=true
DISCORD_BOT_TOKEN=your_private_bot_token
DISCORD_ALLOWED_USERS=123456789012345678
DISCORD_OWNER_IDS={"123456789012345678":"6612253937"}
```

Every Discord ID must be an exact decimal **string** mapped to a canonical owner already explicitly authorized in `SANDBOX_ALLOWED_USERS`. No wildcard or display-name authorization. Canonical owner IDs share confirmed user facts and learned advisory notes; Discord history/search, summaries, attachment context and delivery targets remain confined to that DM. This does not grant Discord sandbox/local-device, learning-mutation or reminder privileges. Existing Telegram/WhatsApp restrictions are unchanged.

The model sends only through explicit `send_message`/`react` tools; completion prose is never auto-delivered. Text bubbles are limited to 2000 characters and cannot ping users/roles/everyone. Quotes/reactions require this DM's actual accepted inbound message, retained at most five minutes and 256 entries, not an ID mentioned in text or found in another transport. Voice output is unavailable. Newer messages cancel stale turn delivery through the shared turn guards. Uncertain network deliveries are not retried automatically.

Messages older than two minutes, bots, webhook/system messages, partial messages, group/guild messages and unknown owners are ignored. Inbound buffering is bounded to 32 messages and dedup claims to 4096 IDs within the accepted age window. Authenticated inbound IDs are durably claimed in Mongo before attachment downloads/dispatch, with a ten-minute TTL. A restart replay inside the two-minute age window cannot dispatch twice; claims fail closed if Mongo is unavailable.

For images and provider verification, see [VISION.md](VISION.md). Test with a synthetic picture first. Revoking a mapping prevents further delivery. Revoking/changing it in `.env` requires the normal operator restart to take effect; `.env` is not hot-reloaded.
