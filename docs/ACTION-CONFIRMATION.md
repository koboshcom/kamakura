# Action confirmation

Normal cloud and paired-device shell/CUA actions are prompt-free. Destructive, dangerous or irreversible actions need a fresh confirmation in the same authenticated owner's DM. The model sets requires_confirmation for dangerous intent, including external messages, money, email, posts and security changes. Normal assistant chat replies are unaffected.

Cloud proposals use /confirm NONCE or /cancel NONCE. Local devices use /approve ID and /deny ID in Telegram, Discord and WhatsApp. Nonces are single-use and expire after 60 seconds. Forwarded, quoted, referenced, group, bot and fabricated identity messages cannot confirm. Arguments cannot change after approval. Cancellation, session loss or restart invalidates pending work; failed actions need a new proposal.

The cloud guard recognizes recursive/bulk deletion and critical/system/credential/core-data targets, filesystem wipes, device writes, PID 1, critical daemon/core kills, kill -1 and broad killall and obvious mass Mongo deletion. It also checks a short set of system/security commands. Local requests have a short client guard for outdated cores. These are best-effort patterns, not a shell parser, DOM classifier or security boundary. Custom scripts and coordinate clicks cannot be classified universally. Arbitrary uploaded code remains untrusted.

Only actual shell, Python, file and CUA wrappers are covered. There are no standalone banking, email or publishing tools in this build. External actions through scripts or browsers must be marked by the model. Read-only local snapshots still require a paired, connected, resumed device.

Shell and CUA requests declare normal/destructive risk and a purpose. Exact coordinates, input, purpose and risk are immutable in the pending action. Recognizable danger overrides a normal declaration in both TypeScript and Go; ambiguous CUA intent requires confirmation. Benign navigation, clicks, text input and scratch edits can be normal. Internal temporary cleanup is not a user action. Classification uses shared fixtures, not hidden-button detection.

Protocol v2 envelopes are HMAC-authenticated by a fresh key sent on the authenticated TLS connection. This verifies scope against that trusted core, not against a compromised core. Old CLI v1 receives an explicit update-required error and no actions. New CLI refuses unsigned old-core requests. Update both sides and reconnect; every reconnect starts paused.


Ordinary single scratch/work-file deletion and ordinary raw-PID kills or benign named pkill are prompt-free. Only PID 1, sshd, dockerd, systemd, init, actual kamakura/kamakura-core/kamakura-agent names, kill -1 and broad killall require confirmation. Signal flags are not target PIDs. This is a short best-effort argument guard, not process discovery or ownership tracking. Existing pause, STOP, revoke and internal command cancellation are unchanged; no process/task registry or new handle requirement is added. Recursive/bulk/important deletes, wipes, installs, security changes and external irreversible actions still require the same-DM approval.
