# Private voice notes

Telegram voice/audio, WhatsApp decrypted audio (including ptt), and allowlisted Discord DM audio attachments use independent STT_URL, STT_KEY and STT_MODEL settings. The default model is Systran/faster-distil-whisper-large-v3; set an explicit model ID if your Speaches registry uses a qualified ID. No other key, model or transcription provider is a fallback.

STT_URL accepts a server root, /v1 base, or full /v1/audio/transcriptions endpoint. Blank URL and key disable download/transcription; partial configuration fails at startup. Multipart includes file, model and response_format=json. Language is omitted for automatic detection. Redirects and retries are disabled.

Owner authorization precedes downloads and is rechecked before/after transcription. Existing MAX_MEDIA_BYTES, MEDIA_TIMEOUT_MS and AUDIO_MAX_SECONDS bounds apply. Untrusted bytes are probed and decoded locally under process memory/CPU/file-size limits; no remote decoder protocols. Unknown duration gets a bounded local decode, never a guessed duration or silently shortened transcript. Digital silence and empty results produce a friendly no-speech indication. Temporary audio is deleted on success, failure and cancellation.

Luna receives user-labelled VOICE NOTE evidence. It is user content, never system instructions or a credential authorization. No transcript/audio/request URL/provider-error-body logs; no STT key in an owner sandbox. Existing video STT, voice calls, Luna and provider settings are unchanged.

Transport fixtures verify admission and routing, not live messaging end-to-end. Primary API references are https://speaches.ai/usage/speech-to-text/ and https://github.com/speaches-ai/speaches/blob/master/src/speaches/routers/stt.py .
