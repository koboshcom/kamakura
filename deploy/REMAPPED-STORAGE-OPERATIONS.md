Dedicated root storage operator runbook

This is an approval-only maintenance procedure, not a deployment hook. None of the scripts stop daemons, prune cache, delete old storage, modify the installed daemon configuration, or modify workspace filesystems. Default reservation is 16GiB, requiring another 2GiB host headroom and source-size headroom. Change --size-gib only after checking real available space and Docker image/layer demand. Existing work filesystems under /var/lib/kamakura-work are never migration targets. Primary Docker storage is never a migration target.

Before approval, inspect disk usage, mounts, current config, daemon PID and running boxes. Install missing rsync and xfsprogs separately if necessary. Do not run the commands below without approval for brief beta/core and dedicated-daemon downtime. Cache pruning requires separate approval and must target only unused build cache, never volumes or the primary Docker data directory. The migration refuses insufficient free space; it does not prune automatically.

After approval, from /home/kit/kamakura, stop core so it cannot restart boxes. Stop every dedicated-daemon container explicitly, then terminate and wait for the exact dedicated dockerd PID obtained from /run/kamakura-root-docker.pid. Never kill the primary daemon. Verify /proc and socket/pidfile removal. If stale socket/pidfile remain, inspect process ownership before removing only those dedicated files. Inspect findmnt for the source directory and its children. Existing userns-remap bind mounts may remain after shutdown. Explicitly detach only verified mounts under /var/lib/kamakura-root-docker, deepest first; never recursively unmount /var/lib or workspace mounts. Provisioning refuses any remaining child mount.

Provision after those checks and permission

    sudo /opt/hako/bin/python3 deploy/remapped-storage.py provision --apply --confirm-data-root /var/lib/kamakura-root-docker --size-gib 16

The source is renamed to /var/lib/kamakura-root-docker.pre-xfs, not deleted. A newly created, fully fallocated single-link image /var/lib/kamakura-loopback/remapped-root.xfs is formatted with XFS ftype=1 and mounted at the original path with project quotas. rsync -aHAXS --numeric-ids copies permissions, extended attributes, hard links, ACLs and ownership. A checksum dry-run must show no differences. Both stores remain if copying fails; daemon stays stopped. Partial provisioning is not automatically retried or cleaned up. Inspect each artifact and resume/recover manually. The manifest is written only after copy verification.

Review /etc/kamakura/remapped-daemon.json.xfs-proposed and compare it against the installed configuration. It preserves the existing remap name and changes only storage-driver=overlay2 and features.containerd-snapshotter=false. Validate it before explicitly installing

    sudo dockerd --validate --config-file /etc/kamakura/remapped-daemon.json.xfs-proposed
    sudo cp -a /etc/kamakura/remapped-daemon.json /etc/kamakura/remapped-daemon.json.pre-xfs
    sudo install -o root -g root -m 600 /etc/kamakura/remapped-daemon.json.xfs-proposed /etc/kamakura/remapped-daemon.json
    sudo /opt/hako/bin/python3 deploy/remapped-storage.py validate

Validate refuses missing mount, wrong filesystem, absent project quotas, different loop backing, offset/size-limit/read-only loop devices, sparse/truncated/untrusted backing, unexpected data-root or userns/socket, containerd snapshotter, and XFS without ftype=1. It never creates or mounts a fallback directory. The exact loop block-device byte capacity must match the root-owned manifest, while the backing's allocated blocks must cover its entire fixed logical length.

Boot ordering is mandatory. Before the existing resume-local-test.sh boot call, an operator must add this exact approved storage-mount step to the root boot hook or equivalent ordered mount unit

    /opt/hako/bin/python3 /home/kit/kamakura/deploy/remapped-storage.py mount-existing --apply

That step only mounts an existing manifest/backing at an existing empty directory, with the dedicated daemon stopped. If already mounted it only validates. It refuses missing manifest/backing instead of provisioning automatically. Then invoke resume-local-test.sh. Both resume and dedicated-daemon startup independently validate mounted storage before any daemon/core startup. The source resume exports the remapped workspace, instance, writable rootfs size, dedicated socket and matching network name/bridge before starting core and installing the network policy. A failed step must halt the boot chain, not continue to resume. No actual boot hook is modified by this source patch.

After starting the dedicated daemon, inspect docker info through its socket and confirm classic overlay2, backing XFS, project quotas and SecurityOptions userns. Confirm DockerRootDir remains /var/lib/kamakura-root-docker/200000.200000. Confirm existing images and stopped containers survived. Before enabling normal sandbox traffic, use a disposable tiny quota-limited rootfs to demonstrate ENOSPC beyond the configured size; test sudo/apt within the intended normal limit and disappearance of installs after deleting that disposable box. Do not fill the aggregate filesystem to test enforcement. Run the dedicated network hook after core recreation and validate public HTTPS/DNS, private/host/metadata/CGNAT denial, cross-owner isolation and authorized desktop HTTP/RFB. Source-only tests are not evidence that these live checks passed.

Rollback remains an operator-only maintenance operation. Stop core, dedicated containers and dedicated daemon again; inspect and detach only the new data-root's child mounts, then its XFS loop mount. Preserve the new image and manifest under distinct recovery names, restore the empty mountpoint by renaming the old pre-xfs directory back, and restore the saved daemon config. New fail-closed startup intentionally refuses the old unbounded ext4 store. Restoring service on that old store requires deliberately restoring the previous source startup policy too; never bypass the guard silently. Never delete old rollback storage until separate approval after a tested successful migration.
