# Public Instagram slides

`watch_video` accepts public `/p/` and `/reel/` posts as ordered images/videos. Pinned yt-dlp extracts public product metadata; no cookies, browser automation, login or HTML scraping. All fetching stays in the owner's public-only box. CDN hosts are restricted, public DNS checked, and redirects refused before following.

Pillow validates JPEG/PNG/WebP magic and pixel dimensions, applies orientation, removes EXIF, resizes and outputs JPEG. Duplicate references preserve indices. Video slides reuse bounded local duration probing and conversion. One shared post ledger covers every slide. Videos under 300 seconds use static processing; longer videos use documented Interactions agentic streaming with the existing bounded parser. Mixed posts use one request containing ordered native media parts.

Defaults and environment limits

| Variable | Default / maximum |
| --- | --- |
| MEDIA_POST_MAX_SLIDES | 20 |
| MEDIA_POST_MAX_BYTES | 33554432 aggregate transfer bytes |
| MEDIA_POST_MAX_PIXELS | 80000000 cumulative source image pixels |
| MEDIA_POST_RUNTIME_SECONDS | 60 |
| MEDIA_POST_IMAGE_BYTES | 8388608 per input image |
| MEDIA_POST_OUTPUT_BYTES | 8388608 aggregate encoded media |
| MEDIA_POST_DIMENSION | 1024 / 1536 |
| MEDIA_POST_VIDEO_SECONDS | 1800 cumulative source video seconds |

Existing per-owner source bytes, question count, global cache count/bytes and TTL also apply. Every returned index has processed, duplicate or omitted status and a bounded reason. A known total is separate from complete coverage; unknown totals never claim completeness. A processed slide has an opaque owner/channel-bound handle sharing its parent budget. Followups always submit the fresh actual question. Expiry removes cached media and aliases.

Metadata is bounded, labelled untrusted publisher data and never visual confirmation. Gemini credentials remain core-only. Luna, YouTube/TikTok and existing grounding page behavior are unchanged. Search links appear only with actual provider search metadata and valid suggestions. No private-person identification or media generation.
