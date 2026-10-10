# Portable owner root and egress boundary

Owner containers always have writable ephemeral root and unrestricted sudo commands. Their capability bounding set excludes NET_ADMIN, NET_RAW, SYS_ADMIN, SYS_PTRACE and host authority. Default Docker seccomp is retained. Only the prechecked owner workspace is mounted. Root is not host root, but ordinary shared-kernel containers are not a VM-grade adversarial-code boundary.

The trusted core and owners must use the same Docker daemon. Docker Desktop/WSL needs no second daemon. Build sandbox-image and egress-image with the Compose build profile. No core deploy, workspace migration or database mutation is performed by this change. Legacy remapped deployment scripts are historical operator tools, not the portable launcher; do not invoke them to deploy this version.

## Network authority

Each owner joins a trusted egress provider's network namespace using Docker container network mode. The provider has NET_ADMIN in its own PID/filesystem namespaces, no owner-controlled mounts, no sockets/API listeners, read-only root and no other capabilities. Owner sudo cannot edit its Python policy, saved reference, processes or nft rules. Docker DNS remains enabled. All owner traffic, including direct sockets ignoring proxies and root subprocesses, traverses the guard's nft inet OUTPUT rules before Docker DNS DNAT.

Private/special IPv4 includes RFC1918, loopback outside this owner's namespace, CGNAT/Tailscale, link-local, documentation, benchmarks, multicast/reserved and unspecified space. IPv6 permits only global unicast 2000::/3, excluding special/documentation/transition ranges, with narrow kernel NDP exceptions for connectivity. ULA/link-local service connections, mapped IPv4, NAT64, Teredo and 6to4 cannot bypass the destination policy. Actual private/host services must be tested with listening positive controls; refusal without a control is not isolation evidence.

Every inspected core interface address is denied for new owner connections, even a public IPv6 address. The guard admits core-initiated TCP6080 and only its conntrack reply direction in return. Same-bridge peers remain blocked by INPUT and OUTPUT despite sharing a bridge. IPv4 private and forbidden IPv6 connections are rejected with admin-prohibited where routable, rather than relying on closed ports or timeout.

Set SANDBOX_DENIED_IPS to comma-separated numeric public host/LAN IPs, if any. A container cannot reliably discover the Windows/Mac host's public IP or public-address LAN; failing to provide those leaves that public route allowed. Also include any public core/Mongo reverse-proxy addresses. Public WAN remains unrestricted, including public HTTP/SOCKS/tunnel services; a deliberate application-level remote relay is outside this direct-IP boundary.

## Fail-closed lifecycle

Guard initialization completes before owner creation. Each admission rereads and compares the complete canonical table against its trusted saved reference. Deleted/modified rules fail admission and remove the existing owner. Restart-policy is no for both owner and provider, so Docker does not start untrusted owner code ahead of the manager after reboot. Missing, stopped or image/config-changed guards remove their owner before replacement and policy reinstallation. Guard ID, start timestamp and network namespace/policy identity enter the owner fingerprint; a new guard means a recreated owner. Stopping a provider removes its route, while the old namespace's nft rules remain with any existing owner, not an unfiltered bridge fallback. This change adds no host firewall rules, global flush or daemon reconfiguration.

Do not manually start containers or apply external privileged network changes behind the manager. Such operator actions are outside its authority model. The old beta host firewall hook and boot launcher are not modified or exercised by this followup; deployment must not mix their network attestations with guard-v2.

## Storage and portability limits

SANDBOX_NETWORK and SANDBOX_USERNS_ROOT are removed. SANDBOX_ROOTFS_MODE no longer selects a readonly mode. SANDBOX_ROOTFS_SIZE is optional; nonblank requires classic overlay2 on XFS with project quota support, otherwise admission fails. Desktop leaves it blank and has no per-owner root-layer hard quota. The daemon's global disk bound is not a per-owner quota.

Workspace checks retain the preprovisioned fixed ext4 loopback mount contract. Desktop normally cannot provision that contract from a plain WSL bind; SANDBOX_ALLOW_SOFT_QUOTA=true is an existing explicit opt-in to a soft pre-command check, not a new hard quota. No automatic weakening is performed.

Linux disposable probes demonstrate only the tested Engine/kernel. Docker Desktop live proof requires an actual Desktop host, listening host/core/Mongo and sibling controls, public IPv4/IPv6 controls, root tamper attempts and restart/recreation testing. Do not claim Desktop has been live-verified from a Linux beta run. See the followup report for exact tested targets and blockers.
