Voice context, main-agent delegation and transcript import are opt-in.

Set DISCORD_VOICE_CONTEXT_ENABLED, DISCORD_VOICE_MAIN_AGENT_ENABLED and
DISCORD_VOICE_TRANSCRIPT_ENABLED to true. All default false.
DISCORD_VOICE_MAIN_CHATS must map every canonical owner to their explicitly
allowlisted private telegram:<owner> chat. Group and other-owner targets fail startup.
DISCORD_VOICE_CONTEXT_BYTES defaults to 4000; TRANSCRIPT_BYTES to 1048576
(with the same DISCORD_VOICE_ prefix).

Starting context is a bounded deterministic digest of recent messages and facts
from that owner chat, plus existing owner-shared facts. It is untrusted evidence.
No extra summarization/transcription service or provider-key fallback is added.

Client delegation supplies metadata, not task text. Captured current user speech
through its timeline offset enters the normal main think/tool path. Its delivery
returns to the matching Live delegation, not a Telegram broadcast. Existing worker
jobs retain their normal private chat completion route. Tool calls check live
cancellation; abort cannot undo an already started external action.

Transcript fragments are fsynced to a separate bounded recovery journal before
acceptance. After the call, or after crash recovery, existing history/embedding
storage imports them idempotently into only the mapped owner chat. Mongo/storage
failures retain pending records. Context, tool results and delegated replies are
not added as spoken transcript.

Live has no final-transcript event or complete-turn guarantee. The archive is all
captured fragments, with roles, timeline offsets and call ID, not proof of complete
speech or assistant audibility. Output transcripts describe generated audio; local
barge-in may have discarded it. Coverage metadata is shown to the main agent.
