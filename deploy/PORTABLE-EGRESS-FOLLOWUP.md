# Portable egress followup result

This is source-only followup on baseline 0bff4a747f8ddaf0492696ad5f2a0f74b8166388. No push, production deployment, production probes, database wipe or credential changes were performed. The previous beta host firewall, daemon and boot hook were not changed. Temporary test containers/network were removed after use.

## Implementation

SANDBOX_NETWORK and SANDBOX_USERNS_ROOT are removed from active source/config/Compose/example. Owners have writable ephemeral root and unrestricted sudo commands, but their capability bounding set excludes network/host administration. A separate readonly, mount-free trusted NET_ADMIN provider owns the shared network namespace; owner filesystem/PID authority cannot reach its rules or policy reference. It is initialized and checked before every owner admission. Docker DNS is enabled. IPv4/IPv6 direct host/private/core/sibling connections are denied and authenticated core TCP6080 desktop traffic remains available.

This path requires core and its owners on the same Docker daemon. Plain Docker Desktop needs no second daemon. Old remapped deployment scripts remain historical operator tools and are not exercised or automatically adopted by this change. Existing labeled legacy bridges fail closed rather than become an unfiltered fallback.

Root-layer hard storage quota is optional classic overlay2/XFS only. Blank SANDBOX_ROOTFS_SIZE on Desktop means writable root has no per-owner hard disk quota; the workspace quota is separate. Strict workspace loopback-mount enforcement remains unchanged. Desktop installations needing ordinary binds must explicitly opt into existing soft workspace checks. Host/LAN public and public reverse-proxy addresses require numeric SANDBOX_DENIED_IPS, since Docker cannot discover them reliably. Public application relays are outside direct-IP policy.

## Automated checks

Typecheck and build passed before both commits.

Focused TypeScript tests passed 24/24. They cover owner capability/mount options, guard authority separation, legacy-network rejection, lifecycle initialization/recheck/replacement, reference-check failure owner removal, install-failure cleanup, quota behavior and authenticated desktop target lookup. Python policy tests passed 4/4.

A complete isolated suite used a NEW disposable Mongo7 container bound to host loopback port46379, with bootstrap-generated test database names and isolated DATA_DIR. Result was 234 tests, 232 passed, 1 failed, 1 skipped. The sole failure is the existing time-context expectation that America/Vancouver December2026 is GMT-08:00; this runtime returned GMT-07:00. No time-context code was changed. The suite is not reported green. Test Mongo was removed, not a production database.

## Linux disposable live evidence

The repository probe deploy/live-portable-egress.mjs was run in a temporary trusted core container using CURRENT built dist read-only, ordinary primary Linux Docker, separate instance egressprobe, synthetic owners42/43, a temporary bridge172.26.219.0/24 with IPv6fd42:219:10::/64, temporary workspace binds and explicit soft-quota opt-in. This does not test the real owners or production services.

Owner UID0 via sudo, reversible /etc write/removal, apt update/install of nftables+iproute2, embedded DNS and public HTTPS all passed. Owner root nft flush ruleset and ip route add both failed EPERM. Authenticated core-to-owner desktop returned HTTP200.

Listening host controls on 172.26.219.1 and fd42:219:10::1 TCP49124, trusted core controls on .2/::2 TCP49125, and mock private service controls on .4/::4 TCP27017 and49126 all returned HTTP200 from trusted core before owner denial tests. The TCP27017 listener is deliberately an HTTP mock, NOT a production Mongo instance. Actual owner root connect_ex attempts to these targets were rejected with errno113 IPv4 and errno13 IPv6. nft deny counters increased from [0,0] to [4,2], confirming the rejects were policy matches, not merely closed ports.

Sibling synthetic owner43 ran a listening TCP49127 server, confirmed by a trusted provider loopback connection. Owner42 was rejected from the sibling over BOTH IPv4 and IPv6.

Stopping/restarting owner42 through the manager retained guarded denial. Stopping its provider caused the manager to remove/recreate its owner and provider before re-admission; denial remained. Trusted fault injection deleting the guard table made the next admission fail and removed owner42 without executing requested code. No privileged production firewall changes were used.

The first disposable attempt caught a Docker local-log-driver incompatibility, default compression with max-file1. The provider now explicitly sets compress=false, matching the owner logger. Both subsequent full disposable probe runs passed.

## Remaining live-proof limits

Docker Desktop is not available in this environment. Do not claim Windows/Mac live enforcement is proved. It still needs the same listening host/core/sibling controls and lifecycle checks on an actual Desktop machine, especially public host/reverse-proxy deny addresses.

A public IPv6 HTTPS connection to 2606:4700:4700::1111 TCP443 failed with curl exit7 on this Linux host. Private IPv6 controls and firewall rejects passed, but public IPv6 WAN success is NOT proved. No whole-host or whole-Docker-daemon reboot was performed, since that would affect production. Restart/recreation evidence is limited to disposable owner/provider containers. Owner/provider restart-policy=no and pre-admission policy checks are tested at code level.

No automatic beta deployment or old init-hook rewrite occurred. Parent owns any reviewed push and later separately authorized deployment.
