Beta interruption policy is owner-approved best effort, not guaranteed fresh-only playback.

Microphone audio continues during output. The first speech frame of an episode flushes the Python playback queue and Node partial buffer. Output is discarded during speech and for 300ms after the last speech frame. Episodes debounce with 200ms quiet so ongoing speech does not repeatedly flush. Playback resumes automatically without ending the call. If output had been seen, a documented session.instructions.append asks Live to stop the previous answer and listen; its ACK is NOT a playback fence.

In-flight audio already handed to Discord can briefly remain. Late provider chunks after the hold can still be old speech, an explicitly accepted limitation. GPT-Live primary output_audio.delta has no generation/turn identity or timing; no audio-done or guaranteed interrupt-drained ACK is documented. No invented cancel events or ACK-based freshness claims.

Auth, DAVE, packet identity/freshness, backpressure and confirmed teardown checks remain enforced. New input invalidates pending backend work, drops late results, and does not hang up merely because it interrupted speech. Backend cancellation timeout remains a safety limit.

https://developers.openai.com/api/reference/resources/live/primary-websocket
https://developers.openai.com/api/docs/guides/voice-websockets
https://developers.openai.com/api/docs/guides/live-delegation
