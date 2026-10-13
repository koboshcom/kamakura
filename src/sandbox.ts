import {videoArtifacts, type VideoLimits} from './video-link.js';
import {ownerId} from './owner-id.js';
import Docker from 'dockerode';
import {pack} from 'tar-stream';
import { Writable } from 'node:stream';
import { createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { checkWorkspace } from './workspace.js';
import { config } from './config.js';
import { EgressGuards, networkName } from './egress.js';
import { logger, errorType } from './logger.js';

type Settings = typeof config.sandbox;
const rootCaps = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'SETGID', 'SETUID', 'SETPCAP', 'NET_BIND_SERVICE'];
export function rootPolicy() {
  const size = process.env.SANDBOX_ROOTFS_SIZE || undefined;
  if (size && !/^[1-9][0-9]*(?:[kKmMgG])?$/.test(size)) throw new Error('Invalid SANDBOX_ROOTFS_SIZE');
  return { writable: true, size };
}
export function assertRootStorage(info: { Driver?: string; DriverStatus?: string[][] }, bounded: boolean) {
  if (bounded && (info.Driver !== 'overlay2' || !info.DriverStatus?.some(([key, value]) => key === 'Backing Filesystem' && value === 'xfs'))) {
    throw new Error('Optional root quota requires classic overlay2 on XFS with project quotas; omit SANDBOX_ROOTFS_SIZE on Docker Desktop (no hard root quota)');
  }
}
export function sandboxNetwork(instance: string) { return { name: networkName(instance) }; }
export function sandboxOptions(userId: string, settings: Settings, workspace: string, guardId: string): Docker.ContainerCreateOptions {
  const root = rootPolicy();
  if (!/^[a-f0-9]{64}$/.test(guardId)) throw new Error('A verified egress guard ID is required');
  return {
    Image: settings.image, User: '0:0', WorkingDir: '/work',
    Cmd: ['bash', '/opt/kamakura/start-desktop.sh'], Env: ['HOME=/work', 'TMPDIR=/tmp', 'DISPLAY=:99', 'XAUTHORITY=/tmp/kamakura.Xauthority'],
    Labels: { 'kamakura.sandbox': settings.instance, 'kamakura.owner': userId },
    HostConfig: {
      Mounts: [{ Type: 'bind', Source: workspace, Target: '/work', ReadOnly: false, BindOptions: { Propagation: 'rprivate' } }],
      ReadonlyRootfs: false, Privileged: false, CapDrop: ['ALL'],
      CapAdd: rootCaps, SecurityOpt: ['no-new-privileges:true'],
      ...(root.size ? { StorageOpt: { size: root.size } } : {}),
      RestartPolicy: { Name: 'no' },
      Runtime: 'runc', DeviceRequests: [], Devices: [],
      NetworkMode: `container:${guardId}`,
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
  private readonly guards: EgressGuards;
  constructor(private readonly settings: Settings = config.sandbox, docker?: Docker, private readonly workspaceCheck = checkWorkspace) {
    this.docker = docker ?? new Docker({ socketPath: settings.socketPath, timeout: 15000 });
    this.coreDocker = docker ?? new Docker({ socketPath: settings.coreSocketPath, timeout: 15000 });
    this.prefix = `kamakura-${settings.instance}`;
    this.guards = new EgressGuards(this.docker, settings.instance, settings.egressImage);
  }
  authorized(userId: string): boolean {
    // Wildcards are deliberately not accepted for arbitrary shell execution.
    return ownerId(userId) && this.settings.allowed.has(userId);
  }
  private async serial<T>(userId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(userId) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(operation);
    this.queues.set(userId, task);
    try { return await task; } finally { if (this.queues.get(userId) === task) this.queues.delete(userId); }
  }
  private fingerprint(userId: string, guardIdentity: string): string {
    const { allowed: _allowed, ...settings } = this.settings;
    return createHash('sha256').update('sandbox-runtime-v7-root-desktop-nnp').update(guardIdentity).update(JSON.stringify(rootPolicy())).update(JSON.stringify(settings)).digest('hex');
  }
  private async container(userId: string): Promise<Docker.Container> {
    // Serialize owner creation to avoid overlapping lifecycle operations.
    const create = this.creation.catch(() => undefined).then(async () => {
      const root = rootPolicy();
      const runtime = await this.docker.info();
      assertRootStorage(runtime, Boolean(root.size));
      let hostRoot = this.settings.root;
      if (this.settings.rootView) {
        // Docker resolves Compose's relative host path. Never guess /app on host.
        const core = await this.coreDocker.getContainer(hostname()).inspect();
        const mount = core.Mounts?.find(m => m.Type === 'bind' && m.Destination === this.settings.rootView);
        if (!mount?.Source?.startsWith('/')) throw new Error('Core sandbox root bind mount is missing');
        hostRoot = mount.Source;
      }
      const core = this.coreDocker.getContainer(hostname());
      const coreIps = await this.guards.network(core);
      const checked = await this.workspaceCheck(this.settings.rootView ?? hostRoot, userId, this.settings.disk, this.settings.allowSoftQuota);
      const workspace = join(hostRoot, userId);
      const name = `${this.prefix}-u${userId}`;
      const existing = this.docker.getContainer(name);
      const removeOwner = async () => {
        try {
          const info = await existing.inspect();
          if (info.Config.Labels?.['kamakura.sandbox'] !== this.settings.instance || info.Config.Labels?.['kamakura.owner'] !== userId) throw new Error('Sandbox name collision');
          await existing.remove({ force: true });
        } catch (error) { if ((error as { statusCode?: number }).statusCode !== 404) throw error; }
      };
      const guard = await this.guards.ready(userId, coreIps, removeOwner);
      const guardId = (await guard.container.inspect()).Id;
      const fingerprint = this.fingerprint(userId, guard.identity);
      // A rebuilt tag must not leave old containers without current helpers.
      const image = await this.docker.getImage(this.settings.image).inspect();
      try {
        const info = await existing.inspect();
        if (info.Config.Labels?.['kamakura.sandbox'] !== this.settings.instance || info.Config.Labels?.['kamakura.owner'] !== userId) throw new Error('Sandbox name collision');
        if (info.Image === image.Id && info.Config.Labels?.['kamakura.config'] === fingerprint && info.HostConfig.NetworkMode === `container:${guardId}` && info.Mounts?.some(m => m.Type === 'bind' && m.Source === workspace && m.Destination === '/work')) {
          if (!info.State.Running) await existing.start();
          return existing;
        }
        await existing.remove({ force: true });
      } catch (error) { if ((error as { statusCode?: number }).statusCode !== 404) throw error; }
      // Image must be prebuilt/pulled by the operator, never selected by the model.
      await this.docker.getImage(this.settings.image).inspect();
      const opts = sandboxOptions(userId, this.settings, workspace, guardId);
      opts.Env!.push(`KAMAKURA_DESKTOP_PASSWORD=${randomBytes(32).toString('hex')}`);
      opts.name = name;
      opts.Labels!['kamakura.config'] = fingerprint;
      opts.Labels!['kamakura.quota'] = checked.hard ? 'loopback-ext4' : 'soft';
      const container = await this.docker.createContainer(opts);
      await container.start();
      return container;
    });
    this.creation = create;
    return create;
  }
  private async execute(container: Docker.Container, command: string, maxOutput = this.settings.maxOutput, argv?: string[], commandMs = this.settings.commandMs): Promise<{ output: string; exitCode: number | null; timedOut: boolean; truncated: boolean }> {
    const exec = await container.exec({ Cmd: ['timeout', '--signal=TERM', '--kill-after=2s', `${Math.ceil(commandMs / 1000)}s`, ...(argv ?? ['bash', '-lc', command])],
      AttachStdout: true, AttachStderr: true, AttachStdin: false, Tty: false, User: '0:0', WorkingDir: '/work' });
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
        timer = setTimeout(() => { timedOut = true; resolve(); }, commandMs + 3000);
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
  async stageVideoUpload(userId:string,data:Buffer) {
    if(!this.authorized(userId)||!data.length||data.length>Math.min(config.maxMediaBytes,32*1024*1024))throw new Error('Video upload unavailable or over limit');
    return this.serial(userId,async()=>{
      const container=await this.container(userId),id=randomBytes(24).toString('hex');
      const archive=pack(); const done=container.putArchive(archive as unknown as NodeJS.ReadableStream,{path:'/tmp'});
      archive.entry({name:'kamakura-upload-'+id+'.bin',size:data.length,mode:0o400,type:'file'},data);archive.finalize();
      await done;
      return {id,sha256:createHash('sha256').update(data).digest('hex'),bytes:data.length};
    });
  }
  async removeVideoUpload(userId:string,id:string) {
    if(!this.authorized(userId)||!/^[a-f0-9]{48}$/.test(id))return;
    return this.serial(userId,async()=>{const c=this.docker.getContainer(this.prefix+'-u'+userId);try{await c.inspect();}catch{return;}await this.execute(c,'',1024,['/usr/bin/python3','-I','-c',"import os,sys; p='/tmp/kamakura-upload-'+sys.argv[1]+'.bin'; os.unlink(p) if os.path.lexists(p) else None",id]);});
  }
  async inspectVideo(userId: string, url: string, limits: VideoLimits, upload?:{id:string;sha256:string;bytes:number}) {
    if (!this.authorized(userId)) throw new Error('Video owner is not authorized');
    return this.serial(userId, async () => {
      this.lastUsed.set(userId, Date.now());
      const container = await this.container(userId);
      // Never copy arbitrary paths or mount credentials. Only helper-generated bounded JSON.
      const bounded = {...limits, timeout: Math.min(limits.timeout, Math.max(3, Math.floor(this.settings.commandMs/1000)-2))};
      const payload = Buffer.from(JSON.stringify({...bounded,...(upload?{upload}: {url})})).toString('base64');
      try {
        const result = await this.execute(container, '', 9*1024*1024, [
          'env','-i','HOME=/tmp','PATH=/opt/desktop-venv/bin:/usr/bin:/bin','PYTHONNOUSERSITE=1','YTDLP_NO_PLUGINS=1',
          '/opt/desktop-venv/bin/python','-I','/opt/kamakura/video-link.py',payload]);
        if(result.timedOut||result.truncated||result.exitCode!==0)throw new Error('Video helper unavailable or exceeded limits');
        return videoArtifacts(result.output,bounded);
      } finally {this.lastUsed.set(userId,Date.now());}
    });
  }
  async nativeVideoClip(userId:string,url:string,limits:VideoLimits,upload?:{id:string;sha256:string;bytes:number}) {
    if(!this.authorized(userId))throw new Error('Video owner is not authorized');
    return this.serial(userId,async()=>{
      const container=await this.container(userId);
      const bounded={...limits,timeout:Math.min(limits.timeout,60)};
      const payload=Buffer.from(JSON.stringify({...bounded,nativeClip:true,...(upload?{upload}:{url})})).toString('base64');
      const r=await this.execute(container,'',12*1024*1024,['env','-i','HOME=/tmp','PATH=/opt/desktop-venv/bin:/usr/bin:/bin','PYTHONNOUSERSITE=1','YTDLP_NO_PLUGINS=1','/opt/desktop-venv/bin/python','-I','/opt/kamakura/video-link.py',payload],bounded.timeout*1000);
      if(r.timedOut||r.truncated||r.exitCode!==0)throw new Error('Video clip helper unavailable');
      let v:any;try{v=JSON.parse(r.output);}catch{throw new Error('Invalid native clip');}
      if(v.ok!==true){
        const code=typeof v.error==='string'&&/^native_[a-z_]+$/.test(v.error)?v.error:'unavailable_or_cap';
        const safe={sourceDuration:v.sourceDuration,requestedCoverage:v.requestedCoverage,processedCap:v.processedCap,minimumProcessedSeconds:v.minimumProcessedSeconds};
        const detail=JSON.stringify(safe);
        const transferred=Number.isInteger(v.transferBytes)&&v.transferBytes>=0&&v.transferBytes<=limits.bytes?v.transferBytes:limits.bytes;
        throw Object.assign(new Error('Native clip blocked: '+code+' '+detail),{nativeTransferBytes:transferred});
      }
      if(v.mime!=='video/mp4'||typeof v.clip!=='string'||v.clip.length>11200000||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v.clip))throw new Error('Invalid native clip');
      const data=Buffer.from(v.clip,'base64');
      if(!data.length||data.length>Math.min(limits.bytes,8*1024*1024)||data.toString('ascii',4,8)!=='ftyp'||v.start!==(limits.nativeConfig&&!limits.nativeConfig.explicitRange?0:limits.start)||((!limits.nativeConfig||limits.nativeConfig.explicitRange)&&v.end!==limits.start!+limits.seconds)||v.fingerprint!==createHash('sha256').update(data).digest('hex')||!Number.isInteger(v.transferBytes)||v.transferBytes<0||v.transferBytes>limits.bytes||!Number.isFinite(v.processedSeconds)||v.processedSeconds<limits.seconds||v.processedSeconds>(limits.processedCap??60))throw new Error('Native clip budget/coverage failure');
      if(limits.nativeConfig){
        const c=limits.nativeConfig;
        if(v.pipelineVersion!==c.version||v.codec!=='h264'||!Number.isFinite(v.sourceDuration)||v.sourceDuration<=0||!Number.isFinite(v.end)||v.end<=v.start||v.end>v.sourceDuration+0.05||v.end-v.start>c.maxShort||v.fps!==c.fps||![v.width,v.height].every(n=>Number.isInteger(n)&&n>0&&n<=c.dimension)||v.frameCount!==Math.ceil((v.end-v.start)*c.fps-0.00001)||!Number.isFinite(v.encodedDuration)||v.encodedDuration<v.end-v.start-0.15||v.encodedDuration>v.end-v.start+1/c.fps+0.15||!/^([a-f0-9]{64})$/.test(v.sourceFingerprint)||typeof v.fullSource!=='boolean'||(!c.explicitRange&&(!v.fullSource||v.end!==v.sourceDuration)))throw new Error('Native clip verified coverage failure');
      }
      return {sourceDuration:v.sourceDuration as number,fullSource:v.fullSource as boolean,fps:v.fps as number,width:v.width as number,height:v.height as number,frameCount:v.frameCount as number,encodedDuration:v.encodedDuration as number,codec:v.codec as string,pipelineVersion:v.pipelineVersion as string,sourceFingerprint:v.sourceFingerprint as string,data,mime:'video/mp4' as const,start:v.start as number,end:v.end as number,transferBytes:v.transferBytes as number,processedSeconds:v.processedSeconds as number,fingerprint:v.fingerprint as string};
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
      const mode = info.HostConfig.NetworkMode;
      if (!mode?.startsWith('container:')) throw new Error('Desktop is not attached to an egress guard');
      const guard = await this.docker.getContainer(mode.slice('container:'.length)).inspect();
      const ip = guard.NetworkSettings.Networks?.[sandboxNetwork(this.settings.instance).name]?.IPAddress;
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
        await this.guards.remove(user);
        this.lastUsed.delete(user);
      });
    }
    // Bind-mounted workspace directories survive idle cleanup and restarts.
  }
  stop(): void { clearInterval(this.timer); }
}
export const sandboxes = new SandboxManager();
