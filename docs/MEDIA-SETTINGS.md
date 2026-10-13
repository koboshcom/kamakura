# Media settings

## Defaults versus beta

The environment template leaves private voice-note STT and Gemini credentials blank. They are disabled until their independent configuration is supplied. The currently enabled beta has separate STT and Gemini triplets and Google Search grounding enabled. This is operator configuration, not a template default. Never copy keys into documentation, owner boxes or model input.

## Voice notes

`STT_URL`, `STT_KEY`, `STT_MODEL` are independent of video transcription and Discord voice calls. The default model is `Systran/faster-distil-whisper-large-v3`. Blank URL/key disables the path; partial configuration fails. No main/video/provider fallback. Multipart language is omitted for automatic detection. Default limits are `MAX_MEDIA_BYTES=20971520`, `AUDIO_MAX_SECONDS=300`, `MEDIA_TIMEOUT_MS=90000`. Local probe/decode and authenticated upload share cancellation and cleanup. Transcripts enter history as untrusted user-labelled `VOICE NOTE`, never instructions or credential authorization. See [voice notes](../voice/VOICE-NOTES.md).

## Video and public posts

Gemini requires its own `GEMINI_VIDEO_BASE_URL`, `GEMINI_VIDEO_KEY`, `GEMINI_VIDEO_MODEL`; the model has no runtime default. Native YouTube uses a strict `https://www.youtube.com/watch?v=ID` identity, dropping playlist and share queries. Metadata is publisher data, not visual confirmation. Native success downloads no local video bytes. Eligible native rejection permits one bounded existing-media fallback; auth, rate-limit, cancellation and unknown duration do not. Cached followups still make fresh inference requests.

Verified duration below 300 seconds selects static processing; 300 seconds or more selects agentic processing. Default long coverage is 1800 source seconds, configurable up to 3600, not a promise of inspecting every frame. Source duration is distinct from the 60-second cumulative extraction runtime. Default local output is 360 pixels, 1 FPS and LOW resolution. Existing byte/time/attempt bounds still apply. Cache defaults are 300 seconds fixed TTL, 32 handles, 16777216 bytes global and eight source questions. See [video details](../voice/GEMINI-VIDEO.md).

`MEDIA_POST_MAX_SLIDES=20`, `MEDIA_POST_MAX_BYTES=33554432`, `MEDIA_POST_MAX_PIXELS=80000000`, `MEDIA_POST_RUNTIME_SECONDS=60`, `MEDIA_POST_IMAGE_BYTES=8388608`, `MEDIA_POST_OUTPUT_BYTES=8388608`, `MEDIA_POST_DIMENSION=1024` (maximum 1536), `MEDIA_POST_VIDEO_SECONDS=1800` bound a shared post ledger. Ordered images/videos retain explicit omissions and coverage. Images are validated, resized and EXIF-stripped. Owner/channel caches and opaque handles do not cross owners. Captions/polls are untrusted metadata. Public-only Instagram has no implemented cookie-file mapping, browser-cookie extraction or login. YouTube Community embedded video remains unsupported. See [Instagram slides](../voice/INSTAGRAM-POSTS.md) and [Community posts](../voice/YOUTUBE-POSTS.md).

## Grounding and privacy

`GEMINI_VIDEO_GOOGLE_SEARCH=false` by default. When enabled, only actual provider Search evidence and valid Search Suggestions qualify for a result link. The original Gemini answer and suggestions appear on a top-level page. Its random bearer grants result-only access to anyone possessing the link; it is not authenticated owner login. Default expiry is 120 seconds, with hashed tokens, no-store, no-referrer, noindex and frame-ancestor denial. No result page is claimed when Search was not actually used.

Keys remain core-only. URL fetchers enforce public host/DNS rules, bounded transfers and redirect restrictions. No media/transcripts, private signed URLs or credentials belong in logs. Offline fixtures prove routing, wire validation and boundaries, not live messaging, long-video recognition quality or actual billing.
