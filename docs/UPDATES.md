# Updates

Standard Linux Docker Compose installs can run `./update.sh` from any directory.
A published seven-character tag or full commit can be selected with
`./update.sh abcdef0`. CI publishes only `ghcr.io/koboshcom/kamakura:latest`
and seven-character commit tags, for Linux amd64/arm64. Full commits resolve to
that short tag and must match the image's full revision label.

The updater pulls only that trusted core image, then starts it by immutable image
ID. It retains the exact previous container, image, environment, mounts, runtime
configuration and networks. Only core is stopped/replaced. Sandbox/egress images
are not published by this workflow and remain unchanged; existing owner boxes and
Mongo are never recreated, restarted, downgraded, pruned or migrated.

First install/rebuild this updater-aware version manually. Both current and target
images must declare storage contract 1, and target must declare readiness 1.
Incompatible/missing contracts, custom Compose overrides, static/host networking
and beta overlays are refused. A contract is a maintainer compatibility promise,
not an automatic proof that future code cannot migrate data.

Readiness is the existing successful application startup sequence, exposed through
a private /tmp marker and Docker healthcheck. It makes no provider request and is
not an end-to-end messaging or database durability proof. A 120-second deadline
fails the update and automatically restores the exact retained core. Failure exits
nonzero even after healthy rollback. `./update.sh --rollback` manually restores
the most recent retained core if configuration files have not changed.

A private `.update-state/` journal provides exclusive locking and crash recovery.
It contains secret-bearing container snapshots, mode 600 under a mode 700
directory; never commit or share it. Retained cores and older snapshots accumulate
deliberately. Review and remove only obsolete retained objects manually once their
rollback is no longer needed. No automatic pruning. At least 2 GiB of free space
is required both beside the checkout and under /var/lib/docker, before and after
pull. This is a safety margin, not a guarantee about unpacking or future growth.

Pull/precheck failures leave the running core untouched. Failed immutable image
IDs are suppressed until a new image appears or `--force` is explicitly given.
The updater ignores inherited Docker/Compose remote selection, invokes argument
arrays without a shell, never prints Docker stderr or container environments,
and keeps the .env file and its permissions unchanged.

## Optional automation

OFF by default. No service or schedule is installed automatically. After manual
verification, create `.update-state/auto-enabled` privately, then add an explicit
operator-owned cron entry using the same updater, for example

```cron
17 */6 * * * cd /absolute/path/kamakura && ./update.sh --auto
```

Auto mode adds up to 30 seconds of jitter and uses the same lock, failed-image
suppression and rollback. Remove the enable file and cron entry to disable.
The account needs Docker access, which confers host-level power. No watchtower.

## CLI

`kamakura-cli update` selects the newest published GitHub prerelease.
`kamakura-cli update abcdef0` chooses an explicit release, including a deliberate
downgrade. `kamakura-cli version` prints the embedded full build revision.
Legacy/manual builds without version metadata must select a tag explicitly.
Stop the connector first; pairing/config/auth files are not changed.

Assets are the existing five CI ZIPs for Linux amd64/arm64, macOS arm64 and Windows
amd64/arm64. macOS amd64 has no published asset. The same release's SHA256SUMS is
required; missing/mismatched checksums fail closed. Checksums establish integrity,
not publisher signatures or protection against a compromised repository.

Downloads use public GitHub HTTPS, bounded responses and timeouts. Archives must
contain exactly one expected regular binary, with bounded compressed/extracted
sizes and matching executable OS/architecture. Paths, symlinks, duplicate entries
and unexpected files are refused. No downloaded program runs during updating.

Unix uses same-directory staging, fsync and atomic rename, preserving ownership
and permissions; the previous binary remains at `<binary>.previous`. Archive that
backup before another update. Restore it manually while the connector is stopped.
Windows copies the existing DACL, renames the running binary to
`<binary>.running-old`, then installs the staged file; replacement failure restores
the old path. Exit and relaunch manually. Windows locking/permissions and macOS
quarantine behavior require native testing; cross-builds are not native proof.

CI currently supplies SHA256SUMS. GHCR's public token endpoint returned 401 during
the implementation audit, so public pull availability/digests were not verified.
Authenticate privately if needed; never put registry credentials in update args.
A workflow declaration is not evidence that a particular commit image exists.
