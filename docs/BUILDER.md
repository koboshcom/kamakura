# Optional Builder generation

Install uses `github:koboshchan/aisdk-builderio#dist`; the lockfile pins the resolved commit. OpenAI is the unchanged default.

Set `LLM_PROVIDER=builder`, `BUILDER_MODEL=builder-model` and your own `BUILDER_API_KEY`, `BUILDER_USER_ID`, `BUILDER_PRIVATE_KEY`. Set `ENABLE_WEB_SEARCH=false`: Builder has no OpenAI hosted web-search tool. The model ID defaults to `builder-model` (display name **Builder (quality-v4)**). User-supplied advertised metadata is 200000 context tokens and 65536 output tokens; these are not capacity-tested. Chat/worker Builder context defaults to 200000 and is capped at that value; output defaults to 65536 and configured/requested output must not exceed 65536. Existing explicit smaller output settings remain smaller. OpenAI defaults and validation stay unchanged.

Missing credentials, unsupported model IDs and hosted search fail before transport startup. Blank examples never contain credentials.

This selector changes **chat only**. Fast, worker, summary, learning and review stay OpenAI unless their own `FAST_LLM_PROVIDER`, `WORKER_LLM_PROVIDER`, `SUMMARY_LLM_PROVIDER`, `LEARNING_LLM_PROVIDER` or `REVIEW_LLM_PROVIDER` is explicitly `builder`. Each then requires its own `BUILDER_<ROLE>_API_KEY`, `USER_ID`, `PRIVATE_KEY`; `MODEL` defaults to `builder-model`. No role inherits another role's credentials or model. Unselected OpenAI URL/key/model triplets and their activation rules are unchanged. Selected Builder roles never fall back to OpenAI.

Quote special characters in .env using dotenv syntax. Despite its name, privateKey is used as an HTTP bearer token, not a PEM key; whitespace/control characters are rejected without echoing values. Do not log credentials or commit your .env. The SDK does not import your local Builder credential file.

The SDK uses language-model protocol v3. This app's AI SDK v7 accepts v3 models natively, verified with offline SDK requests. Its declared peer range is AI SDK v6, so the project .npmrc enables `legacy-peer-deps` for reproducible npm ci, including Docker; this is a declared peer-range exception, not upstream v7 support. No dependency lifecycle scripts are needed for the prebuilt dist package. Existing native app dependencies still need their usual build/install process.

Offline tests exercise real installed SDK streaming text/reasoning, completed and incremental function calls, tool-result continuation, errors, abort signals and session separation. This is not live Builder service verification. The SDK ignores modelId internally and currently selects quality-v4, so only the explicit `builder-model` choice is accepted.

Limits: text-only input and text/JSON tool output, no vision/files; media is rejected rather than silently omitted. No hosted OpenAI tools, forced/required tool choice, structured-output guarantees (structured responseFormat requests explicitly fail before network), temperature/reasoning controls or standardized token/cache usage. Function tools are model-selected; this app still requires explicit delivery tools, so a model that emits plain text instead may not send a chat reply. No new auto-send fallback is added. Account usage/context metadata may be exposed by the SDK but standardized token counts remain unknown, not zero. Builder has server-side session history/possible compaction; fresh SDK models are created per generation, never shared across owners or roles. No cross-owner result cache or Responses prompt-cache key is used.

Embeddings, Gemini video, GPT-Live, voice backend, STT and TTS are unchanged.

Forced tool choice is rejected before network. A live bounded probe returned only internal compaction completions and no final answer; both raw and public SDK paths correctly failed. Live AUTO tools and continuation remain unverified. HTTP 200 alone is not a success signal.

Each request now uses a fresh crypto UUID, including tool-result continuation.
The installed SDK already creates a random default per model instance, but otherwise
reuses it on repeated calls. Fresh sessions serialize prior turns as transcript plus
new tool results; serialization is tested, not a guarantee of backend acceptance.
Builder generation retries are zero. OpenAI retry/session behavior is unchanged.

Optional SDK fields use providerOptions.builder.softContextWindow (positive integer,
integration ceiling 200000) and errorIfHadCompaction (boolean). They serialize to
same-named completion body fields, not OpenAI options. The pinned SDK and README do
not document window units, a total input/output-budget equation, or server-side
maximum enforcement. The 200000 ceiling is the declared model context metadata,
not measured capacity. No subtraction from output is invented; maxTokens remains
a separate bounded output field. These options are not enabled universally and
compaction-only responses remain failures. Explicit compaction error metadata
produces a safe diagnostic without retaining provider text or identifiers.
