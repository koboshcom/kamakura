# Expanded persona experiment

Status: running, not a deployment recommendation. Live beta remains the original persona on 42df896.

The 42df896 security snapshot was pushed as GitHub main 2b3c565, with tracked-path exclusions checked. No subsequent candidate has been pushed or deployed.

## Conditions

The original baseline uses the actual deployed pipeline and explicitly injects the original committed persona with review disabled. A candidate uses generic grounding/curiosity/length instructions and an optional tool-free draft editor. A separate example condition adds independently generated fictional, varied exchanges to the isolated candidate prompt, not user memories or canned response lookup tables. Generated sketches are experimental inputs, not committed production persona material.

The fixture author did not see candidate prompts, prior transcripts, or earlier test fixtures. The new set has 18 four-turn conversations. All completed conversations are retained, including unexpectedly silent turns. The first baseline attempt stopped after nine complete cases due to a harness assertion on silence; only its nine missing cases were resumed. The first candidate attempt stopped before any complete case; its replacement runs all 18. These are harness recovery operations, not selection of favorable outputs.

Initial baseline and candidate captures predate reaction/elapsed-time recording. Their empty-text turns cannot distinguish a reaction from silence, and no latency numbers may be inferred from them. The example condition and future captures record reactions and full-turn elapsed milliseconds. Wall time includes generation, tools, and delivery, not only editor time.

## Safety boundary

The editor defaults off and makes one tool-free model call per eligible bubble, with a default 12-second timeout (configurable 1–30 seconds), no retries and a 512-token output limit. Errors or incomplete termination keep the original draft; parent cancellation propagates. Delivery checks freshness before and after editing. Progress, voice, fenced/inline code, artifact/exact-text requests, media-bearing histories and tool-result histories bypass editing. Evidence extraction is bounded and text-only before serialization/redaction. Conservative artifact heuristics are not a complete semantic classifier.

An independent read-only review found three medium issues: accidental artifact editing, acceptance of token-truncated output, and unbounded JSON preprocessing of multimodal evidence. These were fixed in 578ab87 and have deterministic tests. The initial candidate process loaded code before these fixes; it is preliminary evidence and cannot by itself authorize deployment. Final validation must use guarded code.

The editor is probabilistic and not a factuality or prompt-injection guarantee. URL equality is checked; ordinary assertions, numbers and names are not deterministically verified. Superseded editor work can continue until its bounded abort/timeout even when delivery is blocked. Tool-role bypass can disable editing of subsequent bubbles. The cost/latency tradeoff must be disclosed rather than treating extra generation as free.

## Decision protocol

Render all 18 complete pairs with random order and per-pair condition labels. Keep the decoding key separate from an independent reviewer. Read and save the review before decoding. Report conversation-level wins/ties and qualitative grounding, conversational fit, brevity, interest and unwanted performance. This is an AI-judged multi-turn comparison, not human preference evidence or statistical proof. Comparing multiple candidate conditions is exploratory selection; any final candidate still needs guarded pipeline checks and relevant regressions before beta deployment and another authorized snapshot push.

Prior two seven-case reviews each tied 3–3 with one tie, so the original was retained. Those results remain historical, not evidence of success for the new conditions.
