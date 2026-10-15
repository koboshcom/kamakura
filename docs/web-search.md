# Private web search

Set `ENABLE_WEB_SEARCH=true` in `.env.advanced` and a random `SEARXNG_SECRET` (for example, `openssl rand -hex 32`). Start with `docker compose --profile search up -d`. Keep private overrides in `.env` consistent if present.

`SEARXNG_URL` defaults to `http://searxng:8080`; `WEB_SEARCH_TIMEOUT_MS` defaults to 15000. Disable the tool with `ENABLE_WEB_SEARCH=false`. An existing SearXNG instance can be used instead of starting the bundled service.

Only DuckDuckGo is loaded. JSON search is enabled, the limiter is off, and no host port is published. The internal core link is isolated; a second Docker network supplies outbound internet access, which DuckDuckGo requires. Do not publish this service without authentication and rate limiting. Results are untrusted excerpts, not full-page reads. Errors are reported rather than fabricated as empty results.
