import Docker from 'dockerode';
import { Writable } from 'node:stream';
import { createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { open, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { checkWorkspace } from './workspace.js';
import { config } from './config.js';
import { logger, errorType } from './logger.js';

type Settings = typeof config.sandbox;
const rootCaps = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'SETGID', 'SETUID', 'SETPCAP', 'NET_BIND_SERVICE'];
export function rootPolicy(usernsRoot: boolean) {
  const mode = process.env.SANDBOX_ROOTFS_MODE || (usernsRoot ? 'writable' : 'readonly');
  if (!['writable', 'readonly'].includes(mode) || (mode === 'writable' && !usernsRoot)) throw new Error('Writable root requires userns remapping');
  const size = process.env.SANDBOX_ROOTFS_SIZE || '8G';
  if (!/^[1-9][0-9]*(?:[kKmMgG])?$/.test(size)) throw new Error('Invalid SANDBOX_ROOTFS_SIZE');
  return { writable: mode === 'writable', size };
}
export function assertRootStorage(info: { Driver?: string; DriverStatus?: string[][] }, writable: boolean) {
  if (writable && (info.Driver !== 'overlay2' || !info.DriverStatus?.some(([key, value]) => key === 'Backing Filesystem' && value === 'xfs'))) {
    throw new Error('Writable root requires classic overlay2 on XFS with project quotas; provision bounded daemon storage first');
  }
  // Docker validates pquota on create when StorageOpt.size is requested. Do not use
  // the containerd snapshotter, which can accept that option without enforcement.
}
export function sandboxNetwork(instance: string) {
  const name = process.env.SANDBOX_NETWORK_NAME || `kamakura-${instance}-sandboxes`;
  const bridge = process.env.SANDBOX_NETWORK_BRIDGE || `ks${createHash('sha256').update(name).digest('hex').slice(0, 12)}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(name) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,14}$/.test(bridge)) throw new Error('Invalid dedicated sandbox network configuration');
  return { name, bridge };
}
export function assertSandboxNetwork(info: Docker.NetworkInspectInfo, instance: string): void {
  const { name, bridge } = sandboxNetwork(instance);
  if (info.Name !== name || info.Driver !== 'bridge' || info.EnableIPv6 || info.Internal ||
      info.Options?.['com.docker.network.bridge.name'] !== bridge ||
      info.Options?.['com.docker.network.bridge.enable_icc'] !== 'false' ||
      info.Labels?.['kamakura.network-policy'] !== 'public-only-v1' || info.Labels?.['kamakura.sandbox'] !== instance ||
      info.IPAM?.Config?.length !== 1 || !info.IPAM.Config[0]?.Subnet || !info.IPAM.Config[0]?.Gateway) {
    throw new Error('Dedicated sandbox network policy missing or invalid; run the root-only network hook');
  }
}
async function assertNetworkReady(root: string, network: Docker.NetworkInspectInfo, core: Docker.ContainerInspectInfo) {
  const file = await open(join(root, '.network-policy.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) || stat.size > 4096) throw new Error('Unsafe network policy marker');
    const marker = JSON.parse(await file.readFile('utf8'));
    const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    const coreIps = Object.values(core.NetworkSettings.Networks ?? {}).map(n => n.IPAddress);
    if (marker.version !== 1 || marker.bootId !== bootId || marker.networkId !== network.Id ||
        marker.subnet !== network.IPAM?.Config?.[0]?.Subnet || !coreIps.includes(marker.coreIp)) {
      throw new Error('Sandbox firewall is not attested for this boot, network and core address; rerun network hook');
    }
  } finally { await file.close(); }
}
export function assertUsernsRuntime(info: { SecurityOptions?: string[] }, enabled: boolean): void {
  if (enabled && !info.SecurityOptions?.some(option => option === 'name=userns' || option.startsWith('name=userns,'))) {
    throw new Error('Writable sudo sandbox requires an operator-configured userns-remap daemon; refusing unisolated root');
  }
}
export function sandboxOptions(userId: string, settings: Settings, workspace: string): Docker.ContainerCreateOptions {
  const root = rootPolicy(settings.usernsRoot);
  return {
    Image: settings.image, User: '1000:1000', WorkingDir: '/work',
    Cmd: ['bash', '/opt/kamakura/start-desktop.sh'], Env: ['HOME=/work', 'TMPDIR=/tmp', 'DISPLAY=:99', 'XAUTHORITY=/tmp/kamakura.Xauthority'],
    Labels: { 'kamakura.sandbox': settings.instance, 'kamakura.owner': userId },
    HostConfig: {
      Mounts: [{ Type: 'bind', Source: workspace, Target: '/work', ReadOnly: false, BindOptions: { Propagation: 'rprivate' } }],
      ReadonlyRootfs: !root.writable, Privileged: false, CapDrop: ['ALL'],
      ...(root.writable ? { CapAdd: rootCaps, SecurityOpt: [], StorageOpt: { size: root.size } } : { SecurityOpt: ['no-new-privileges:true'] }),
      Runtime: 'runc', DeviceRequests: [], Devices: [],
      NetworkMode: settings.network ? sandboxNetwork(settings.instance).name : 'none',
      Sysctls: { 'net.ipv6.conf.all.disable_ipv6': '1', 'net.ipv6.conf.default.disable_ipv6': '1' },
      NanoCpus: Math.round(settings.cpus * 1e9), Memory: settings.memory, MemorySwap: settings.memory,
      PidsLimit: settings.pids, Init: true,
      Tmpfs: {
        '/tmp': 'rw,noexec,nosuid,nodev,size=128m,mode=1777',
        '/run': 'rw,noexec,nosuid,nodev,size=16m,mode=755',
        '/var/tmp': 'rw,noexec,nosuid,nodev,size=16m,mode=1777',
      },
      LogConfig: { Type: 'local', Config: { 'max-size': '5m', 'max-file': '1', compress: 'false' } },
      Ulimits: [{ Name: 'nofile', Soft: 1024, Hard: 1024 }],
    },
  };
}

export class SandboxManager {
  private readonly docker: Docker;
  private readonly coreDocker: Docker;
  private queues = new Map<string, Promise<unknown>>();
  private creation: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private lastUsed = new Map<string, number>();
  private readonly prefix: string;
  constructor(private readonly settings: Settings = config.sandbox, docker?: Docker, private readonly workspaceCheck = checkWorkspace) {
    this.docker = docker ?? new Docker({ socketPath: settings.socketPath, timeout: 15000 });
    this.coreDocker = docker ?? new Docker({ socketPath: settings.coreSocketPath, timeout: 15000 });
    this.prefix = `kamakura-${settings.instance}`;
  }
  authorized(userId: string): boolean {
    // Wildcards are deliberately not accepted for arbitrary shell execution.
    return /^\d+$/.test(userId) && this.settings.allowed.has(userId);
  }
  private async serial<T>(userId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(userId) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(operation);
    this.queues.set(userId, task);
    try { return await task; } finally { if (this.queues.get(userId) === task) this.queues.delete(userId); }
  }
  private fingerprint(userId: string): string {
    const { allowed: _allowed, ...settings } = this.settings;
    return createHash('sha256').update('sandbox-runtime-v4-bounded-writable-public-network').update(JSON.stringify(rootPolicy(this.settings.usernsRoot))).update(JSON.stringify(this.settings.network ? sandboxNetwork(this.settings.instance) : null)).update(JSON.stringify(settings)).digest('hex');
  }
  private async container(userId: string): Promise<Docker.Container> {
    // Serialize creation across users to enforce the global container count.
    const create = this.creation.catch(() => undefined).then(async () => {
      const root = rootPolicy(this.settings.usernsRoot);
      const runtime = await this.docker.info();
      assertUsernsRuntime(runtime, root.writable);
      assertRootStorage(runtime, root.writable);
      let hostRoot = this.settings.root;
      if (this.settings.rootView) {
        // Docker resolves Compose's relative host path. Never guess /app on host.
        const core = await this.coreDocker.getContainer(hostname()).inspect();
        const mount = core.Mounts?.find(m => m.Type === 'bind' && m.Destination === this.settings.rootView);
        if (!mount?.Source?.startsWith('/')) throw new Error('Core sandbox root bind mount is missing');
        hostRoot = mount.Source;
      }
      if (this.settings.network) {
        const network = await this.docker.getNetwork(sandboxNetwork(this.settings.instance).name).inspect();
        assertSandboxNetwork(network, this.settings.instance);
        const core = await this.coreDocker.getContainer(hostname()).inspect();
        await assertNetworkReady(this.settings.rootView ?? hostRoot, network, core);
      }
      const checked = await this.workspaceCheck(this.settings.rootView ?? hostRoot, userId, this.settings.disk, this.settings.allowSoftQuota);
      const workspace = join(hostRoot, userId);
      const name = `${this.prefix}-u${userId}`;
      const existing = this.docker.getContainer(name);
      // A rebuilt tag must not leave old containers without current helpers.
      const image = await this.docker.getImage(this.settings.image).inspect();
      try {
        const info = await existing.inspect();
        if (info.Config.Labels?.['kamakura.sandbox'] !== this.settings.instance || info.Config.Labels?.['kamakura.owner'] !== userId) throw new Error('Sandbox name collision');
        if (info.Image === image.Id && info.Config.Labels?.['kamakura.config'] === this.fingerprint(userId) && info.Mounts?.some(m => m.Type === 'bind' && m.Source === workspace && m.Destination === '/work')) {
          if (!info.State.Running) await existing.start();
          return existing;
        }
        await existing.remove({ force: true });
      } catch (error) { if ((error as { statusCode?: number }).statusCode !== 404) throw error; }
      const containers = await this.docker.listContainers({ all: true, filters: JSON.stringify({ label: [`kamakura.sandbox=${this.settings.instance}`] }) });
      if (containers.length >= this.settings.maxContainers) throw new Error('Sandbox container limit reached; wait for idle cleanup');
      // Image must be prebuilt/pulled by the operator, never selected by the model.
      await this.docker.getImage(this.settings.image).inspect();
      const opts = sandboxOptions(userId, this.settings, workspace);
      opts.Env!.push(`KAMAKURA_DESKTOP_PASSWORD=${randomBytes(32).toString('hex')}`);
      opts.name = name;
      opts.Labels!['kamakura.config'] = this.fingerprint(userId);
      opts.Labels!['kamakura.quota'] = checked.hard ? 'loopback-ext4' : 'soft';
      const container = await this.docker.createContainer(opts);
      await container.start();
      return container;
    });
    this.creation = create;
    return create;
  }
  private async execute(container: Docker.Container, command: string, maxOutput = this.settings.maxOutput): Promise<{ output: string; exitCode: number | null; timedOut: boolean; truncated: boolean }> {
    const exec = await container.exec({ Cmd: ['timeout', '--signal=TERM', '--kill-after=2s', `${Math.ceil(this.settings.commandMs / 1000)}s`, 'bash', '-lc', command],
      AttachStdout: true, AttachStderr: true, AttachStdin: false, Tty: false, User: '1000:1000', WorkingDir: '/work' });
    const stream = await exec.start({ hijack: true, stdin: false });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    const sink = new Writable({ write: (chunk: Buffer, _encoding, done) => {
      const remaining = maxOutput - bytes;
      if (chunk.length > remaining) truncated = true;
      if (remaining > 0) { const part = chunk.subarray(0, remaining); chunks.push(part); bytes += part.length; }
      done();
    } });
    this.docker.modem.demuxStream(stream, sink, sink);
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const ended = new Promise<void>((resolve, reject) => { stream.once('end', resolve); stream.once('close', resolve); stream.once('error', reject); });
    try {
      await Promise.race([ended, new Promise<void>(resolve => {
        timer = setTimeout(() => { timedOut = true; resolve(); }, this.settings.commandMs + 3000);
      })]);
    } finally { clearTimeout(timer); }
    // Killing the whole container on timeout also kills children that escape `timeout`.
    if (timedOut) { try { await container.kill(); } finally { stream.destroy(); } }
    const state = await exec.inspect();
    if (state.ExitCode === 124 || state.ExitCode === 137) {
      timedOut = true;
      await container.kill().catch(error => { if (![404, 409].includes((error as { statusCode: number }).statusCode)) throw error; });
    }
    return { output: Buffer.concat(chunks).toString('utf8') + (truncated ? '\n[output truncated]' : ''), exitCode: state.ExitCode ?? null, timedOut, truncated };
  }
  async run(userId: string, command: string) {
    if (!this.authorized(userId)) throw new Error('This Telegram user is not authorized to run commands');
    if (!command.trim() || command.length > 8000 || command.includes('\0')) throw new Error('Command must be 1-8000 characters without NUL');
    return this.serial(userId, async () => {
      this.lastUsed.set(userId, Date.now());
      const container = await this.container(userId);
      try {
        if (this.settings.allowSoftQuota) {
          const usage = await this.execute(container, 'du -s -B1 /work');
          const bytes = Number(usage.output.match(/^\s*(\d+)/)?.[1]);
          if (usage.exitCode !== 0 || !Number.isFinite(bytes)) throw new Error('Cannot check workspace usage');
          if (bytes >= this.settings.disk) throw new Error('Workspace soft disk limit reached; operator must clean it up');
        }
        const result = await this.execute(container, command);
        return { ...result, workspace: '/work', diskLimit: this.settings.disk, quota: this.settings.allowSoftQuota ? 'soft fallback enabled; can exceed limit on unmounted directories' : 'hard, fixed-size ext4 filesystem' };
      } finally { this.lastUsed.set(userId, Date.now()); }
    });
  }
  async execPython(userId: string, code: string): Promise<{ text: string; images: string[] }> {
    if (!this.authorized(userId)) throw new Error('This Telegram user is not authorized for computer use');
    if (!code.trim() || code.length > 8000 || code.includes('\0')) throw new Error('Code must be 1-8000 characters without NUL');
    return this.serial(userId, async () => {
      this.lastUsed.set(userId, Date.now());
      const container = await this.container(userId);
      try {
        const request = Buffer.from(JSON.stringify({ code })).toString('base64');
        const result = await this.execute(container, `/opt/desktop-venv/bin/python /opt/kamakura/desktop-client.py '${request}'`, 6 * 1024 * 1024);
        if (result.timedOut) return { text: 'Desktop execution timed out; container killed, Python session reset on next call.', images: [] };
        if (result.exitCode !== 0 || result.truncated) return { text: result.output.slice(0, this.settings.maxOutput), images: [] };
        const parsed: unknown = JSON.parse(result.output);
        if (!parsed || typeof parsed !== 'object') throw new Error('Invalid desktop output');
        const response = parsed as { text?: unknown; images?: unknown };
        if (typeof response.text !== 'string' || !Array.isArray(response.images) || response.images.length > 2 || response.images.some(i => typeof i !== 'string' || i.length > 3 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(i))) throw new Error('Invalid desktop output');
        return { text: response.text.slice(0, this.settings.maxOutput), images: response.images as string[] };
      } finally { this.lastUsed.set(userId, Date.now()); }
    });
  }
  async desktopTarget(userId: string): Promise<{ url: string; authorization: string; containerId: string }> {
    if (!this.authorized(userId)) throw new Error('Desktop owner is not authorized');
    return this.serial(userId, async () => {
      this.lastUsed.set(userId, Date.now());
      const container = await this.container(userId);
      const info = await container.inspect();
      const ip = info.NetworkSettings.Networks?.bridge?.IPAddress;
      const password = info.Config.Env?.find(value => value.startsWith('KAMAKURA_DESKTOP_PASSWORD='))?.split('=')[1];
      if (!ip || !/^\d+\.\d+\.\d+\.\d+$/.test(ip) || !password || !/^[a-f0-9]{64}$/.test(password)) throw new Error('Desktop network or authentication unavailable');
      return { url: `http://${ip}:6080`, authorization: `Basic ${Buffer.from(`kamakura:${password}`).toString('base64')}`, containerId: info.Id };
    });
  }
  start(): void {
    if (!this.settings.allowed.size) return;
    if (this.settings.allowSoftQuota) logger.warn('SOFT QUOTA FALLBACK: workspace writes can exceed SANDBOX_DISK and fill the host disk');
    logger.info('Hard-quota bind mounts require pre-provisioned ext4 loopback mountpoints on the Linux Docker host; missing mounts fail closed');
    this.timer = setInterval(() => void this.cleanup().catch(error => logger.warn({ err: errorType(error) }, 'sandbox cleanup failed')), 60000);
    this.timer.unref();
    void this.cleanup().catch(error => logger.warn({ err: errorType(error) }, 'sandbox cleanup failed'));
  }
  async cleanup(): Promise<void> {
    const containers = await this.docker.listContainers({ all: true, filters: JSON.stringify({ label: [`kamakura.sandbox=${this.settings.instance}`] }) });
    for (const item of containers) {
      const user = item.Labels['kamakura.owner'];
      if (!user || this.queues.has(user)) continue;
      const last = this.lastUsed.get(user) ?? Date.now();
      if (!this.lastUsed.has(user)) this.lastUsed.set(user, last);
      if (this.authorized(user) && Date.now() - last < this.settings.idleMs) continue;
      // Lock again to prevent cleanup racing a just-started command.
      await this.serial(user, async () => {
        if (this.authorized(user) && Date.now() - (this.lastUsed.get(user) ?? 0) < this.settings.idleMs) return;
        await this.docker.getContainer(item.Id).remove({ force: true });
        this.lastUsed.delete(user);
      });
    }
    // Bind-mounted workspace directories survive idle cleanup and restarts.
  }
  stop(): void { clearInterval(this.timer); }
}
export const sandboxes = new SandboxManager();
