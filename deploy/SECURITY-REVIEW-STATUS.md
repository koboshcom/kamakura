Security review follow-up, 7 October 2026. Local changes only; no push. This records implementation and validation limits rather than a security certification.

P1 fixed. Writable userns-remapped roots use classic overlay2 on XFS project quotas with an 8 GiB layer limit. The dedicated daemon store is a fully allocated fixed-capacity 16 GiB XFS image; storage startup validates its manifest, allocation, mount, filesystem and quota configuration. The old store is retained for rollback. Both live owners report 8 GiB root filesystems and their original separate 35 GiB work mounts. Their upper directory project IDs correlate with 8 GiB hard quotas. A disposable same-image 256 MiB networkless layer returned actual ENOSPC when allocating 257 MiB. This does not promise that both roots can simultaneously fill to 8 GiB; image data and filesystem metadata share the aggregate bound. Work image physical reservation is unchanged.

P2 fixed. Sandbox creation requires the dedicated network and a boot/network/core-specific root-owned policy marker. Root hooks install host INPUT, inter-owner/private/metadata destination and IPv6 filtering, permitting public egress and narrowly scoped core desktop ingress. Both owners reached public HTTPS; forbidden probes coincided with increasing firewall DROP counters. Firewall attestation is not continuous rule-integrity monitoring. The core retains its intentional high-trust Docker socket boundary.

P3 fixed. Fact writes require an exact excerpt from the current direct owner message, record provenance, reject instruction-changing content and place remembered data in untrusted user-role context. Legacy facts without that evidence are not promoted into confirmed facts. Regression tests cover forged, quoted, media and alternate-owner evidence.

P4 fixed. Quoted JSON keys, complete whitespace-containing quoted credentials and escaped values are recognized and redacted across persistence/output boundaries. End-to-end regression fixtures use synthetic credentials. Arbitrarily transformed or unrecognizable secrets cannot be guaranteed detectable.

P5 fixed by disabling HEIC/HEIF and AVIF decoding before the unsafe conversion path. JPEG, PNG and WebP remain supported under existing pixel/byte controls. Native HEIC support is deliberately unavailable rather than presented as safely sandboxed.

P6 fixed. Reminder buckets retain bounded terminal history, and pending admission is atomic. Uncertain sends are not replayed. Long-retention/concurrent-admission regressions pass.

P7 fixed. Outage snapshots implement exact, earliest/latest and time/role filtering consistently. Missing anchors fail closed, and degraded bounded coverage remains explicit.

P8 partially addressed. The network hook is parameterized and validates operator configuration. The work migration/reattach/resume helpers remain deliberately installation-specific beta hooks, documented as such; they are not general multi-host provisioners. Generalizing the owner map and work-mount migration was skipped to avoid changing unrelated live storage semantics.

P9 fixed. Reminder delivery rechecks current transport destination authorization and does not substitute sandbox authorization for chat policy. Already begun sends cannot be recalled.

P10 fixed. Exact-action approvals reject actions when redaction would hide executable bytes; approved previews match the original action. Secret-literal commands are refused rather than showing an incomplete preview. Regression tests cover concealment and exact one-use approval binding.

P11 fixed. Summary coverage, full-envelope bytes and load-time cache cardinality are bounded. Oversized legacy summaries are sanitized. Evicted coverage can permit repeated summarization rather than claiming permanent exact coverage.

P12 fixed. CLI releases use Go 1.26.8. All six release-platform vulnerability scans passed, and reproducible archive checks passed. Linux race/vet tests and cross-compiles passed. The final CLI archive SHA256 is 20ee876fed46c978366b93b542518eff518fd57323d1320cc34cbe43bcf91cd9.

P13 fixed. Device attachment and durable revocation serialize and revalidate stale authentication results. A deterministic delayed-token regression rejects the connection after revocation. The coordination scope is one core process, not a distributed lock.

P14 fixed in source. Windows token/config directories and files use protected current-user-only DACLs and validate existing files. Windows cross-compilation passed; native Windows ACL and GUI runtime validation remains unavailable in this Linux environment.

An additional CLI blocked-stdin/early-cancellation defect was fixed with driver termination/reaping and deadline-aware writes. Repeated race tests passed. Deliberately detached shell children remain a documented cancellation limitation.

Live sudo/apt installation, workspace preservation and root/package reset passed for both owners. The host lacks swap accounting; the configured equal swap ceiling is not enforced by this kernel. The integration suite passes 184 tests. The dedicated-network desktop lookup regression was fixed and tested; live Cua doctor, harmless input and PNG screenshot tests passed for both owners. Live owner noVNC backend authentication, headed Chromium, cross-owner credential denial, gateway HTTP/WebSocket RFB and revocation checks passed. Actual configured Speaches transcription passed. The actual-profile followthrough model check is incomplete: its external Forgejo avatar fixture was unavailable before any model invocation. Host default/IPv4 and core fetches timed out without a usable profile; this is not evidence of a model regression or a successful model check. Model checks must finish before final rollout completion is reported. External HTTPS proxy/browser and native local-device UI approval checks remain operator/platform validation work.
