import Docker from 'dockerode';
import { Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { config } from './config.js';
import { logger, errorType } from './logger.js';

type Settings = typeof config.sandbox;
export function sandboxOptions(userId: string, settings: Settings, volume: string): Docker.ContainerCreateOptions {
  return {
    Image: settings.image, User: '1000:1000', WorkingDir: '/workspace',
    Cmd: ['sleep', 'infinity'], Env: ['HOME=/workspace', 'TMPDIR=/tmp'],
    Labels: { 'kamakura.sandbox': settings.instance, 'kamakura.owner': userId },
    HostConfig: {
      Mounts: [{ Type: 'volume', Source: volume, Target: '/workspace', ReadOnly: false }],
      ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'],
      NetworkMode: settings.network ? 'bridge' : 'none',
      NanoCpus: Math.round(settings.cpus * 1e9), Memory: settings.memory, MemorySwap: settings.memory,
      PidsLimit: settings.pids, Init: true,
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=128m,mode=1777' },
      LogConfig: { Type: 'local', Config: { 'max-size': '5m', 'max-file': '1' } },
      Ulimits: [{ Name: 'nofile', Soft: 1024, Hard: 1024 }],
    },
  };
}

export class SandboxManager {
  private readonly docker: Docker;
  private queues = new Map<string, Promise<unknown>>();
  private creation: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private lastUsed = new Map<string, number>();
  private readonly prefix: string;
  constructor(private readonly settings: Settings = config.sandbox, docker?: Docker) {
    this.docker = docker ?? new Docker({ socketPath: settings.socketPath, timeout: 15000 });
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
  private fingerprint(): string {
    const { allowed: _allowed, ...settings } = this.settings;
    return createHash('sha256').update(JSON.stringify(settings)).digest('hex');
  }
  private async container(userId: string): Promise<Docker.Container> {
    // Serialize creation across users to enforce the global container count.
    const create = this.creation.catch(() => undefined).then(async () => {
      const name = `${this.prefix}-u${userId}`;
      const existing = this.docker.getContainer(name);
      try {
        const info = await existing.inspect();
        if (info.Config.Labels?.['kamakura.sandbox'] !== this.settings.instance || info.Config.Labels?.['kamakura.owner'] !== userId) throw new Error('Sandbox name collision');
        if (info.Config.Labels?.['kamakura.config'] === this.fingerprint()) {
          if (!info.State.Running) await existing.start();
          return existing;
        }
        await existing.remove({ force: true });
      } catch (error) { if ((error as { statusCode?: number }).statusCode !== 404) throw error; }
      const containers = await this.docker.listContainers({ all: true, filters: JSON.stringify({ label: [`kamakura.sandbox=${this.settings.instance}`] }) });
      if (containers.length >= this.settings.maxContainers) throw new Error('Sandbox container limit reached; wait for idle cleanup');
      if (this.settings.volumeDriver === 'local' && !this.settings.allowSoftQuota) throw new Error('A quota-capable volume driver is required. SANDBOX_ALLOW_SOFT_QUOTA=true explicitly opts into a soft disk check instead.');
      // Image must be prebuilt/pulled by the operator, never selected by the model.
      await this.docker.getImage(this.settings.image).inspect();
      const volume = `${this.prefix}-data-u${userId}`;
      const options = Object.fromEntries(Object.entries(this.settings.volumeOptions).map(([key, value]) => [key, value.replaceAll('{bytes}', String(this.settings.disk))]));
      try {
        const info = await this.docker.getVolume(volume).inspect();
        if (info.Labels?.['kamakura.owner'] !== userId || info.Labels?.['kamakura.sandbox'] !== this.settings.instance) throw new Error('Volume ownership mismatch');
        if (info.Labels?.['kamakura.disk'] !== String(this.settings.disk) || info.Driver !== this.settings.volumeDriver || JSON.stringify(info.Options ?? {}) !== JSON.stringify(options)) throw new Error('Existing volume configuration differs. Migrate data to a new SANDBOX_INSTANCE before changing quota/driver.');
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 404) throw error;
        await this.docker.createVolume({ Name: volume, Driver: this.settings.volumeDriver, DriverOpts: options,
          Labels: { 'kamakura.sandbox': this.settings.instance, 'kamakura.owner': userId, 'kamakura.disk': String(this.settings.disk) } });
      }
      const opts = sandboxOptions(userId, this.settings, volume);
      opts.name = name;
      opts.Labels!['kamakura.config'] = this.fingerprint();
      const container = await this.docker.createContainer(opts);
      await container.start();
      return container;
    });
    this.creation = create;
    return create;
  }
  private async execute(container: Docker.Container, command: string): Promise<{ output: string; exitCode: number | null; timedOut: boolean; truncated: boolean }> {
    const exec = await container.exec({ Cmd: ['timeout', '--signal=TERM', '--kill-after=2s', `${Math.ceil(this.settings.commandMs / 1000)}s`, 'bash', '-lc', command],
      AttachStdout: true, AttachStderr: true, AttachStdin: false, Tty: false, User: '1000:1000', WorkingDir: '/workspace' });
    const stream = await exec.start({ hijack: true, stdin: false });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    const sink = new Writable({ write: (chunk: Buffer, _encoding, done) => {
      const remaining = this.settings.maxOutput - bytes;
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
          const usage = await this.execute(container, 'du -s -B1 /workspace');
          const bytes = Number(usage.output.match(/^\s*(\d+)/)?.[1]);
          if (usage.exitCode !== 0 || !Number.isFinite(bytes)) throw new Error('Cannot check workspace usage');
          if (bytes >= this.settings.disk) throw new Error('Workspace soft disk limit reached; operator must clean it up');
        }
        const result = await this.execute(container, command);
        return { ...result, workspace: '/workspace', diskLimit: this.settings.disk, quota: this.settings.allowSoftQuota ? 'soft, can be exceeded during a command' : 'operator-configured volume driver' };
      } finally { this.lastUsed.set(userId, Date.now()); }
    });
  }
  start(): void {
    if (!this.settings.allowed.size) return;
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
    // Named workspace volumes survive idle cleanup and restarts.
  }
  stop(): void { clearInterval(this.timer); }
}
export const sandboxes = new SandboxManager();
