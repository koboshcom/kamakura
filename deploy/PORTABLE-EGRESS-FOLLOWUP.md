# Portable egress followup result

This is source-only followup on baseline 0bff4a747f8ddaf0492696ad5f2a0f74b8166388. No push, production deployment, production probes, database wipe or credential changes were performed. The previous beta host firewall, daemon and boot hook were not changed. Temporary test containers/network were removed after use.

## Implementation

SANDBOX_NETWORK and SANDBOX_USERNS_ROOT are removed from active source/config/Compose/example. Owners have writable ephemeral root and unrestricted sudo commands, but their capability bounding set excludes network/host administration. A separate readonly, mount-free trusted NET_ADMIN provider owns the shared network namespace; owner filesystem/PID authority cannot reach its rules or policy reference. It is initialized and checked before every owner admission. Docker DNS is enabled. IPv4/IPv6 direct host/private/core/sibling connections are denied and authenticated core TCP6080 desktop traffic remains available.

This path requires core and its owners on the same Docker daemon. Plain Docker Desktop needs no second daemon. Old remapped deployment scripts remain historical operator tools and are not exercised or automatically adopted by this change. Existing labeled legacy bridges fail closed rather than become an unfiltered fallback.

Root-layer hard storage quota is optional classic overlay2/XFS only. Blank SANDBOX_ROOTFS_SIZE on Desktop means writable root has no per-owner hard disk quota; the workspace quota is separate. Strict workspace loopback-mount enforcement remains unchanged. Desktop installations needing ordinary binds must explicitly opt into existing soft workspace checks. Host/LAN public and public reverse-proxy addresses require numeric SANDBOX_DENIED_IPS, since Docker cannot discover them reliably. Public application relays are outside direct-IP policy.

## Automated checks

Typecheck and build passed before both commits.

Focused TypeScript tests now pass 28/28, including four added startup/restore/exit admission tests. They cover owner capability/mount options, guard authority separation, legacy-network rejection, lifecycle initialization/recheck/replacement, reference-check failure owner removal, install-failure cleanup, quota behavior and authenticated desktop target lookup. Python policy tests passed 4/4.

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

## Additional startup/restore and privilege proof

The latest run is captured as structured deploy/portable-egress-live-evidence.json; the reproducible probe remains deploy/live-portable-egress.mjs. Only disposable synthetic owners and listeners were used. No push or deployment occurred.

A restored owner whose guard object is missing is now invalidated BEFORE replacement provider creation. A unit test checks exact ordering. Delayed installation keeps readiness unresolved; exit during check rejects admission and removes the owner; an independent restart changes provider identity.

The Linux live probe pauses an actual running guard before nft installation. While it has no policy table, the owner container does not exist and its requested command has not completed. An injected installation failure removes the provider and never starts the owner. Later genuine initialization admits the owner and confirms the earlier marker command never executed.

Provider SIGKILL was tested with the OLD owner still running before manager recovery. Connections to all ten previously listening host/core/mock-Mongo controls failed errno101 because the provider endpoint was gone, not an unfiltered fallback. Manager recovery recreated provider and owner; policy rejects again returned errno113/13. Independently restarting a provider without installing policy rejected restored owner admission and removed the owner. Fresh initialization restored guarded service. Trusted table-deletion injection also rejects admission and removes the owner.

Live full-sudo tests report EUID0 and CapBnd00000000000005db. capset NET_ADMIN and NET_RAW both returned EPERM; raw IPv4 and IPv6 sockets returned EPERM; setns to the shared network namespace returned EPERM. Root nft flush and route changes remained EPERM. The guard reports CapBnd0000000000001000, exactly NET_ADMIN, NoNewPrivs1 and Seccomp2, with readonly root, no bind/volume mounts, no privileged mode and no host PID/IPC/network modes. Its authority is its disposable network namespace, not host firewall administration.

NEW owner-to-core TCP6080 is now tested in both address families, alongside TCP49125. Both are rejected while authenticated core-to-owner desktop HTTP remains200. The exception is not a blanket port allowance. Latest nft deny counters increased from [0,0] to [5,4]; structured evidence records 42 rejected IPv4/IPv6 connection attempts before and after lifecycle changes.

Storage protections are unchanged in this hardening commit. Configured classic overlay2/XFS root quota still fails closed on unsupported backends; strict workspace mount checks remain unless the operator explicitly accepts existing soft-quota mode. Desktop root-layer hard-quota limitations remain explicit. Actual Desktop, public IPv6 WAN and whole-host/daemon reboot are still not proved.


Owner desktops and authenticated shell commands now start as already-bounded container UID0, with no-new-privileges retained. Real graphical terminals inherit root, so arbitrary sudo commands do not depend on setuid escalation. No owner capability was added. deploy/test-root-desktop.mjs passed on Linux Engine using an XFCE-autostarted xterm, not Docker exec(User=0): terminal id reported UID0; sudo created, chmod/chowned, read and removed a benign /etc fixture; CapBnd was 00000000000005db and NoNewPrivs was 1. Its container was offline and removed, and no network/lifecycle proof was rerun. This is NOT an actual Docker Desktop host test. The guard's trusted PID1 installs its ephemeral policy before sleeping; the manager independently waits for installation and checks readiness. A file lock prevents concurrent PID1/manager installs. Current live evidence confirms UID0 NoNewPrivs1, capset/raw-socket/setns EPERM, DNS/public IPv4 HTTPS/apt success, core desktop200 and private-resolved host.docker.internal denial using a Linux hosts-entry fixture, not native Desktop DNS. Resolver127.0.0.11 non-DNS ports are rejected. Desktop remains unverified.

## Three-gap closure, source only

The legacy beta source launcher installs bridge-scoped INPUT/FORWARD DROP barriers for IPv4 and IPv6 before starting either daemon or core. The standalone remapped daemon launcher also gates its early already-running path. Failed policy installation retains barriers; retry cleans inherited temporary guards and duplicate jumps. Policy chains remain below the startup barrier until both families, NAT and the marker succeed. No global flush, DNS change, daemon reconfiguration, actual init.sh edit, deployment or restart occurred. deploy/test-network.py passes 5 tests including an isolated command-state firewall reset/retry fixture and source startup ordering. The fixture is not a real reboot or host firewall activation; operators must adopt the reviewed hook separately.

The unchanged baseline timezone test was reproduced failing. Node24.21.0 / ICU78.3 / tz2026c correctly reports December2026 Vancouver as UTC-7. Official BC March2 announcement confirms permanent UTC-7 after March8,2026 at https://news.gov.bc.ca/releases/2026AG0013-000209. Only the fixture changed, adding December2025 UTC-8 and the final March2026 DST transition. No date implementation refactor.

Final three-gap verification passed npm run check and npm run build; focused TypeScript tests 18/18, Python legacy-policy fixtures 5/5 and Python guard policy tests 4/4. The complete suite used a new disposable mongo:7 container on a randomly assigned loopback port with bootstrap per-process databases and isolated DATA_DIR. It finished 238 tests, 237 passed, zero failed, one skipped. The test Mongo container was removed by an EXIT trap. Production Mongo was neither used nor changed. The earlier 234-test timezone failure above describes the previous run, not this final result.
