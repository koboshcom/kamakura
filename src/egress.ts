import type Docker from 'dockerode';
import { Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

export function networkName(instance: string): string {
  const name = process.env.SANDBOX_NETWORK_NAME || `kamakura-${instance}-sandboxes`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(name)) throw new Error('Invalid sandbox network name');
  return name;
}
export function deniedAddresses(): string[] {
  const addresses = (process.env.SANDBOX_DENIED_IPS || '').split(',').map(x => x.trim()).filter(Boolean);
  if (addresses.some(x => !isIP(x))) throw new Error('SANDBOX_DENIED_IPS must contain numeric host/LAN public addresses');
  return [...new Set(addresses)].sort();
}
export function assertPortableNetwork(info: Docker.NetworkInspectInfo, instance: string): void {
  if (info.Name !== networkName(instance) || info.Driver !== 'bridge' || info.Internal ||
      info.Options?.['com.docker.network.bridge.enable_icc'] === 'false' ||
      info.Labels?.['kamakura.network-policy'] !== 'guard-v2' || info.Labels?.['kamakura.sandbox'] !== instance) {
    throw new Error('Portable sandbox network missing or invalid; old host-firewall networks are not reused');
  }
}
export async function guardCommand(docker: Docker, container: Docker.Container, mode: 'install' | 'check'): Promise<string> {
  const exec = await container.exec({ Cmd: ['python3', '/opt/kamakura/egress-guard.py', mode],
    User: '0', AttachStdout: true, AttachStderr: true, Tty: false });
  const stream = await exec.start({ hijack: true, stdin: false });
  const chunks: Buffer[] = [];
  let bytes = 0;
  const sink = new Writable({ write(chunk: Buffer, _encoding, done) {
    bytes += chunk.length;
    if (bytes <= 16384) chunks.push(chunk);
    done();
  } });
  docker.modem.demuxStream(stream, sink, sink);
  let timer: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => { stream.destroy(); reject(new Error('Egress guard check timed out')); }, 10000);
      stream.once('end', resolve); stream.once('error', reject);
    });
  } finally { clearTimeout(timer); }
  if ((await exec.inspect()).ExitCode !== 0 || bytes > 16384) throw new Error('Egress guard enforcement unavailable');
  const text = Buffer.concat(chunks).toString('utf8').trim();
  const proof = JSON.parse(text);
  if (!/^[a-f0-9]{64}$/.test(proof.policy) || !/^net:\[\d+\]$/.test(proof.namespace)) throw new Error('Invalid egress guard proof');
  return text;
}
export function guardOptions(name: string, image: string, instance: string, user: string, coreIps: string[], denied: string[]): Docker.ContainerCreateOptions {
  if ([...coreIps, ...denied].some(x => !isIP(x))) throw new Error('Invalid egress address');
  return {
    name, Image: image, User: '0', Entrypoint: ['sleep'], Cmd: ['infinity'],
    Env: [`CORE_IPS=${coreIps.sort().join(',')}`, `DENIED_IPS=${denied.join(',')}`],
    Labels: { 'kamakura.egress': instance, 'kamakura.owner': user },
    HostConfig: {
      NetworkMode: networkName(instance), ReadonlyRootfs: true, Privileged: false,
      CapDrop: ['ALL'], CapAdd: ['NET_ADMIN'], SecurityOpt: ['no-new-privileges:true'],
      Mounts: [], Devices: [], DeviceRequests: [], PidsLimit: 16,
      Memory: 64 * 1024 * 1024, MemorySwap: 64 * 1024 * 1024, NanoCpus: 100000000,
      Tmpfs: { '/run': 'rw,noexec,nosuid,nodev,size=1m', '/tmp': 'rw,noexec,nosuid,nodev,size=1m' },
      RestartPolicy: { Name: 'no' }, Init: true,
      LogConfig: { Type: 'local', Config: { 'max-size': '1m', 'max-file': '1' } },
    },
  };
}

/** Each owner has a trusted, mount-free firewall filesystem and PID namespace.
 * The owner shares ONLY its guarded network, never its filesystem/capabilities. */
export class EgressGuards {
  constructor(private readonly docker: Docker, private readonly instance: string, private readonly image: string) {}
  async network(core?: Docker.Container): Promise<string[]> {
    const name = networkName(this.instance);
    let network = this.docker.getNetwork(name);
    try { assertPortableNetwork(await network.inspect(), this.instance); }
    catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 404) throw error;
      network = await this.docker.createNetwork({ Name: name, Driver: 'bridge', Internal: false,
        Labels: { 'kamakura.network-policy': 'guard-v2', 'kamakura.sandbox': this.instance } });
      assertPortableNetwork(await network.inspect(), this.instance);
    }
    if (!core) throw new Error('A Docker core container is required for guarded desktop connectivity');
    let info = await core.inspect();
    if (!info.NetworkSettings.Networks?.[name]) {
      await network.connect({ Container: info.Id });
      info = await core.inspect();
    }
    return Object.values(info.NetworkSettings.Networks ?? {}).flatMap(n => [n.IPAddress, n.GlobalIPv6Address]).filter(x => Boolean(x));
  }
  async ready(user: string, coreIps: string[], removeOwner: () => Promise<void>): Promise<{ container: Docker.Container; identity: string }> {
    const name = `kamakura-${this.instance}-egress-u${user}`;
    const image = await this.docker.getImage(this.image).inspect();
    const options = guardOptions(name, this.image, this.instance, user, coreIps, deniedAddresses());
    const fingerprint = createHash('sha256').update(JSON.stringify(options)).update(image.Id).digest('hex');
    options.Labels!['kamakura.config'] = fingerprint;
    let guard = this.docker.getContainer(name);
    try {
      const info = await guard.inspect();
      if (info.Config.Labels?.['kamakura.egress'] !== this.instance || info.Config.Labels?.['kamakura.owner'] !== user) throw new Error('Egress guard name collision');
      if (info.State.Running && info.Image === image.Id && info.Config.Labels?.['kamakura.config'] === fingerprint &&
          info.HostConfig.NetworkMode === networkName(this.instance)) {
        try {
          const proof = await guardCommand(this.docker, guard, 'check');
          return { container: guard, identity: info.Id + ':' + info.State.StartedAt + ':' + proof };
        } catch (error) { await removeOwner(); throw error; }
      }
      // Owner must be removed before its network provider is replaced.
      await removeOwner();
      await guard.remove({ force: true });
    } catch (error) { if ((error as { statusCode?: number }).statusCode !== 404) throw error; }
    guard = await this.docker.createContainer(options);
    try {
      await guard.start();
      await guardCommand(this.docker, guard, 'install');
      const proof = await guardCommand(this.docker, guard, 'check');
      const info = await guard.inspect();
      return { container: guard, identity: info.Id + ':' + info.State.StartedAt + ':' + proof };
    } catch (error) { await guard.remove({ force: true }).catch(() => undefined); throw error; }
  }
  async remove(user: string): Promise<void> {
    const guard = this.docker.getContainer(`kamakura-${this.instance}-egress-u${user}`);
    try {
      const info = await guard.inspect();
      if (info.Config.Labels?.['kamakura.egress'] !== this.instance || info.Config.Labels?.['kamakura.owner'] !== user) throw new Error('Egress guard name collision');
      await guard.remove({ force: true });
    } catch (error) { if ((error as { statusCode?: number }).statusCode !== 404) throw error; }
  }
}
