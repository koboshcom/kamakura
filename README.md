# Kamakura

A sleepy old shrine cat on Telegram. TypeScript, grammY, OpenAI Responses via the Vercel AI SDK.

Features: per-chat history, scoped memory facts, web search, images (incl. HEIC), voice notes, video (ffmpeg frames + transcription), persisted reminders, emoji reactions, and per-user command sandboxes.

## Setup

1. Create a bot with @BotFather, put the token in `.env` as `TELEGRAM_BOT_TOKEN`.
2. Groups: BotFather `/setprivacy` then **Disable** so the bot sees all group messages (it uses `<skip>` to stay quiet). Keep privacy enabled if you only want it to see mentions, replies and commands, and set `TELEGRAM_GROUP_MODE=mentions`. Re-add the bot to a group after changing privacy.
3. `cp .env.example .env`, fill `OPENAI_API_KEY`, `TELEGRAM_ALLOWED_CHATS` (chat IDs; empty denies everything).
4. Build the sandbox image: `docker compose --profile build build sandbox-image`
5. Linux: `DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)` in `.env`.
6. `docker compose up -d --build`

Edit `persona.md` to change the personality.

## run_command sandboxes

Each Telegram user in `SANDBOX_ALLOWED_USERS` (exact numeric IDs, no wildcard) gets their own container, created on demand from `SANDBOX_IMAGE`, only in DMs. Containers have no host mounts, read-only rootfs, all capabilities dropped, no-new-privileges, uid 1000, CPU/memory/PID limits, `network=none` unless `SANDBOX_NETWORK=true`, a per-command timeout, and output truncation. Idle containers are removed after `SANDBOX_IDLE_SECONDS`; the `/workspace` named volume persists.

All limits are env vars (defaults `SANDBOX_DISK=35G`, `SANDBOX_CPUS=2`, `SANDBOX_MEMORY=3g`). Docker's default `local` volume driver cannot enforce a disk size, so the bot refuses to create sandboxes unless you either use a quota-capable driver (`SANDBOX_VOLUME_DRIVER` + `SANDBOX_VOLUME_OPTIONS_JSON`, `{bytes}` is substituted with the disk limit) or set `SANDBOX_ALLOW_SOFT_QUOTA=true`, which only checks usage before each command.

## Security

The core container mounts `/var/run/docker.sock`. Anyone who controls the core process controls the Docker host, effectively root. Keep the bot token and OpenAI key secret, keep the allowlists tight, and run it on a machine you'd be fine losing. Sandboxed users can't reach the socket, but a container escape or kernel bug would expose the host. Prompt injection from web pages or files can try to make the model run commands; the tool only runs for the allowlisted sender in their own DM, but treat that sender's sandbox as untrusted.
