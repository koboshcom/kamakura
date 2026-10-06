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

All limits are env vars (defaults `SANDBOX_DISK=35G`, `SANDBOX_CPUS=2`, `SANDBOX_MEMORY=3g`). Size suffixes use binary units, so 35G means 35GiB and 3g means 3GiB. CPU is NanoCpus=2e9; MemorySwap equals Memory, allowing no additional swap when the host supports swap accounting. No GPU: sandboxes explicitly use runc, request no devices and receive no GPU mounts. The core talks directly to `/var/run/docker.sock`, no proxy. It only manages labelled user containers and their workspace volumes, never privileged provisioning/helper containers.

Hard-cap storage defaults to `SANDBOX_VOLUME_MODE=loopback`. Every allowed user gets a separately provisioned, fixed-size ext4 image backing a persistent Docker named volume mounted at `/workspace`. Missing or mismatched volumes fail closed. The core never allocates host loop devices or formats disks.

Before starting the bot, on a Linux Docker Engine host, install Python 3, util-linux and e2fsprogs. Review `deploy/provision-sandbox-volumes.py`, then run it as root with just the sandbox settings exported, for example:

```sh
sudo env SANDBOX_ALLOWED_USERS=123456789,987654321 SANDBOX_INSTANCE=default SANDBOX_DISK=35G python3 deploy/provision-sandbox-volumes.py
```

The script creates root-owned sparse images under `/var/lib/kamakura-loopback`, attaches loop devices, formats only new images, initializes workspace ownership to uid/gid 1000 and creates labelled `local` volumes with ext4 device options. Existing data is never reformatted or resized. Stop the bot and user containers before maintenance. Re-run this command after each host reboot BEFORE starting the bot to reattach the same devices; an occupied loop number fails safely and requires operator intervention. Do not auto-start the bot until this host boot step has succeeded. Back up the images with their filesystem unmounted. Idle cleanup leaves both named volumes and images intact. Ext4 metadata reduces usable space below the configured image capacity. Sparse files enforce a logical cap but do not reserve physical host storage, so monitor host free space.

Docker Desktop on macOS/Windows runs its daemon in a VM; running this script on macOS does not provision that VM. Use a dedicated Linux Docker host/VM or a compatible quota-capable volume driver. If loopback is unavailable, the default warns/errors rather than silently creating an unbounded workspace. For an alternative hard-quota driver set `SANDBOX_VOLUME_MODE=driver`, `SANDBOX_VOLUME_DRIVER` and `SANDBOX_VOLUME_OPTIONS_JSON` (`{bytes}` substitutes the disk limit). As a deliberately weaker last resort, set mode=driver, driver=local and `SANDBOX_ALLOW_SOFT_QUOTA=true`: startup logs a warning and only checks usage before commands, so commands can exceed the cap. This fallback does NOT satisfy the 35GiB hard-cap requirement.

The other Docker quota mechanism is `--storage-opt size=35G` (`HostConfig.StorageOpt={size:'35G'}`). For overlay2 it needs an XFS backing filesystem mounted with project quotas (`pquota`). That limits the container writable layer, NOT named volumes. It cannot cap `/workspace` while preserving this named-volume design and is therefore documented, not falsely used as a volume quota. Example on an appropriately configured host, for a disposable container without workspace volumes:

```sh
docker run --rm --storage-opt size=35G ubuntu:24.04 true
```

Changing Docker's storage driver/backing filesystem can invalidate existing containers; do not change daemon storage configuration without a backup/migration plan. See [Docker block-device volumes](https://docs.docker.com/engine/storage/volumes/) and [Moby's volume quota clarification](https://github.com/moby/moby/issues/41328).

## Security

The core container mounts `/var/run/docker.sock`. Anyone who controls the core process controls the Docker host, effectively root. Keep the bot token and OpenAI key secret, keep the allowlists tight, and run it on a machine you'd be fine losing. Sandboxed users can't reach the socket, but a container escape or kernel bug would expose the host. Prompt injection from web pages or files can try to make the model run commands; the tool only runs for the allowlisted sender in their own DM, but treat that sender's sandbox as untrusted.
