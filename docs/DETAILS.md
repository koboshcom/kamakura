# Kamakura details

A sleepy old shrine cat on Telegram. TypeScript, grammY, OpenAI Responses via the Vercel AI SDK.

Features: per-chat history, scoped memory facts, web search, images (JPEG/PNG/WebP; HEIC/HEIF/AVIF currently disabled), voice notes, video (ffmpeg frames + transcription), persisted reminders, emoji reactions, and per-user command sandboxes.

## Model configuration

The example sets `OPENAI_MODEL=gpt-6-luna`; runtime requires an explicit main URL/key/model. `OPENAI_REASONING_EFFORT` defaults to `low` and accepts `none`, `low`, `medium`, `high`, `xhigh` or `max`. Invalid values stop startup. Responses calls pass the setting as `providerOptions.openai.reasoningEffort`; `store: false` remains enabled. Set these in `.env` and recreate the core container to apply changes. Higher effort can increase latency and token usage; short replies may need a larger `MAX_OUTPUT_TOKENS` budget to leave room for reasoning.

`CHAT_MAX_STEPS=12` (range 2–30) bounds the chat's multi-step tool loop; `MAX_OUTPUT_TOKENS=2048` leaves room for reasoning as well as a brief final reply. These limits and the existing request timeout keep recovery bounded. The persona and per-step reminder favor verification, diagnosing failures and trying another appropriate tool rather than scenario-specific recipes. Shell, files, public fetch, web search and desktop vision remain generic; installation depends on actual runtime capabilities and owner authorization, not a prompt assertion that sudo exists.

Long tasks can be handed off through `start_worker` by an authenticated authorized owner in an authorized chat. The chat request returns immediately with a job ID; the background worker uses its own OPENAI_WORKER_BASE_URL, OPENAI_WORKER_API_KEY and OPENAI_WORKER_MODEL, with `OPENAI_WORKER_EFFORT=high` by default, then sends the result or a safe failure notice to that same chat and records it in history. Both effort variables accept the six levels above. Workers have the sender's sandbox coding and desktop tools, plus web search when enabled. They cannot delegate further, modify facts or schedule reminders. The parent uses `worker_status`, `message_worker` and `cancel_worker` for the owner's active job. Follow-ups are bounded to eight queued messages of 2,000 characters each and arrive between model steps, not while a model/tool call is running. A worker may send at most four brief progress updates or questions back to its original chat with `send_message`; it cannot choose another recipient or grant itself new risky-action permissions. Non-allowlisted chats and senders cannot start workers. Production remains limited to the two existing owner DM chat IDs; support for owner requests in explicitly allowlisted groups does not add any group automatically. Runtime checks bind the owner and destination; the model cannot choose another user. Risky actions still require explicit user approval, enforced by model instructions rather than a hard action classifier.

Owner-box Cua calls automatically recognize the driver's explicit pre-execution ended-session rejection, restart the same named session through the private container daemon, and retry the original call once. Ordinary errors, timeouts and permission/revocation diagnostics are never replayed. Session restarts do not preserve snapshot/element tokens; observe fresh state if a stale target is rejected. Each desktop result includes `cua_health` with recovery status, aggregate calls/recoveries/failures and last recovery time; `exec_py` can read `cua.health()` directly. Counters live only for that box worker process and contain no arguments or diagnostics. This recovery is sandbox-only, not the native local-device connector. `deploy/live-cua-recovery.mjs` validates real five-minute idle expiry and recovery on both owner boxes, plus harmless first-call input recovery and PNG capture.

`DEFAULT_TIMEZONE` selects the default IANA timezone (falls back to `TZ`, then UTC). `OWNER_TIMEZONES` is a JSON object keyed by numeric Telegram owner ID, for example `{"123456":"America/Vancouver"}`. Invalid timezone names or mappings fail startup. Chat and worker requests get a fresh trusted local/UTC clock at the end of each model step, after history and stable instructions, keeping changing clock data out of the cacheable instruction prefix. History and the original user request carry fixed message timestamps, including the owner's local offset, to distinguish old messages and gaps from the present. Workers refresh the clock between steps as well. Timezone configuration is operator-controlled, never inferred from model text.

`WORKER_MAX_CONCURRENT=2` bounds active workers globally, with one worker per user and no queue. `WORKER_TIMEOUT_MS=600000`, `WORKER_MAX_STEPS=24` and `WORKER_MAX_OUTPUT_TOKENS=4096` bound each job. Workers do not occupy the normal chat concurrency slots. Jobs are in-process, not durable, and are aborted on shutdown, never replayed after restart. Cancellation stops subsequent tool calls and model generation; a sandbox command already running may continue until its own bounded command timeout. Avoid restarting core while a worker has unfinished actions. Worker tasks receive the last direct user request and the model's handoff summary, not the full chat history or attachments, so include all needed context in the request. Results are bounded to 12,000 characters and split into Telegram-sized chunks.

Voice notes and extracted video audio use `gpt-transcribe` through `/v1/audio/transcriptions`, configurable with `OPENAI_TRANSCRIBE_MODEL`. Audio is decoded to bounded mono WAV and uploaded as a typed multipart file through the official OpenAI SDK; video frames still go to the chat Responses model. `TRANSCRIPTION_MODEL` is superseded by `OPENAI_TRANSCRIBE_MODEL`. Transcription requires its own `OPENAI_TRANSCRIBE_BASE_URL`, `OPENAI_TRANSCRIBE_API_KEY` and `OPENAI_TRANSCRIBE_MODEL`; transcription has bounded input, output and timeout, with no model or endpoint fallback. Transcripts are untrusted chat content, not instructions. The previous Responses audio path was rejected by the configured account and has been removed. A real generated-speech check on October 6, 2026 passed through `gpt-transcribe` on the transcription endpoint. Incoming Telegram voice/video round-trips still require a user-supplied message.

## Setup

These instructions are for a new installation. Keep existing data, database versions and deployment-specific mounts unchanged when upgrading. You need Git, a running Docker daemon with Compose v2, a Telegram bot token from @BotFather, and an API key for the configured Responses model. Run the bot with Docker Compose on every platform. Docker builds install Node 24 and the other runtime dependencies; host Node is only needed for optional build/check/test tooling, not to run the bot.

On macOS, install and open [OrbStack](https://orbstack.dev/download), then run `docker context use orbstack`. OrbStack includes Docker and Compose. On Apple Silicon, leave the platform unset for native arm64 builds; the sandbox Dockerfile has arm64 and amd64 binaries. OrbStack supports amd64 emulation via Rosetta, but use it only for a dependency that needs it. This guide is not an Apple Silicon end-to-end test. The sandbox supplies its own virtual display, so XQuartz is not needed.

On Windows, use WSL2 with Docker Desktop, the production host's setup. Install/update WSL from an administrator PowerShell with `wsl --install` and `wsl --update`, then install [Docker Desktop](https://docs.docker.com/desktop/features/wsl/). Enable the WSL2 engine, Linux containers and integration for your Linux distribution. Run the commands below in that distribution's shell, keeping the repository in its Linux filesystem (for example `~/kamakura`), not `/mnt/c`. Do not install a competing Docker Engine inside WSL.

On Linux, install [Docker Engine](https://docs.docker.com/engine/install/) with the Compose plugin and start its service. Use a rootful local daemon; Docker access gives host-root authority. On Ubuntu/Debian, hard workspace provisioning also needs `python3`, `util-linux` and `e2fsprogs`. Use `sudo docker` if your account lacks socket access.

Clone either repository, then work from its root.

```sh
git clone https://github.com/koboshcom/kamakura.git
cd kamakura
# Alternative clone URL https://git.yuk1n0w.dev/yuk1n0w/Mochi.git
docker info
docker compose version
cp .env.example .env
chmod 600 .env
mkdir -p data
```

Edit `.env` before starting. Set `TELEGRAM_BOT_TOKEN`, the main `OPENAI_BASE_URL`/`OPENAI_API_KEY`/`OPENAI_MODEL` triplet and exact `TELEGRAM_ALLOWED_CHATS`; an empty chat allowlist denies everyone. Set `SANDBOX_ALLOWED_USERS` to exact numeric sender IDs if you want boxes, and `LEARNING_OWNER_IDS` if those owners may teach notes. Configure `EMBEDDING_BASE_URL`, `EMBEDDING_API_KEY` and `EMBEDDING_MODEL` together for embeddings-only history search; they are required at startup. Set timezones as needed. Keep keys out of Git.

For group messages, disable BotFather privacy only if you want all messages delivered to the bot, then re-add it to the group. Otherwise keep privacy enabled and use `TELEGRAM_GROUP_MODE=mentions`. Private-chat setup needs no privacy change.

Core runs as UID/GID 1000. On Linux/WSL, make the new `data` directory writable by that identity with `sudo chown 1000:1000 data`. On Linux, put the output of `stat -c '%g' /var/run/docker.sock` in `DOCKER_GID`. On OrbStack/Desktop, leave `DOCKER_GID=0` unless socket permissions inside the core require another group; macOS host socket ownership is not the VM socket's group. If a shared Mac directory is not writable inside the container, fix its file-sharing permissions before proceeding.

For macOS/Windows boxes, set `SANDBOX_ALLOW_SOFT_QUOTA=true` and leave `SANDBOX_ROOTFS_SIZE=` blank. With the default `SANDBOX_ROOT=./sandboxes`, create one real directory per allowlisted owner before starting core, replacing the example IDs with yours.

```sh
mkdir -p sandboxes/123456789 sandboxes/987654321
```

This explicitly accepts soft pre-command workspace checks, not a hard cap. Commands and desktop apps can exceed `SANDBOX_DISK`. Docker Desktop/OrbStack do not enforce this project's classic overlay2/XFS root-layer quota; root installs share the daemon's disk. Monitor host/VM storage. A plain WSL or Mac bind is not the fixed ext4 loopback mount required by hard mode.

For Linux hard workspace limits, set `SANDBOX_ROOT=/opt/kamakura/sandboxes`, `SANDBOX_ALLOW_SOFT_QUOTA=false` and leave the optional root-layer limit blank unless your daemon uses classic overlay2 on project-quota-enabled XFS. Review the provisioning script and run it with core/owner containers stopped, using the same IDs, instance and size as `.env`.

```sh
sudo env SANDBOX_ALLOWED_USERS=123456789,987654321 \
  SANDBOX_ROOT=/opt/kamakura/sandboxes SANDBOX_INSTANCE=default SANDBOX_DISK=35G \
  python3 deploy/provision-sandbox-volumes.py
```

Re-run provisioning to reattach existing mounts after reboot, before core starts; recreate core after remounting. The script refuses to overwrite existing filesystems. Sparse images still need host free-space monitoring. The hard workspace limit covers only `/work`, not root package installs. Linux can instead explicitly accept soft mode with pre-created owner directories.

Build both box helper images, validate Compose without printing secrets, then start the application.

```sh
docker compose --profile build build sandbox-image egress-image
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs --tail=50 core mongo
```

Core and boxes must use the same local daemon. The default `SANDBOX_DOCKER_SOCKET=/var/run/docker.sock` needs no second daemon or userns remapping on Engine, Desktop or OrbStack. Core creates boxes and their trusted egress guards on demand; do not manually launch them. Historical `start-remapped-daemon.sh`, `load-remapped-image.sh` and `remapped-network.sh` are not the portable setup path. Read [SANDBOX-BOUNDARIES.md](../deploy/SANDBOX-BOUNDARIES.md) before enabling arbitrary code. Boxes have bounded container root/sudo, never host Docker sockets; only `/work` persists. Set `SANDBOX_DENIED_IPS` for any public host/LAN/core/database proxy addresses. Engine test evidence is not live verification on Desktop or OrbStack.

Compose currently defaults to `mongodb/mongodb-community-server:8.0-ubi8`, with no public database port. Check image architecture and kernel compatibility if Mongo is unhealthy; never downgrade an existing database in place or remove data to fix startup. `NOVNC_PUBLIC_URL` stays blank unless you configure your own HTTPS/WebSocket proxy to local port 47831. WhatsApp is optional and off by default; see [WHATSAPP-INTEGRATION.md](../deploy/WHATSAPP-INTEGRATION.md) for its separate auth mount/pairing requirements.

### Operator identity and prompt precedence

Presentation is configurable; safety, ownership, credential provenance and tool authorization remain fixed runtime rules appended after presentation. Prompt precedence is SYSTEM_PROMPT, then SYSTEM_PROMPT_PATH, then PERSONA_TEXT, then PERSONA_PATH (default ./persona.md). Nonempty inline values take precedence; file read failures stop the request/startup. BOT_PERSONALITY appends personality text and BOT_NAME sets the display name. The shipped identity.json supplies the default name. Use {{BOT_NAME}} in prompt files.

Paths refer to files inside the core container. Place prompt/style files in ./config and select /app/config/prompt.md or /app/config/style.md. CONFIG_DIR can mount another host directory read-only. PERSONA_FILE changes the host file mounted at /app/persona.md; PERSONA_PATH selects any already-mounted container file and is no longer forced by Compose. Do not put credentials in prompts.

CHAT_STYLE_MODE defaults to the existing style for the shipped persona; a custom name, personality, prompt or persona selects persona-only styling automatically. The shipped default PERSONA_PATH values do not count as a custom persona; a nondefault PERSONA_FILE host mount does. Explicit default keeps the existing informal style; persona omits fixed style reminders; custom requires CHAT_STYLE_TEXT or CHAT_STYLE_PATH. Inline style takes precedence. Delivery/tool routing, budgets and safety still apply. Changing only the contents of the default mounted persona file requires CHAT_STYLE_MODE=persona if you want the fixed style removed. The optional reply editor is disabled by default; its additional editorial guidance can affect a custom voice when explicitly enabled.

Each existing model role has an independent BASE_URL, API_KEY and MODEL. Main chat uses OPENAI_*; worker, compaction, learning and review use OPENAI_WORKER_*, OPENAI_SUMMARY_*, OPENAI_LEARNING_* and OPENAI_REVIEW_*. FAST_* applies to all steps of eligible fast turns, never falling back to main. No role inherits another role’s settings or ambient SDK defaults. These endpoints must implement the Responses API and enabled provider tools, not merely Chat Completions. Endpoints accept HTTP(S) without URL credentials, queries or fragments; use HTTPS except on a trusted local network. An operator endpoint is a trusted destination, not an SSRF-safe public fetch tool.

Embeddings and optional speech use independent credentials. A custom transcription endpoint requires OPENAI_TRANSCRIBE_API_KEY and never receives the chat key. Default OpenAI transcription may use OPENAI_API_KEY for compatibility; configure its independent key when chat uses another provider. TTS never inherits the chat key. Reconfiguring embeddings changes the vector profile; old incompatible records are not backfilled and searches may become unavailable.

Compose fixes DATA_DIR, protected Docker socket paths, SANDBOX_ROOT_VIEW and WHATSAPP_AUTH_DIR to their container mounts. Editing those variables does not relocate storage. WhatsApp remains off by default and needs a separately provisioned private auth mount; its published owner restriction is retained, not expanded.


- Explicit chat delivery uses send_message/react and optional send_voice tools. No delivery call means silence; natural model completion is not sent. Tool calls are serialized, bounded and scoped to known messages in the current chat. reply_to can quote recent or owner-scoped searched message IDs. Typing stays active between length-paced bubbles. Debounce restarts for every incoming burst; a later burst does not replay an already-delivered batch.
- Owner-scoped search_history reads exact stored text from MongoDB. Empty queries preserve chronological lookup, role/timestamp filters and known-message anchors. Nonempty queries use embeddings-only full-scoped cosine search; nonempty exact requests are rejected. Every new saved message includes its full-text vector. Set EMBEDDING_BASE_URL, EMBEDDING_API_KEY and EMBEDDING_MODEL together. No keyword/substring fallback, recent-window shortcut, backfill or migration is performed. Missing/incompatible vectors and provider failures report semantic retrieval unavailable. HISTORY_CONTEXT_MESSAGES controls same-scope chronological neighbors around hits. Earlier discarded messages cannot be recovered; earliest retained does not prove first-ever.
- Optional speech uses SPEECH_TTS_BASE_URL, SPEECH_TTS_API_KEY, SPEECH_TTS_MODEL and SPEECH_TTS_VOICE, separate from chat credentials. All blank TTS is OFF, partial TTS errors, and complete TTS probes the server speech schema and model listing; an unavailable server omits the voice tool, without changing transcription. Opus audio is returned as an Ogg Telegram voice note. No automatic retry after uncertain sends.

## run_command sandboxes

Tool tasks announce a short intended action before execution, with delivery awaited even if model calls arrive in parallel. Missing default packages should be recovered through inspected official installers or signed vendor repositories, with executable/connection checks before claiming success. Telegram output uses parsed entities with a plain fallback only after a definite entity rejection, not an uncertain send failure. OpenAI utm_source tracking is removed from links and prose has no em dashes.

Recent prepared images are retained in volatile memory for text follow-ups, scoped by chat and sender and only while their messages remain in history. Each chat has at most four images/8MiB and four media entries for 24 hours, with 64 chat slots globally. Images are reattached to actual model requests so OCR and visual questions need no resend; restart or eviction removes attachments, and the model must plainly report actual unavailability rather than invent distraction. This is not durable image storage or a permanent photo archive.

Each Telegram user in `SANDBOX_ALLOWED_USERS` (exact numeric IDs, no wildcard) gets their own container, created on demand from `SANDBOX_IMAGE`, only in explicitly allowlisted chats and only when the authenticated sender is that owner. The sole host bind is `${SANDBOX_ROOT:-./sandboxes}/<telegram_id>` at `/work`. Only `/work` survives container or image replacement; packages and other root-filesystem changes reset. CPU2, RAM3GiB, equal swap ceiling, PID256, no GPU, bounded output/time and idle cleanup remain. Networking is always guarded public-internet access; there is no network/root enable flag.

Owner boxes always have writable ephemeral root and full passwordless sudo for UID1000. Plain Docker Desktop/WSL uses the ordinary daemon, without mandatory userns remapping or a second daemon. The owner drops all capabilities except CHOWN, DAC_OVERRIDE, FOWNER, FSETID, SETGID, SETUID, SETPCAP and NET_BIND_SERVICE. It never gets NET_ADMIN, NET_RAW, SYS_ADMIN, privileged mode, host namespaces, devices or either Docker socket. Sudo has no command allowlist, but container capabilities and Docker's default seccomp remain enforced. This is not a VM-grade boundary; kernel vulnerabilities remain possible. The core alone owns Docker authority.

Build both helper images with `docker compose --profile build build sandbox-image egress-image`. Before deploying, read `deploy/SANDBOX-BOUNDARIES.md`. A mount-free trusted firewall container is created for each owner; the owner joins only its network namespace, not its PID namespace or filesystem. Firewall initialization and an exact live policy check precede every owner admission. Missing or altered enforcement fails closed. Only core-initiated TCP6080 desktop traffic gets a narrow return exception; new owner connections to core, Mongo, host, private/LAN/link-local/CGNAT and sibling boxes are rejected. IPv4 and IPv6 destination policy is enforced before DNS NAT; Docker embedded DNS stays enabled. Set `SANDBOX_DENIED_IPS` to any host/LAN **public** addresses as well, since those are not discoverable from a Desktop container. Unrestricted public internet can reach arbitrary public application proxies; this is direct-address isolation, not protection against an owner-controlled remote relay.

The workspace hard-quota check remains unchanged. Docker Desktop cannot enforce the previous classic overlay2/XFS root-layer quota. Leave `SANDBOX_ROOTFS_SIZE` blank there; root installs then share the daemon's disk without a hard per-owner root limit. A nonblank size remains an optional fail-closed classic overlay2/XFS project quota. Do not claim a 35GiB workspace quota bounds the whole container or use soft workspace quota without explicitly accepting its separate risk.

The 35GiB filesystem cap applies to `/work`, not the writable ephemeral root layer. Package installs can consume operator host storage outside that cap until recreation; operators must monitor/reclaim Docker storage or use an independently capped daemon filesystem. Sparse loop images also require host free space monitoring and do not reserve the total requested capacity. Remapped bind ownership must match the daemon subordinate-ID mapping (for a 200000 base, UID1000 is host201000); provision/copy offline before starting core. Using a secondary daemon with `iptables=false` avoids it rewriting primary Docker chains, but requires operator-managed NAT/forward rules. Reattach `/work` ext4 mounts and start the remapped daemon before core on reboot.

Limits default to `SANDBOX_DISK=35G`, `SANDBOX_CPUS=2`, `SANDBOX_MEMORY=3g` (binary GiB). MemorySwap equals Memory, allowing no extra swap when supported. Sandboxes use runc with no GPU devices. Core manages only labelled user containers, never mounts loop devices or formats filesystems.

Core memory is bind-mounted from `./data` to `/app/data`, with no named volumes. Before first start, create `data` and make it writable by uid/gid 1000. Sandbox roots must be in a root-owned deployment location with non-writable ancestors, for example `/opt/kamakura/sandboxes`. Core sees the root recursively read-only at `/app/sandboxes`, so it can verify mountpoints. It inspects its own Docker mount to discover the actual host source, rather than mistaking `/app` for a host path. Relative Compose roots resolve against the project directory.

Hard storage uses separate fixed-size ext4 images mounted on the host at `SANDBOX_ROOT/<telegram_id>`, then bound into that user's container. Every call checks the exact mountpoint, ext4 loop device, filesystem root and bounded capacity before reusing/creating a container. Missing directories, symlinks, ordinary directories, wrong filesystem sources or oversized capacity fail closed. Core does not create unbounded directories automatically.

On the Linux Docker host, install Python 3, util-linux and e2fsprogs. Review the provisioning script. With core and sandbox containers stopped, run from the project directory, exporting the same root/IDs/instance/disk settings used by Compose. Example with an absolute root:

```sh
sudo env SANDBOX_ALLOWED_USERS=123456789,987654321 SANDBOX_ROOT=/opt/kamakura/sandboxes SANDBOX_INSTANCE=default SANDBOX_DISK=35G python3 deploy/provision-sandbox-volumes.py
```

Set that same `SANDBOX_ROOT` in `.env`. The script creates protected sparse images and metadata under `/var/lib/kamakura-loopback`, attaches loop devices, formats only new images, mounts them with `nosuid,nodev` at the user directories and initializes only filesystem-root ownership to uid/gid 1000. It refuses to hide nonempty unmounted directories, reformat existing images, resize storage, or move paths recorded in metadata. Existing data is never recursively chowned. Stop all containers before maintenance and re-run after every host reboot BEFORE starting core. Recreate core after adding/remounting a user filesystem so its recursive bind view sees it. No mount propagation privileges are added. Back up unmounted images plus their metadata; idle cleanup deletes neither. Ext4 metadata reduces usable capacity, and sparse images don't reserve physical host disk space.

Docker Desktop on macOS/Windows runs Docker in a VM; this host provisioning script needs a Linux Docker host/VM, not macOS. Use a dedicated Linux deployment for the hard quota. Explicit `SANDBOX_ALLOW_SOFT_QUOTA=true` accepts pre-created ordinary directories instead, logs a warning and enables pre-command usage checks. This fallback can exceed the limit during commands or desktop execution and does NOT satisfy a 35GiB hard cap. Missing directories and symlinks still fail closed in soft mode.

For overlay2, `--storage-opt size` on XFS with `pquota` limits the container writable layer, NOT `/work` bind-mounted host storage. It is not used as a workspace quota. No named-volume driver settings remain. To migrate from the earlier named-volume build, stop core and all user containers, back up user data, unmount/detach old loop images safely, then provision the new host targets and copy/restore data offline. Do not run both versions against the same image or delete old volumes until the migration is verified.

## Sandbox desktop

The beta test deployment's separate remapped owner-box daemon needs `sudo sh deploy/load-remapped-image.sh` after building `sandbox-image`; otherwise it retains the old desktop image. Production deployments using one daemon do not need this transfer. After any core recreation in that beta deployment, run `sudo sh deploy/remapped-network.sh` to restore core-to-box reachability. Existing owner containers recreate on next use when their image changes, preserving `/work`.

Owner local computers are opt-in and separate from cloud desktops. Enable `LOCAL_DEVICES_ENABLED=true` and configure `LOCAL_DEVICES_PUBLIC_URL=wss://your-connector-domain`. The Compose listener defaults to loopback port 47943; give it its own TLS reverse proxy with WebSocket upgrades. Never expose an unauthenticated driver listener or connect the shared Docker host as an agent. Only the authorized owner private Telegram DM can use `/pair`, `/devices`, and `/revoke DEVICE_ID`. Pair codes expire after two minutes, are one-use and persisted as hashes. The Go `cli/` connector installs on the owner's own computer, connects outbound and starts/reconnects paused. Resume locally to opt in; all shell and Cua actions still require exact single-use Telegram inline approval. Only empty read-only snapshot requests bypass action approval. Approval previews are complete plain JSON and must match the exact digest; credential-containing or invisible-control payloads are rejected instead of displaying redacted executable text. Device attachment and revocation are serialized within the single core, and delayed stale-token handshakes return 403. No distributed multi-core revocation protocol is implied. Main chat has no local computer tools; workers receive them only for authorized private owners. Device/action audit records contain hashes and state, not command bodies. Pause, revoke, timeout and shutdown cancel pending actions. See `cli/README.md` for installation, native OS permissions and the security boundary.

The Ubuntu 24.04 image starts Xvfb, XFCE and a persistent Python worker for each user. `exec_py` shares Python globals across that user's calls while the container runs. Use `desktop_cua` for Cua Driver window snapshots and input, or `cua.call(name,args)`, `screenshot()` (fallback), `log(value)`, `display(image)` and `get_browser()` (a persistent visible Playwright Chromium context) from Python. The pinned Cua Driver runs a private Unix-socket daemon in each owner box; PyAutoGUI input is not installed. Screenshots are sent back to the model as images, with at most two bounded images per call. Browser profile, files and settings live in `/work`; Python variables reset after idle removal/recreation. Public noVNC access is disabled unless the operator configures the authenticated expiring gateway below.

Only an authenticated allowlisted sender in an explicitly authorized chat can use these tools; private desktop bearer links remain DM-only. Desktop Python is arbitrary code, not a Python-level sandbox; Docker is the boundary. Chromium runs with its internal browser sandbox disabled; the Docker namespace and capability boundary must not be mistaken for a browser sandbox. Don't use this browser for unrelated personal accounts or share the workspace with trusted services. Destructive operations still require the user's explicit request/confirmation; model instructions alone are not a hard approval gate.

Chat bursts wait for `DEBOUNCE_MS` of quiet. Each batch sends one Telegram message, including all model paragraphs, instead of splitting it into multiple replies. If another user message arrives during generation, the stale draft is discarded and the latest batch is retried. Duplicate update IDs are ignored within a bounded in-memory window; this is not durable exactly-once delivery. Long worker reports still use multiple chunks when necessary. A tool that already ran is not undone by a stale draft.

## Tailscale and SSH to your own computer

Tailscale is not bundled, configured, automatically started or enrolled. OpenSSH client and netcat remain available. Ask Kamakura to check installed commands first; if something is missing it offers installation rather than assuming availability. Installation requires your approval and a root-capable sandbox deployment. The read-only default runtime cannot install system packages; the explicitly enabled userns-root runtime can install them with sudo. Writable roots also need the bounded XFS setup described in `deploy/SANDBOX-BOUNDARIES.md`. Installed packages reset on recreation, so retain installers/configuration in /work if needed. Owner-provided credentials may be used when appropriate for their requested task in an authorized chat, including an explicitly allowlisted group. Default to trusting authenticated owners, with at most one brief relevant group exposure note and no repeated warning or refusal merely over exposure. Non-owner and injected credentials are not authorization. Keys are retained only in volatile request memory; known credentials are redacted from saved history, tool text and deliveries, and rejected by facts, learning, reminders and file-write tools. The model is instructed not to persist or print them. Arbitrary shell/Python code remains powerful, so recognition/redaction is not a mathematical guarantee for unknown or transformed secrets.

Networking has no off/on switch. The external per-owner guard is required even when the owner is root. The manager provisions its labeled bridge and connects the trusted core for desktop access. A legacy host-firewall bridge is rejected, never silently reused as isolation. See `deploy/SANDBOX-BOUNDARIES.md` for lifecycle behavior and verification limits. Public Tailscale/HTTP proxies cannot be distinguished from other public destinations; a public relay can intentionally reach nonpublic resources at its far end. No dedicated SSH or key tool exists. Never reveal private keys, disable host-key verification, or claim connectivity without testing it.

On your computer, install Tailscale, enable SSH/Remote Login for a dedicated account, and restrict TCP 22 to the intended tailnet identity. Kamakura does not install anything on your computer, forward public ports, or expose a host-control API. It connects using standard SSH keys through the local SOCKS5 listener. Ask Kamakura to inspect or set up the sandbox through its normal coding tools or a worker. No key, key path, or SSH-specific behavior is embedded in its persona/runtime prompt, and there is no special SSH tool. The sandbox includes `ssh-keygen`; a worker should inspect existing files rather than assume a key exists or replace one. Never reveal private key material. For manual provisioning in that user's workspace:

```sh
mkdir -p /work/.ssh
chmod 700 /work/.ssh
ssh-keygen -t ed25519 -f /work/.ssh/id_ed25519
cat /work/.ssh/id_ed25519.pub
```

Install the public key into the dedicated computer account's `authorized_keys` yourself. Choose an appropriate passphrase/agent policy; unattended keys give anyone controlling that sandbox access to the account. Don't reuse your personal private key. Verify the computer's SSH host-key fingerprint locally before accepting it. SSH over userspace Tailscale uses the proxy, not a kernel interface:

```sh
ssh -o 'ProxyCommand=nc -X 5 -x 127.0.0.1:1055 %h %p' \
  -o StrictHostKeyChecking=ask -o UserKnownHostsFile=/work/.ssh/known_hosts \
  -i /work/.ssh/id_ed25519 user@100.x.y.z
```

The first connection is interactive; enroll `known_hosts` from an operator terminal after verifying the fingerprint, then use `StrictHostKeyChecking=yes` for bot-driven calls. Never disable host-key checking. Store the verified SSH settings in that user's `/work/.ssh/config`; use the machine's tailnet IP to avoid userspace DNS ambiguity.

## Temporary links for box services

For an owner-requested HTTP preview, Kamakura can use the preinstalled `cloudflared` (official version `2026.10.0`, SHA256-verified amd64/arm64 binary) with its ordinary shell tools to run `cloudflared tunnel --url http://localhost:PORT`. It reads the temporary `trycloudflare.com` URL from process output and verifies it before reporting success. Keep the app and tunnel running; the link stops when the tunnel or box stops. A verified egress guard and operator outbound access are required. No dedicated tool, automatic tunnel startup, DNS/TLS management or box subdomain router is added. The binary remains available after recreation because it is part of the image. Anyone holding the URL can access the exposed service unless it has authentication; expose only the requested app, not private directories or admin endpoints. Official guidance is at https://developers.cloudflare.com/tunnel/get-started/quick-tunnels.

The root remains ephemeral with sudo in the remapped box. Only `/work` persists at its 35GiB filesystem cap. Writable root requires classic overlay2 on quota-enabled XFS and a hard `SANDBOX_ROOTFS_SIZE` ceiling (default 8G), plus an operator-bounded daemon backing filesystem. Existing ext4 writable-root installations must migrate before this runtime can recreate their boxes; there is no silent unbounded or read-only fallback. `SANDBOX_ROOTFS_MODE=readonly` is an explicit optional fail-closed mode that disables system package installs. Package installs reset on recreation; save project/configuration files in `/work` and reinstall missing tools. This box-preview workflow does not change the existing operator-configured noVNC gateway.

## Desktop viewing

Chromium runs headed on the sandbox's virtual display, with its profile under `/work/.chromium`. Each sandbox runs localhost-only x11vnc and internal port 6080 websockify/noVNC. A separate 256-bit random backend credential protects both HTTP and websocket access, so another sandbox cannot directly control its desktop over the shared bridge. No per-box port is published.

The manager connects the Docker core container to the guarded desktop bridge. Run core through Docker Compose on the same daemon as its owners. Lucas/operator owns nginx, domains and TLS; the bot does not provision DNS, certificates or tunnels. Set `NOVNC_PUBLIC_URL=https://vnc.kamakura.kobosh.com` to generate links from that fixed HTTPS origin. Blank disables the gateway. `NOVNC_PORT=47831` is its dedicated service port. Each future web service must use its own configurable port, host and public URL, not this listener. Compose publishes only on `NOVNC_BIND_ADDRESS=127.0.0.1` by default; `NOVNC_HOST=0.0.0.0` is the listener inside the container. The older `DESKTOP_PUBLIC_BASE_URL`, `DESKTOP_PORT`, `DESKTOP_HOST` and `DESKTOP_BIND_ADDRESS` remain fallback aliases; explicitly set `NOVNC_*` wins.

`NOVNC_TRUSTED_PROXIES` is a comma-separated allowlist of exact immediate proxy peer IPs as seen on the gateway socket. There is no wildcard, hostname or CIDR trust. For nginx running on the Docker host, the gateway may see the Compose bridge gateway (for example `172.18.0.1`), not localhost. Verify your deployment's actual peer before setting this; never trust an entire user-container network. Forwarding headers from untrusted peers are ignored. Trusted `X-Forwarded-Proto`/`X-Forwarded-Host`, when supplied, must match the configured HTTPS origin. Forwarded client IPs never establish owner identity, grant access, select a backend or construct a URL. No incoming forwarding headers reach the sandbox backend. Secure cookies and exact websocket Origin checks always use the fixed public origin.

`deploy/nginx-novnc.example.conf` provides HTTP redirect and HTTPS server blocks, explicit websocket Upgrade/Connection headers, forwarding-header overwrite and token-safe logging. Change its certificate paths and port for your existing nginx deployment, then run `nginx -t` before reloading. No nginx configuration is installed automatically. Avoid logging token-bearing URLs in both access and error logs. The websocket settings follow https://nginx.org/en/docs/http/websocket.html. Public nginx/TLS reachability is separate from local gateway tests.

The authorized owner can ask for a `watch_desktop` link in their private chat. Each bearer link is `DESKTOP_PUBLIC_BASE_URL/<key>` (or the higher-precedence `NOVNC_PUBLIC_URL` origin), where the key is a SHA-256 hex digest of cryptographically random bytes. It is bound to that owner's exact container, expires after `DESKTOP_TOKEN_TTL_MS` (60 minutes default, 24 hours maximum), and is revoked on restart or authorization loss; container replacement is denied on every target inspection. Opening the exact bootstrap URL once exchanges the key for an independent Secure HttpOnly SameSite=Strict cookie scoped to `/<key>/` and redirects to `/<key>/vnc.html`; replaying the bootstrap URL returns 403, even with that cookie. Assets and websocket `/<key>/websockify` require the session cookie. Only hashes of bootstrap keys and owner-scoped session tokens are held in bounded server memory. Unknown and expired keys return 403. Do not log capability URL paths or cookies in operator proxy access logs. Websocket connections require the configured exact HTTPS Origin and close on expiry/revocation. Anyone with the link can watch and control that sandbox until expiry; do not forward it. Browser public HTTPS access requires your external proxy setup, which local smoke tests cannot establish.

Speech-to-text can use `OPENAI_TRANSCRIBE_BASE_URL` and `OPENAI_TRANSCRIBE_API_KEY` independently of chat. A custom speech host requires its own credential to avoid sending the chat key to it. Transcription uses `/audio/transcriptions`. Optional voice replies use separate `SPEECH_TTS_BASE_URL`, `SPEECH_TTS_API_KEY`, `SPEECH_TTS_MODEL` and `SPEECH_TTS_VOICE` settings. All TTS fields blank disables the voice tool. Partial configuration stops startup with a field-name-only error. A complete configuration still needs a successful speech-route and model capability check. Synthesis must return bounded Ogg audio for Telegram, and uncertain delivery failures are never retried as text.

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

After building both images and starting core, use an allowlisted Telegram ID to exercise a real user sandbox. This creates `/work/live-smoke.txt`, checks uid 1000, persistent Python globals, a PNG screenshot and visible Playwright Chromium. It does not send Telegram messages or expose secrets:

```sh
sudo docker compose exec -T -e LIVE_TEST_USER=123456789 -e LIVE_TEST_OPENAI=true core node --input-type=module < deploy/live-smoke.mjs
```

`LIVE_TEST_OPENAI=true` also checks a real reply through the configured Responses model. The separate Telegram round-trip test requires that user to message the bot and receive a response. Test deployments may explicitly use soft quota with pre-created user directories, but this does not validate production hard-quota mounts. Keep `.env` and API keys out of git and archives.

## MongoDB storage and migration

Facts require an exact safe excerpt from the current authenticated direct sender message, with matching chat/owner and no forwarded, media or reply-derived evidence. Stored owner/message/time/excerpt provenance does not grant instruction priority; facts are advisory user-role data and legacy entries explicitly lack verified confirmation. Imported facts remain credential-checked. MongoDB Community is the only runtime store for chat history, facts, learned envelopes/revisions and reminders. Configure `MONGODB_URI` (default `mongodb://mongo:27017`) and `MONGODB_DATABASE` (default `kamakura`). Core attempts migrations before starting, but a transient Mongo outage starts degraded chat with recovery every 15 seconds. Accepted history is first credential-redacted and fsynced into `DATA_DIR/history-pending.json`, a bounded recovery journal, not an alternate canonical database. `STORAGE_BUFFER_MAX_BYTES` defaults to 16777216; quota exhaustion explicitly rejects acceptance rather than silently discarding messages. Stable upserts replay the journal once after recovery or restart, retaining timestamps and genuine distinct messages. Keep one core writer per DATA_DIR. During outages searches label cached/pending snapshots incomplete; facts use safe cached reads and lessons may be omitted. Facts, lessons and reminder mutations can fail visibly instead of unsafely replaying compare-and-swap operations. Reminder claims remain fail closed and uncertain deliveries are never resent automatically. No runtime JSON/SQLite database fallback exists. Shutdown closes the shared official Node driver. Logical namespaces are derived from stable absolute store directories; keep `DATA_DIR` and its container path stable across production recreations. Test fixtures use separate directories and test databases.

Compose runs a separate `mongo` service with no authentication, no published ports and no `expose`; it joins only the dedicated `mongo-internal` network, marked `internal: true`. Core also joins its default network for outbound API access. Only core and Mongo join the database network; user sandboxes use the separate daemon/remapped bridge. Persist Mongo at `./data/mongo:/data/db`. Do not attach other services to this network or expose this unauthenticated database. Host root/core Docker access can still reach it. `deploy/remapped-network.sh` must be reapplied after recreating core; it denies new remapped-sandbox connections to non-egress interfaces. Network membership and actual connection-denial checks belong in deployment validation.

The default `MONGODB_IMAGE` is the official MongoDB-maintained `mongodb/mongodb-community-server:8.0-ubi8`, pinned to the stable 8.0 major. Official release notes identify Linux kernels 6.19 through 7.0.13 as incompatible with its TCMalloc allocator. Upgrade to a supported kernel rather than disabling the startup guard. For a fresh isolated test database on such a host, explicit `MONGODB_IMAGE=mongo:7.0` uses the Docker official supported 7.0 branch. Never downgrade an existing 8.0 database in place. Sources https://www.mongodb.com/docs/v8.0/release-notes/8.0/ and https://www.mongodb.com/docs/v8.0/tutorial/install-mongodb-community-with-docker/.

On first access, migration imports `history.json` and `history-archive.json`, hashed `facts/*.json`, hashed `learned/*.json`, and `reminders.sqlite`. Originals remain untouched byte-for-byte as backups, including SQLite state. Import uses deterministic document identities and completion markers, so interrupted imports resume and repeated starts do not duplicate records. History overlap is deduplicated as a multiset, preserving genuine duplicate messages within either source, full text, IDs and timestamps. Credentials are redacted and historical credential provenance is always false. Legacy hashed scopes remain compatible without reconstructing identities. Unsafe facts/lessons fail closed. SQLite remains a dependency only to read old reminder rows; no runtime SQLite writes exist. Reminder numeric IDs and due/state values migrate unchanged, and new IDs continue above the imported maximum. A claimed/uncertain reminder is never automatically resent. Mongo atomically enforces the 100 pending limit per chat and claims each delivery before sending. Pending rows remain atomic and bounded to 100 per chat. Terminal audit retains the 100 highest scheduling IDs per chat; retention is scheduling order, not completion time. Uncertain claims are never retried, even after their audit entries are pruned. Reminder delivery rechecks the current Telegram chat allowlist before claiming and immediately before sending; revoked destinations are quarantined. A send already handed to the transport cannot be recalled.

Before production migration, stop old writers and take a filesystem backup of the entire data directory. Check imported counts and source hashes before deleting any legacy backup. Do not expect migration to recover history already discarded by the old 40-message cap. Indexes are created automatically, including owner/chat chronology, message anchors and a language-neutral full-text index. `HISTORY_LIMIT` bounds only model context, never persisted history. `npm test` requires a reachable real Mongo service through `MONGODB_URI`; each test process uses its own temporary database and removes it at exit. The tests never use production namespaces.

## Learned notes

Set `LEARNING_OWNER_IDS` to the two exact Telegram sender IDs. Empty disables mutation and wildcards never grant permission. After eligible direct owner conversations or worker tasks, a debounced background reflection extracts bounded, exact owner-text excerpts for style, slang, preferences and corrections. `learn_lesson` saves explicit teaching immediately. Notes load on later chat and worker turns as advisory data, never replacement system rules, permissions or authorization. Notes are scoped to both authenticated owner and chat; one owner's preferences never appear in the other's DM.

Ordinary conversation prioritizes specific, playful banter over unsolicited assistance: affectionate comebacks, real tastes and dry deadpan with an occasional shrine-cat angle, not scripted lines or repeated temple scenery. Genuine distress is not a roast invitation, and actual requests still get useful answers. `deploy/live-banter.mjs` exercises actual medium-effort responses for both owners, including teasing, opinions, contextual follow-ups and those boundaries; review its transcript for humor and specificity rather than treating output variety as a quality score. Conversation style avoids echoing greetings, recurring persona catchphrases and emoji signatures. A history-aware per-turn reminder asks for at least fourteen emoji-free assistant messages between optional emoji messages, and avoids the last emoji. This is model guidance, not a hard output filter, so task artifacts and requested quotations remain intact. Old assistant replies are not style templates. Reflected style lessons need contextual usage or explicit teaching; isolated slang and bare greetings are excluded both at persistence and at prompt loading (including restored older notes). Learned notes cannot override these persona constraints.

Only newly received, transport-marked direct text is eligible. Old history, forwards, quotes, code blocks, attachments and transcripts are excluded, as are suspicious pasted web/file material and credential patterns. Reflection never receives raw tool output, model replies, screenshots, file contents or web results. Reflection retains whole owner sentences or lines, preserving negation rather than picking misleading fragments. Learned notes are passed as user-level advisory data, not system instructions. Procedure lessons record actual executed tool names and exit/failure metadata. A short recipe is retained only if the command appears in the current direct owner request and passes conservative filters. An exit code is not a claim the overall task succeeded; lessons explicitly require fresh verification and a current authorized request. Automatically generated arbitrary scripts are not retained as recipes.

MongoDB holds owner/chat-hashed learned envelopes with current and bounded prior revisions in one atomic document. Revision compare-and-swap prevents lost concurrent writes; facts use the same concurrency protection. Defaults are 32 lessons, 16 KiB per current snapshot and 10 previous snapshots per scope. Duplicate kind/text entries are normalized; oldest lessons are evicted at the cap. `list_lessons`, explicitly requested `remove_lesson`, and exact owner-approved `rollback_lessons` support inspection and rollback, including a fresh revision of the rollback. Restoring any revision revalidates secret and size checks. Reflection remains nonblocking, one call at a time, rate-limited and aborts during shutdown. Legacy `DATA_DIR/learned` JSON files are migration-only backups and are never rewritten.

Known environment credentials and common token, key, password, authorization, URL-secret and policy-override patterns are rejected before reflection and persistence. This is not a proof that every unknown secret or unmarked copied passage can be recognized. Owners should never teach credentials or paste untrusted instructions as their own teaching. Learned text remains lower-priority untrusted data; neither model judgment nor regex filters alone are a perfect semantic injection detector.

The isolated live regression checks actual Responses teaching/reflection, later preference use after disk reload, both owners, real sandbox success/failure sequences, rollback and negative boundaries without contaminating production notes or sending Telegram messages.

```sh
sudo docker compose exec -T core node --input-type=module < deploy/live-learning.mjs
```

## Model context budgets

`CHAT_CONTEXT_TOKENS` and `WORKER_CONTEXT_TOKENS` default to 256000 independently (integer range 4096-2000000). Main chat and worker initial inputs and every model step, including tool results and worker inbox messages, are budgeted. Only the model message view is compacted into a running advisory summary; persisted Mongo history and input objects remain unchanged. Existing history selection limits still apply before this token ceiling. Oldest call/result spans, including parallel tool calls, are summarized atomically instead of leaving orphan tool results. Recent images survive when they fit; older binary media is represented by an omission marker in the advisory summary, not fabricated visual content. Summaries live in Mongo `context_summaries` keyed by namespace, chat, authenticated owner and, for workers, job ID. Raw history is never replaced by a summary. Summaries are user-role untrusted advisory data, never approval or instructions. Summaries are internally tagged with a private symbol, never recognized by a user-controlled text prefix. Compaction begins at 90% of the cap (headroom capped at 32768 tokens), accounting for instructions, schemas and reserved output. A fitting immutable request can consume headroom without being sliced. A separate fully successful checkpoint persists the last-good summary and covered source identities. Degraded extraction never replaces that checkpoint or advances coverage. Successful source spans are excluded from subsequent merges across turns and restarts; history identities include role, message ID, sender, timestamp and occurrence so genuine duplicates remain distinct. Failed new spans remain eligible for recovery. Repeated compaction merges prior advisory context with new older spans, preserving names, relevant IDs, decisions, facts and open tasks when possible.

Summaries retain at most the latest 4096 covered source identities, with a 1MiB serialized envelope, 65536-character text fields and a 512-scope in-memory cache. Legacy oversize/truncated metadata is marked degraded; an evicted identity may be summarized again and cannot support an absence claim. Summarizer calls have no tools or side effects. Each chunk gets up to three attempts, bounded to six attempts and 30 seconds total per compaction; ordinary generation independently uses SDK provider-only `maxRetries=2`. These retries never rerun uncertain side-effect tool steps. On summarizer failure the last usable summary remains present verbatim, with bounded deterministic source excerpts using spare space; without a prior summary, deterministic extraction preserves available source names/facts/decisions/tasks. A degraded marker explicitly warns that details may be missing and raw history must be searched for exact evidence. A finite summary cannot retain every detail of unbounded input, especially one huge tool result; it is never an exact archive or permission record. If Mongo is unavailable, last-good advisory summaries remain in a bounded in-process cache with degraded durability metadata, not a filesystem fallback. Restart during an outage can lose that cache. Immutable instructions and the complete current request still fail closed if too large to fit, with a context-budget error rather than silent slicing.

Authoritative instructions, per-step system reminders and the complete latest authenticated owner request are immutable. Worker original requests are no longer character-sliced. If these cannot fit, generation fails closed before a model call rather than silently losing credentials, approval or safety boundaries. Parent inbox messages remain untrusted context, never fresh permission.

Text uses maintained `gpt-tokenizer` with explicit `o200k_base` BPE counting, including Unicode, code and tool JSON. Special-token-looking input is counted as ordinary text. JSON tool schemas, descriptions and provider tool arguments are counted too. The budget reserves the configured maximum output tokens, 1024 tokens for transport overhead, additional per-message/part/tool framing and 32768 tokens per image/file; binary/string file contents also reserve their length. These modality/framing allowances are deliberately conservative, not exact provider billing. The configured `gpt-6-luna` or an arbitrary endpoint may use an undocumented different encoding or modality accounting; this is an enforced local o200k-based budget, not a guarantee of its remote tokenizer or advertised context capacity. Set a smaller cap if that provider has a smaller window.

## Security

The core container mounts `/var/run/docker.sock`. Anyone who controls the core process controls the Docker host, effectively root. Keep the bot token and OpenAI key secret, keep the allowlists tight, and run it on a machine you'd be fine losing. Sandboxed users can't reach the socket, but a container escape or kernel bug would expose the host. Prompt injection from web pages or files can try to make the model run commands; the tool only runs for an authenticated allowlisted owner in an explicitly authorized chat, but treat that sender's sandbox as untrusted.


Owner no-new-privileges hardening retains UID1000 for the desktop, but authenticated shell commands execute as already-bounded container UID0 through the trusted Docker core. This avoids relying on setuid sudo escalation, which no-new-privileges correctly forbids for UID1000. Root shell commands, including sudo and apt, work without a command allowlist; calling sudo from an ordinary UID1000 desktop terminal cannot elevate under this setting. No owner capability was added. The guard's trusted PID1 installs its ephemeral policy before sleeping; the manager independently waits for installation and checks readiness. A file lock prevents concurrent PID1/manager installs. Current live evidence confirms UID0 NoNewPrivs1, capset/raw-socket/setns EPERM, DNS/public IPv4 HTTPS/apt success, core desktop200 and private-resolved host.docker.internal denial using a Linux hosts-entry fixture, not native Desktop DNS. Resolver127.0.0.11 non-DNS ports are rejected. Desktop remains unverified.


## Environment reference

Supported runtime and Compose variables follow. Defaults match .env.example; blank optional overrides are omitted. Recreate via Docker Compose to apply changes. Presentation cannot change runtime authorization.

### Identity and operator prompts

| Variable | Template default | Purpose |
| --- | --- | --- |
| PERSONA_PATH | ./persona.md | Persona file INSIDE container; default mounted file. Never set to a host-only path. |
| BOT_NAME | (blank) | Display name; blank uses shipped identity.json default. |
| BOT_PERSONALITY | (blank) | Additional operator personality text; does not alter permissions. |
| SYSTEM_PROMPT | (blank) | Inline system presentation; takes precedence over prompt/persona files. |
| SYSTEM_PROMPT_PATH | (blank) | Prompt file path INSIDE container, e.g. /app/config/prompt.md. |
| PERSONA_TEXT | (blank) | Inline persona fallback when no system prompt override is supplied. |
| CHAT_STYLE_MODE | (blank) | Blank auto-selects default style or persona-only for custom presentation; default, persona, custom. |
| CHAT_STYLE_TEXT | (blank) | Inline custom style, replacing fixed conversational guidance only. |
| CHAT_STYLE_PATH | (blank) | Style file INSIDE container; inline style wins. |
| PERSONA_FILE | ./persona.md | Host file mounted read-only at /app/persona.md. |
| CONFIG_DIR | ./config | Host configuration directory mounted read-only at /app/config. |

### Language-model provider and budgets

| Variable | Template default | Purpose |
| --- | --- | --- |
| OPENAI_API_KEY | (blank) | Language-model provider credential; never commit .env. |
| OPENAI_MODEL | gpt-6-luna | Main chat model. |
| OPENAI_REASONING_EFFORT | low | Responses reasoning effort: none, low, medium, high, xhigh, max |
| CHAT_MAX_STEPS | 12 | Chat max steps. |
| CHAT_CONTEXT_TOKENS | 256000 | Chat context tokens. |
| WORKER_CONTEXT_TOKENS | 256000 | Worker context tokens. |
| OPENAI_WORKER_EFFORT | high | Worker reasoning budget; independent of chat effort. |
| WORKER_TIMEOUT_MS | 600000 | Worker timeout ms. |
| WORKER_MAX_OUTPUT_TOKENS | 4096 | Worker max output tokens. |
| WORKER_MAX_STEPS | 24 | Worker max steps. |
| WORKER_MAX_CONCURRENT | 2 | Worker max concurrent. |
| OPENAI_BASE_URL | https://api.openai.com/v1 | Responses provider URL prefix for all language-model calls. |
| OPENAI_WORKER_MODEL | (blank) | Independent worker model. |
| OPENAI_SUMMARY_MODEL | (blank) | Independent chat/worker compaction model. |
| OPENAI_LEARNING_MODEL | (blank) | Independent learning observer model. |
| OPENAI_REVIEW_MODEL | (blank) | Independent draft review model. |

### Telegram

| Variable | Template default | Purpose |
| --- | --- | --- |
| TELEGRAM_BOT_TOKEN | (blank) | Telegram bot token. |
| TELEGRAM_ALLOWED_CHATS | (blank) | Exact chat IDs, comma separated. Empty denies all. * allows all (not recommended). |
| TELEGRAM_GROUP_MODE | ambient | ambient lets the model choose explicit delivery or silence. mentions accepts mentions/replies only. |
| ENABLE_REACTIONS | true | Enable reactions. |

### WhatsApp

| Variable | Template default | Purpose |
| --- | --- | --- |
| DISCORD_ENABLED | false | Opt-in authenticated bot DMs only; see [Discord setup](DISCORD.md). |
| DISCORD_BOT_TOKEN | (blank) | Private Discord bot token. |
| DISCORD_ALLOWED_USERS | (blank) | Exact decimal user snowflakes; comma-separated, no wildcard. |
| DISCORD_OWNER_IDS | {} | JSON string user-to-canonical-owner IDs; every user mapped to an explicit SANDBOX_ALLOWED_USERS entry. |
| WHATSAPP_ENABLED | false | Opt-in text/image transport; requires private pairing and explicit owner mappings. |
| WHATSAPP_AUTH_DIR | /run/kamakura-whatsapp | Private absolute auth mount; Compose fixes this path. Provision separately before enabling. |
| WHATSAPP_ALLOWED_NUMBERS | (blank) | Exact E.164 phone numbers, comma-separated; no wildcard. |
| WHATSAPP_OWNER_NUMBERS | {} | JSON phone-to-canonical-owner-ID mapping; current authorized owner restriction remains. |
| WHATSAPP_LID_BINDINGS | {} | Optional JSON operator-bound LID-to-authorized-phone mapping. |

### Storage and embeddings

| Variable | Template default | Purpose |
| --- | --- | --- |
| DATA_DIR | ./data | Data dir. |
| MONGODB_URI | mongodb://mongo:27017 | Sole runtime storage. Compose mongo has no auth or public ports, core-only internal network. |
| MONGODB_DATABASE | kamakura | Mongodb database. |
| MONGODB_IMAGE | mongodb/mongodb-community-server:8.0-ubi8 | Stable 8.0 default requires supported kernel. Linux 6.19..7.0.13 needs a kernel upgrade. An explicit mongo:7.0 image can support older test hosts; never downgrade an existing 8.0 database. |
| HISTORY_LIMIT | 40 | History limit. |
| HISTORY_CONTEXT_MESSAGES | 3 | Same-owner chronological neighbors on each side of search hits, merged by stored record identity. |
| STORAGE_BUFFER_MAX_BYTES | 16777216 | Bounded fsynced history recovery journal, not an alternate database. |
| EMBEDDING_BASE_URL | (blank) | Independent embedding URL prefix. All three service settings are required; no keyword fallback or backfill. |
| EMBEDDING_API_KEY | (blank) | Embedding api key. |
| EMBEDDING_MODEL | (blank) | Embedding model. |
| EMBEDDING_DIMENSIONS | 768 | Embedding dimensions. |
| EMBEDDING_TIMEOUT_MS | 5000 | Embedding timeout ms. |
| EMBEDDING_MIN_SCORE | 0.3 | Embedding min score. |

### Learning and optional reply review

| Variable | Template default | Purpose |
| --- | --- | --- |
| LEARNING_OWNER_IDS | (blank) | Exact authenticated owners permitted to teach lessons. Empty disables writes, * never works. |
| ENABLE_LEARNING | true | Enable learning. |
| LEARNING_MAX_BYTES | 16384 | Learning max bytes. |
| LEARNING_MAX_LESSONS | 32 | Learning max lessons. |
| LEARNING_REVISIONS | 10 | Learning revisions. |
| LEARNING_DEBOUNCE_MS | 15000 | Learning debounce ms. |
| LEARNING_INTERVAL_MS | 60000 | Learning interval ms. |
| LEARNING_TIMEOUT_MS | 30000 | Learning timeout ms. |
| ENABLE_REPLY_REVIEW | false | Experimental casual draft editor, disabled until blind evaluation supports enabling it. Adds one model call per eligible bubble. Tool results, progress, voice and fenced code bypass it. Network/timeout failures preserve the original draft; factuality is not guaranteed. |
| REPLY_REVIEW_TIMEOUT_MS | 12000 | Reply review timeout ms. |

### Time, delivery and request limits

| Variable | Template default | Purpose |
| --- | --- | --- |
| DEFAULT_TIMEZONE | UTC | IANA timezone fallback, then optional per-owner numeric Telegram-ID overrides. |
| OWNER_TIMEZONES | {} | Owner timezones. |
| DEBOUNCE_MS | 1500 | Quiet-window debounce ms; configurable from 100 to 60000. |
| LATENCY_METRICS | false | Content-free monotonic turn/model/tool/send timings and provider cache counts. |
| FAST_MODEL | (blank) | Optional model for every step of isolated plain casual DM turns only. |
| ELIDE_TOOL_OUTPUTS | true | Model-view-only elision of older completed passive read bodies before compaction. |
| MESSAGE_DELAY_MS | 800 | Message delay ms. |
| MAX_REPLY_MESSAGES | 3 | Max reply messages. |
| MAX_REPLY_CHARS | 1200 | Max reply chars. |
| MAX_INPUT_CHARS | 8000 | Max input chars. |
| MAX_OUTPUT_TOKENS | 2048 | Max output tokens. |
| MAX_CONCURRENT_REQUESTS | 2 | Max concurrent requests. |
| REQUEST_TIMEOUT_MS | 120000 | Request timeout ms. |
| ENABLE_WEB_SEARCH | true | Enable web search. |
| LOG_LEVEL | info | Log level. |
| TZ | (blank) | Legacy timezone fallback when DEFAULT_TIMEZONE is absent; blank uses UTC. |

### Independent speech and media

| Variable | Template default | Purpose |
| --- | --- | --- |
| SPEECH_TTS_BASE_URL | (blank) | Optional TTS has its own credentials. All blank is OFF; partial is an error. |
| SPEECH_TTS_API_KEY | (blank) | Speech tts api key. |
| SPEECH_TTS_MODEL | (blank) | Speech tts model. |
| SPEECH_TTS_VOICE | (blank) | Speech tts voice. |
| OPENAI_TRANSCRIBE_MODEL | gpt-transcribe | Incoming voice/video transcription model; independent endpoint below. |
| OPENAI_TRANSCRIBE_BASE_URL | (blank) | Independent speech host/key. Custom host requires its own key; no chat-key forwarding. |
| OPENAI_TRANSCRIBE_API_KEY | (blank) | Openai transcribe api key. |
| VISION_ENABLED | true | Permit static JPEG/PNG/WebP inspection only when configured provider/model supports image input. |
| MAX_MEDIA_BYTES | 20971520 | Max media bytes. |
| MEDIA_TIMEOUT_MS | 90000 | Media timeout ms. |
| VIDEO_MAX_SECONDS | 20 | Video max seconds. |
| AUDIO_MAX_SECONDS | 300 | Audio max seconds. |

### Desktop gateway

| Variable | Template default | Purpose |
| --- | --- | --- |
| NOVNC_PUBLIC_URL | (blank) | Public HTTPS gateway origin; blank disables desktop links. |
| NOVNC_BIND_ADDRESS | 127.0.0.1 | Novnc bind address. |
| NOVNC_PORT | 47831 | Novnc port. |
| NOVNC_HOST | 0.0.0.0 | Container listener. Compose publishes the gateway on host loopback by default. |
| NOVNC_TRUSTED_PROXIES | (blank) | Exact immediate proxy peer IPs as seen by the gateway, not client IPs/CIDRs. Host nginx via Compose may appear as the Compose bridge gateway, e.g. 172.18.0.1. |
| DESKTOP_TOKEN_TTL_MS | 3600000 | DESKTOP_PUBLIC_BASE_URL, DESKTOP_PORT, DESKTOP_HOST and DESKTOP_BIND_ADDRESS remain fallback aliases. NOVNC_* takes precedence when set. One-time path bootstrap and independent cookie session lifetime, 1 hour default, 24 hours max. |
| DESKTOP_PUBLIC_BASE_URL | (blank) | Legacy public origin alias; NOVNC_PUBLIC_URL takes precedence. |
| DESKTOP_PORT | 47831 | Legacy port alias used only when NOVNC_PORT is unset. |
| DESKTOP_HOST | 0.0.0.0 | Legacy listener alias used only when NOVNC_HOST is unset. |
| DESKTOP_BIND_ADDRESS | 127.0.0.1 | Legacy publish alias used only when NOVNC_BIND_ADDRESS is unset. |

### Sandbox storage, resources and isolation

| Variable | Template default | Purpose |
| --- | --- | --- |
| SANDBOX_ALLOWED_USERS | (blank) | Exact numeric Telegram sender IDs. No wildcard. Commands available in DMs only. |
| SANDBOX_IMAGE | kamakura-sandbox:local | Sandbox image. |
| SANDBOX_EGRESS_IMAGE | kamakura-egress:local | Writable root and full passwordless sudo, with an external firewall per owner. |
| SANDBOX_DENIED_IPS | (blank) | Also deny host/LAN public IPs, if any (comma-separated numeric addresses). |
| SANDBOX_ROOTFS_SIZE | (blank) | Optional classic overlay2/XFS root quota only. Leave blank on Desktop. |
| SANDBOX_DOCKER_SOCKET | /var/run/docker.sock | Same Docker daemon by default, never exposed to user containers. |
| CORE_DOCKER_SOCKET_PATH | /var/run/docker.sock | Core docker socket path. |
| SANDBOX_INSTANCE | default | Sandbox instance. |
| SANDBOX_DISK | 35G | Sandbox disk. |
| SANDBOX_CPUS | 2 | Sandbox cpus. |
| SANDBOX_MEMORY | 3g | Sandbox memory. |
| SANDBOX_PIDS | 256 | Chromium + XFCE need headroom for threads and Docker exec. |
| SANDBOX_IDLE_SECONDS | 1800 | Sandbox idle seconds. |
| SANDBOX_COMMAND_TIMEOUT_SECONDS | 30 | Sandbox command timeout seconds. |
| SANDBOX_MAX_OUTPUT_BYTES | 16000 | Sandbox max output bytes. |
| SANDBOX_ROOT | ./sandboxes | Host bind root. Compose resolves relative paths against the project directory. |
| SANDBOX_ALLOW_SOFT_QUOTA | false | Explicitly accepts a SOFT pre-command disk check, not a hard disk quota. |
| DOCKER_GID | 0 | Linux socket group, from stat -c '%g' /var/run/docker.sock. Usually 0 on Desktop. |
| SANDBOX_NETWORK_NAME | (blank) | Optional sandbox network name; blank uses instance-specific name. |
| DOCKER_SOCKET_PATH | /var/run/kamakura-sandbox.sock | Container sandbox socket; Compose fixes this protected path. |
| SANDBOX_ROOT_VIEW | /app/sandboxes | Container workspace view; Compose fixes read-only bind path. |

### Owner-local connector

| Variable | Template default | Purpose |
| --- | --- | --- |
| LOCAL_DEVICES_ENABLED | false | Explicit opt-in owner-local connector, worker tools only. Separate TLS/WSS proxy. |
| LOCAL_DEVICES_HOST | 0.0.0.0 | Local devices host. |
| LOCAL_DEVICES_PORT | 47943 | Local devices port. |
| LOCAL_DEVICES_BIND_ADDRESS | 127.0.0.1 | Local devices bind address. |
| LOCAL_DEVICES_PUBLIC_URL | (blank) | Local devices public url. |

## Latency controls

Set these in .env; Compose passes them through env_file. LATENCY_METRICS records random turn IDs, durations and provider-reported token/cache counts, never prompts, outputs or owner/chat IDs. Missing provider cache accounting is null, not zero, including when the SDK normalizes a missing cached_tokens field to zero. Nonstream calls have null TTFT; streaming first-provider-event is not first content, which may be reasoning or tool input. Current chat remains nonstream. Turn total includes batching wait; tool and send durations overlap, so do not add all stages.

FAST_MODEL is disabled when blank. Only exact short greetings/acknowledgments in plain DMs with exclusively trivial retained history qualify. Media, replies, groups, arbitrary questions, emotional statements and task requests use the main model. Fast turns require FAST_BASE_URL, FAST_API_KEY and FAST_MODEL together. Every step stays on fast and can only send, react or end silently. Provider failures never retry through main; delivery guards prevent replay. No second classifier request. Configured persona, permissions and delivery gates remain unchanged. Measure your chosen model before enabling it; no speedup or personality equivalence is assumed.

ELIDE_TOOL_OUTPUTS retains recent and active results, protocol IDs/inputs, metadata, paged reads, failures, approval cues, history evidence, mutations and task statuses. Only large old completed read_file/web_fetch JSON text bodies are replaced in the model view; durable storage is unchanged. The model can re-read with original arguments. Set false to disable. Compaction and hard context caps remain in force.

DEBOUNCE_MS defaults to 1500 and remains configurable. Earlier latency measurements using 4000 ms describe the historical configuration, not this new default. A lower quiet window can send more generations into cancellation during bursts; test typing/arrival patterns before tuning. No provider cache-hit guarantee is made.


### Provider migration

Remove PROVIDER_API_KEY; a nonblank retired key now stops startup with a sanitized error. Populate each used part’s own URL/key/model even if deliberately using the same service. Main and embeddings validate at startup, as do enabled review and learning with numeric owners. FAST is all blank OFF, partial is an error. Worker, actual compaction and media transcription validate before their own request; missing settings are not swallowed. TTS is all fields blank OFF, partial is an error. Enabled Discord voice validates Live and backend before IPC/login. OFF voice stays inert. The public example carries only suggested URLs/models, not runtime defaults or secrets. Redirects are disabled for all provider requests, and unrelated organization/project headers are not forwarded. No deployment or data migration is implied.
