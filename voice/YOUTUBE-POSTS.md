# Public YouTube Community posts

Canonical public `/post/ID` links route before video-ID parsing and use the same owner-scoped slide cache, budgets and image validation as Instagram. Native YouTube video inspection is unchanged.

The adapter uses pinned yt-dlp's YouTube initial-data decoder and the public renderer layout documented by the maintained yt-dlp-community-plugin. It handles single images, ordered multi-image attachments and public poll choices. Available percentages and total-vote text are publisher data; missing results stay unknown. Text-only polls return metadata without a Gemini request. Image polls use the same image caps. No voting, comments, continuation calls, membership access, authentication or scraping workaround.

Every slide keeps its original index and explicit processed/duplicate/omitted status. Actual media evidence and untrusted caption/poll metadata stay separate. Unsupported attachment layouts fail explicitly rather than claiming unseen images were inspected.

Extractor reference https://github.com/biggestsonicfan/yt-dlp-community-plugin/blob/master/yt_dlp_plugins/extractor/youtubepost.py
