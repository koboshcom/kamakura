import { lstat, realpath, readFile, statfs } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const decodeMount = (value: string): string => value.replace(/\\([0-7]{3})/g, (_, code: string) => String.fromCharCode(parseInt(code, 8)));
export function workspaceMount(mountinfo: string, path: string): { type: string; source: string; root: string } | undefined {
  // Match the exact mountpoint, not its parent. Read from our Linux namespace.
  for (const line of mountinfo.trim().split('\n').reverse()) {
    const [left, right] = line.split(' - ');
    if (!right) continue;
    const fields = left!.split(' ');
    const tail = right.split(' ');
    if (decodeMount(fields[4] ?? '') === path) return { root: decodeMount(fields[3] ?? ''), type: tail[0]!, source: decodeMount(tail[1] ?? '') };
  }
  return undefined;
}
export function hardQuotaMount(mountinfo: string, path: string, capacity: bigint, disk: number): boolean {
  const mount = workspaceMount(mountinfo, path);
  return Boolean(mount && mount.root === '/' && mount.type === 'ext4' && /^\/dev\/loop\d+$/.test(mount.source) && capacity > 0n && capacity <= BigInt(disk));
}
export async function checkWorkspace(root: string, userId: string, disk: number, allowSoftQuota: boolean): Promise<{ path: string; hard: boolean }> {
  if (!/^[1-9]\d{0,19}$/.test(userId)) throw new Error('Invalid workspace owner');
  const path = join(resolve(root), userId);
  const info = await lstat(path).catch(() => { throw new Error('Workspace missing. Run deploy/provision-sandbox-volumes.py on the Docker host. No unbounded fallback was created.'); });
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error('Workspace must be a real directory, without symlink components');
  const mountinfo = await readFile('/proc/self/mountinfo', 'utf8');
  const fs = await statfs(path, { bigint: true });
  const hard = hardQuotaMount(mountinfo, path, fs.blocks * fs.bsize, disk);
  if (!hard && !allowSoftQuota) throw new Error('Workspace is not a bounded ext4 loopback mountpoint. Provision the host mount before starting core; no unbounded fallback is allowed.');
  return { path, hard };
}
