# Kamakura

Kamakura is an AI cat you can talk to on Telegram, with optional WhatsApp support.
It remembers things, handles images and voice notes, and can work in a private Linux box.
You run it on your own computer or server.

## Quick setup

Run Kamakura with Docker Compose on every platform. You'll need Git, a Telegram bot token from @BotFather and an API key for the configured model. Docker installs the runtime dependencies.

### macOS / OrbStack

1. Install and open [OrbStack](https://orbstack.dev/download). Run `docker context use orbstack`. On Apple Silicon, use the default native build.
2. Clone the repo and copy `.env.example` to `.env`. Add your keys and allowed chat IDs.
3. Follow the [Mac/Windows storage steps](docs/DETAILS.md#setup) before enabling boxes. They use soft disk checks, not a hard limit.
4. Run the build/start commands below.

### Windows / WSL2 + Docker Desktop

1. Install/update WSL2 and [Docker Desktop](https://docs.docker.com/desktop/features/wsl/). Enable Linux containers and WSL integration. This is what production uses.
2. Open your WSL Linux shell. Clone into its Linux filesystem, not `/mnt/c`.
3. Copy `.env.example` to `.env`, add your keys and allowed chat IDs, then follow the [Windows storage steps](docs/DETAILS.md#setup).
4. Run the build/start commands below from WSL. No second Docker daemon is needed.

### Linux / Docker Engine

1. Install [Docker Engine and Compose](https://docs.docker.com/engine/install/).
2. Clone the repo and copy `.env.example` to `.env`. Add your keys and allowed chat IDs.
3. Set the Docker socket group and prepare data/workspace storage using the [Linux setup steps](docs/DETAILS.md#setup).
4. Run the build/start commands below. Use `sudo docker` if your account needs it.

```sh
git clone https://github.com/koboshcom/kamakura.git
cd kamakura
cp .env.example .env
# Edit .env and prepare storage before continuing.
docker compose --profile build build sandbox-image egress-image
docker compose config --quiet
docker compose up -d --build
```

You can also clone from [Forgejo](https://git.yuk1n0w.dev/yuk1n0w/Mochi).

See [the detailed guide](docs/DETAILS.md) for settings, boxes, disk limits, security and deployment notes. The [environment template](.env.example) groups all settings. Customize the name, prompt and personality there; mount prompt files under /app/config. Provider URLs and chat/worker models are configurable. See the [environment reference](docs/DETAILS.md#environment-reference) for precedence and defaults. When upgrading, keep existing data and database versions intact.

Optional [Discord owner DMs](docs/DISCORD.md) and [image input](docs/VISION.md) are documented separately.

Media configuration and privacy are covered in [the media settings guide](docs/MEDIA-SETTINGS.md).

Updates for standard Compose installs: `./update.sh`. CLI: `kamakura-cli update`. [Rollback, opt-in automation and platform limits](docs/UPDATES.md). Auto-updates stay off.

Basic settings live in `.env`; tuning is optional in `.env.advanced`. Mongo is the default; SQLite has a no-Mongo Compose companion. See [configuration](docs/CONFIGURATION.md).
