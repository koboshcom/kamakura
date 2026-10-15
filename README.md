# Kamakura

A self-hosted AI cat for Telegram, with optional WhatsApp and Discord owner DMs.

## Features

- Conversation history, facts and reminders.
- Images, voice notes and bounded video inspection with separately configured providers.
- Private Linux boxes and an optional paired computer-use CLI.
- Mongo storage by default, or SQLite without Mongo.

## Prerequisites

Git and Docker Compose 2.24.4 or newer, a Telegram bot token, and independent main-model and embedding-provider credentials. Docker builds the runtime dependencies.

Use Docker Engine on Linux, OrbStack on macOS, or Docker Desktop with WSL2 on Windows. Follow the [platform storage setup](docs/DETAILS.md#setup) before starting; on WSL, keep the checkout in the Linux filesystem.

## Quick start

```sh
git clone https://github.com/koboshcom/kamakura.git
cd kamakura
cp .env.example .env
# Add credentials and owner IDs; prepare storage using the setup guide.
docker compose --profile build build sandbox-image egress-image
docker compose config --quiet
docker compose up -d --build
```

[Forgejo mirror](https://git.yuk1n0w.dev/yuk1n0w/Mochi).

## Configuration

Channel access in `.env`: tokens for enabled channels and their owner IDs or allowlists.
Main model in `.env`: model, base URL and API key.
Embeddings in `.env`: independent model, base URL and API key.
Storage and timezone in `.env`: `STORAGE` and `DEFAULT_TIMEZONE`.

For optional tuning, copy the root `.env.advanced.example` to `.env.advanced`. Tuning has sensible defaults; optional features may require their own credentials. See [CONFIGURATION.md](docs/CONFIGURATION.md) for all settings and precedence.

Mongo is the default. For SQLite, set `STORAGE=sqlite` in `.env`, then run

```sh
docker compose -f compose.yaml -f compose.sqlite.yaml up -d --build
```

This runs without Mongo. SQLite starts empty; existing data is not migrated.

## Updates

Server updates for standard Linux Compose installs use `./update.sh`. Update the stopped CLI connector with `kamakura-cli update`. Auto-updates stay off.

Wait for the chosen commit's CI to publish its GHCR image and CLI release before updating; a pushed commit alone does not mean either artifact is available. See [update and rollback details](docs/UPDATES.md).

## Documentation

- [Setup, storage, boxes and security](docs/DETAILS.md)
- [Configuration reference](docs/CONFIGURATION.md)
- [Discord owner DMs](docs/DISCORD.md)
- [Images](docs/VISION.md) and [media settings](docs/MEDIA-SETTINGS.md)
- [Computer-use CLI](cli/README.md)

Optional Bing and Mojeek search works with every LLM provider. See [search setup](docs/web-search.md).
