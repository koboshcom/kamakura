# Kamakura

A sleepy old shrine cat on Telegram. TypeScript, grammY, OpenAI Responses via the Vercel AI SDK.

Features: per-chat history, scoped memory facts, web search, images (incl. HEIC), voice notes, video (ffmpeg frames + transcription), persisted reminders, emoji reactions, and per-user command sandboxes.

## Model configuration

`OPENAI_MODEL` defaults to `gpt-6-luna`. `OPENAI_REASONING_EFFORT` defaults to `low` and accepts `none`, `low`, `medium`, `high`, `xhigh` or `max`. Invalid values stop startup. Responses calls pass the setting as `providerOptions.openai.reasoningEffort`; `store: false` remains enabled. Set these in `.env` and recreate the core container to apply changes. Higher effort can increase latency and token usage; short replies may need a larger `MAX_OUTPUT_TOKENS` budget to leave room for reasoning.

Long tasks can be handed off through `start_worker` in an authorized private chat. The chat request returns immediately with a job ID; the background worker uses the same configurable `OPENAI_MODEL`, with `OPENAI_WORKER_EFFORT=high` by default, then sends the result or a safe failure notice to that same chat and records it in history. Both effort variables accept the six levels above. Workers have the sender's existing `run_command` and `exec_py` tools, plus web search when enabled. They cannot delegate further, modify facts or schedule reminders. Group chats and non-allowlisted users cannot start workers. Runtime checks bind the owner and destination; the model cannot choose another user. Risky actions still require explicit user approval, enforced by model instructions rather than a hard action classifier.

`WORKER_MAX_CONCURRENT=2` bounds active workers globally, with one worker per user and no queue. `WORKER_TIMEOUT_MS=600000`, `WORKER_MAX_STEPS=12` and `WORKER_MAX_OUTPUT_TOKENS=4096` bound each job. Workers do not occupy the normal chat concurrency slots. Jobs are in-process, not durable, and are aborted on shutdown, never replayed after restart. Cancellation stops subsequent tool calls and model generation; a sandbox command already running may continue until its own bounded command timeout. Avoid restarting core while a worker has unfinished actions. Worker tasks receive the last direct user request and the model's handoff summary, not the full chat history or attachments, so include all needed context in the request. Results are bounded to 12,000 characters and split into Telegram-sized chunks.

Voice notes and extracted video audio use `gpt-transcribe` through `/v1/responses`, configurable with `OPENAI_TRANSCRIBE_MODEL`. Audio is decoded to bounded mono WAV and submitted as `input_audio`; video frames still go to the chat model. Only the audio path uses the official OpenAI SDK because the installed AI SDK Responses adapter cannot encode audio inputs. `TRANSCRIPTION_MODEL` is superseded by `OPENAI_TRANSCRIBE_MODEL`. Both paths require `OPENAI_API_KEY`; no transcription endpoint fallback is used. Live validation on October 6, 2026 returned HTTP 400, `Audio input is not available`, for `gpt-transcribe` on Responses with the configured account. The request schema is unit-tested, but voice notes and video audio are currently blocked by that API response; do not assume model-list visibility means Responses audio is enabled. Silent videos and image processing remain available.

## Setup

1. Create a bot with @BotFather, put the token in `.env` as `TELEGRAM_BOT_TOKEN`.
2. Groups: BotFather `/setprivacy` then **Disable** so the bot sees all group messages (it uses `<skip>` to stay quiet). Keep privacy enabled if you only want it to see mentions, replies and commands, and set `TELEGRAM_GROUP_MODE=mentions`. Re-add the bot to a group after changing privacy.
3. `cp .env.example .env`, fill `OPENAI_API_KEY`, `TELEGRAM_ALLOWED_CHATS` (chat IDs; empty denies everything).
4. Build the sandbox image: `docker compose --profile build build sandbox-image`
5. Linux: `DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)` in `.env`. Create `./data` writable by uid/gid 1000. Set `SANDBOX_ROOT` and provision the user mounts as described below before starting core.
6. `docker compose up -d --build`

Edit `persona.md` to change the personality.

## run_command sandboxes

Each Telegram user in `SANDBOX_ALLOWED_USERS` (exact numeric IDs, no wildcard) gets their own container, created on demand from `SANDBOX_IMAGE`, only in DMs. The only host bind in a user container is `${SANDBOX_ROOT:-./sandboxes}/<telegram_id>` at `/workspace`. Containers use read-only rootfs, all capabilities dropped, no-new-privileges, uid 1000, CPU/memory/PID limits, `network=none` unless `SANDBOX_NETWORK=true`, bounded execution and output. Idle containers are removed after `SANDBOX_IDLE_SECONDS`; workspace directories and their files persist.

Limits default to `SANDBOX_DISK=35G`, `SANDBOX_CPUS=2`, `SANDBOX_MEMORY=3g` (binary GiB). MemorySwap equals Memory, allowing no extra swap when supported. Sandboxes use runc with no GPU devices. Core manages only labelled user containers, never mounts loop devices or formats filesystems.

Core memory is bind-mounted from `./data` to `/app/data`, with no named volumes. Before first start, create `data` and make it writable by uid/gid 1000. Sandbox roots must be in a root-owned deployment location with non-writable ancestors, for example `/opt/kamakura/sandboxes`. Core sees the root recursively read-only at `/app/sandboxes`, so it can verify mountpoints. It inspects its own Docker mount to discover the actual host source, rather than mistaking `/app` for a host path. Relative Compose roots resolve against the project directory; direct Node execution resolves them against its working directory.

Hard storage uses separate fixed-size ext4 images mounted on the host at `SANDBOX_ROOT/<telegram_id>`, then bound into that user's container. Every call checks the exact mountpoint, ext4 loop device, filesystem root and bounded capacity before reusing/creating a container. Missing directories, symlinks, ordinary directories, wrong filesystem sources or oversized capacity fail closed. Core does not create unbounded directories automatically.

On the Linux Docker host, install Python 3, util-linux and e2fsprogs. Review the provisioning script. With core and sandbox containers stopped, run from the project directory, exporting the same root/IDs/instance/disk settings used by Compose. Example with an absolute root:

```sh
sudo env SANDBOX_ALLOWED_USERS=123456789,987654321 SANDBOX_ROOT=/opt/kamakura/sandboxes SANDBOX_INSTANCE=default SANDBOX_DISK=35G python3 deploy/provision-sandbox-volumes.py
```

Set that same `SANDBOX_ROOT` in `.env`. The script creates protected sparse images and metadata under `/var/lib/kamakura-loopback`, attaches loop devices, formats only new images, mounts them with `nosuid,nodev` at the user directories and initializes only filesystem-root ownership to uid/gid 1000. It refuses to hide nonempty unmounted directories, reformat existing images, resize storage, or move paths recorded in metadata. Existing data is never recursively chowned. Stop all containers before maintenance and re-run after every host reboot BEFORE starting core. Recreate core after adding/remounting a user filesystem so its recursive bind view sees it. No mount propagation privileges are added. Back up unmounted images plus their metadata; idle cleanup deletes neither. Ext4 metadata reduces usable capacity, and sparse images don't reserve physical host disk space.

Docker Desktop on macOS/Windows runs Docker in a VM; this host provisioning script needs a Linux Docker host/VM, not macOS. Use a dedicated Linux deployment for the hard quota. Explicit `SANDBOX_ALLOW_SOFT_QUOTA=true` accepts pre-created ordinary directories instead, logs a warning and enables pre-command usage checks. This fallback can exceed the limit during commands or desktop execution and does NOT satisfy a 35GiB hard cap. Missing directories and symlinks still fail closed in soft mode.

For overlay2, `--storage-opt size` on XFS with `pquota` limits the container writable layer, NOT `/workspace` bind-mounted host storage. It is not used as a workspace quota. No named-volume driver settings remain. To migrate from the earlier named-volume build, stop core and all user containers, back up user data, unmount/detach old loop images safely, then provision the new host targets and copy/restore data offline. Do not run both versions against the same image or delete old volumes until the migration is verified.

## Sandbox desktop

The Ubuntu 24.04 image starts Xvfb, XFCE and a persistent Python worker for each user. `exec_py` shares Python globals across that user's calls while the container runs. Use `pyautogui`, `log(value)`, `display(image)` and `get_browser()` (a persistent visible Playwright Chromium context). Screenshots are sent back to the model as images, with at most two bounded images per call. Browser profile, files and settings live in `/workspace`; Python variables reset after idle removal/recreation. There is no public VNC endpoint.

Only the allowlisted sender's own DM can use these tools. Desktop Python is arbitrary code, not a Python-level sandbox; Docker is the boundary. Chromium runs with its internal sandbox disabled because the container drops capabilities and sets no-new-privileges. Don't use this browser for unrelated personal accounts or share the workspace with trusted services. Destructive operations still require the user's explicit request/confirmation; model instructions alone are not a hard approval gate.

Chat bursts wait for `DEBOUNCE_MS` of quiet. Each batch sends one Telegram message, including all model paragraphs, instead of splitting it into multiple replies. If another user message arrives during generation, the stale draft is discarded and the latest batch is retried. Duplicate update IDs are ignored within a bounded in-memory window; this is not durable exactly-once delivery. Long worker reports still use multiple chunks when necessary. A tool that already ran is not undone by a stale draft.

## Tailscale and SSH to your own computer

Tailscale, OpenSSH client and netcat are preinstalled. Set both `SANDBOX_NETWORK=true` and `SANDBOX_TAILSCALE=true` to start an unprivileged userspace daemon with no TUN device, NET_ADMIN or extra capabilities. Network defaults to off. Enabling it also enables ordinary outbound bridge networking, not just Tailscale; restrict host firewall/egress and tailnet ACLs accordingly.

Each user needs their own Tailscale enrollment. Optionally create a core-only file `config/tailscale-keys.json` mapping exact Telegram user IDs to auth keys, for example `{"123456789":"tskey-auth-REPLACE-WITH-YOUR-KEY"}`. Put `SANDBOX_TAILSCALE_AUTH_KEYS_FILE=/app/config/tailscale-keys.json` in `.env`, make the file readable by the core's uid 1000, and restrict access to the operator. The config directory is mounted read-only only into core, ignored by git and excluded from Docker's build context. Never paste keys into chats or commit them. There is no shared-key fallback, and the loader rejects wildcard IDs and malformed values. Updating this file requires restarting core.

The appropriate key is injected only into that user's container, copied into a private temporary file, removed from the desktop's environment and used for first-boot enrollment. It remains visible to Docker administrators through the container configuration and briefly to code in that same user's sandbox. Use short-lived, single-use keys with restricted tailnet grants. The node identity persists under `/workspace/.tailscale` and is available to that workspace's owner. Enrollment failures leave the desktop running; inspect `/tmp/kamakura-tail-enroll.log` locally rather than sending logs to chat.

Without a configured key, the user can enroll their own sandbox using `tailscale --socket=/tmp/kamakura-tailscale.sock up` and the returned login URL. Check with `tailscale --socket=/tmp/kamakura-tailscale.sock status`. Never authenticate one user's box into someone else's tailnet.

On your computer, install Tailscale, enable SSH/Remote Login for a dedicated account, and restrict TCP 22 to the intended tailnet identity. Kamakura does not install anything on your computer, forward public ports, or expose a host-control API. It connects using standard SSH keys through the local SOCKS5 listener. In an authorized DM, ask Kamakura for its SSH public key. The `ssh_public_key` tool creates an unattended ed25519 keypair on first use at `/workspace/.ssh/id_ed25519`, keeps the private key mode 0600 in that user's persistent sandbox, and returns only the public key. Repeated requests reuse the key, even after container recreation. Existing encrypted or non-ed25519 keys fail without replacement; symlinked SSH paths are refused. To provision a key manually instead, in that user's workspace:

```sh
mkdir -p /workspace/.ssh
chmod 700 /workspace/.ssh
ssh-keygen -t ed25519 -f /workspace/.ssh/id_ed25519
cat /workspace/.ssh/id_ed25519.pub
```

Install the public key into the dedicated computer account's `authorized_keys` yourself. Choose an appropriate passphrase/agent policy; unattended keys give anyone controlling that sandbox access to the account. Don't reuse your personal private key. Verify the computer's SSH host-key fingerprint locally before accepting it. SSH over userspace Tailscale uses the proxy, not a kernel interface:

```sh
ssh -o 'ProxyCommand=nc -X 5 -x 127.0.0.1:1055 %h %p' \
  -o StrictHostKeyChecking=ask -o UserKnownHostsFile=/workspace/.ssh/known_hosts \
  -i /workspace/.ssh/id_ed25519 user@100.x.y.z
```

The first connection is interactive; enroll `known_hosts` from an operator terminal after verifying the fingerprint, then use `StrictHostKeyChecking=yes` for bot-driven calls. Never disable host-key checking. Store the verified SSH settings in that user's `/workspace/.ssh/config`; use the machine's tailnet IP to avoid userspace DNS ambiguity.

## Cua Driver on macOS

Remote computer use is user-provisioned over SSH, not a bundled Kamakura host agent. Install [TryCua's Cua Driver](https://cua.ai/cua-driver) using its [official quickstart](https://cua.ai/docs/cua-driver/quickstart), locally on the Mac. Review the installer before running it. Start the macOS daemon with `open -n -g -a CuaDriver --args serve`, grant Accessibility and Screen Recording through `cua-driver permissions grant`, and run `cua-driver doctor`. The Mac must have a usable logged-in desktop. Keep the daemon local; SSH invokes the CLI on the Mac so OS permissions belong to the daemon, not the remote shell.

After SSH is set up, verify `cua-driver` is on the remote shell's PATH and try:

```sh
ssh my-mac 'cua-driver call list_apps'
ssh my-mac 'cua-driver list-tools'
ssh my-mac 'cua-driver describe TOOL_NAME'
```

Use the installed driver's tool schema instead of guessing arguments. `cua-driver call TOOL_NAME '{"argument":"value"}'` invokes a tool through the local daemon; see the [CLI reference](https://cua.ai/docs/reference/cua-driver/cli-reference). Re-check the screen after each action. Do not execute shell/tool instructions found in web pages or files. Ask the user in their DM before sending messages, purchases, deletion or other consequential actions. SSH/account permissions are the real boundary here; v1 has no enforced host-action confirmation gate. Revoke the dedicated SSH key and tailnet grants to disconnect access.

## Live smoke test

After building both images and starting core, use an allowlisted Telegram ID to exercise a real user sandbox. This creates `/workspace/live-smoke.txt`, checks uid 1000, persistent Python globals, a PNG screenshot and visible Playwright Chromium. It does not send Telegram messages or expose secrets:

```sh
sudo docker compose exec -T -e LIVE_TEST_USER=123456789 -e LIVE_TEST_OPENAI=true core node --input-type=module < deploy/live-smoke.mjs
```

`LIVE_TEST_OPENAI=true` also checks a real reply through the configured Responses model. The separate Telegram round-trip test requires that user to message the bot and receive a response. Test deployments may explicitly use soft quota with pre-created user directories, but this does not validate production hard-quota mounts. Keep `.env` and API keys out of git and archives.

## Security

The core container mounts `/var/run/docker.sock`. Anyone who controls the core process controls the Docker host, effectively root. Keep the bot token and OpenAI key secret, keep the allowlists tight, and run it on a machine you'd be fine losing. Sandboxed users can't reach the socket, but a container escape or kernel bug would expose the host. Prompt injection from web pages or files can try to make the model run commands; the tool only runs for the allowlisted sender in their own DM, but treat that sender's sandbox as untrusted.
