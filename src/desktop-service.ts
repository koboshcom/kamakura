import { DesktopAccess } from './desktop-access.js';
import { config } from './config.js';
import { sandboxes } from './sandbox.js';

const authorized = (owner: string) => config.telegramAllowed.has(owner) && sandboxes.authorized(owner);
export const desktopAccess = config.desktopPublicBaseUrl ? new DesktopAccess({
  publicBaseUrl: config.desktopPublicBaseUrl,
  ttlMs: config.desktopTtlMs,
  trustedProxies: config.desktopTrustedProxies,
  isAuthorized: authorized,
  resolveTarget: async (owner, containerId) => {
    const target = await sandboxes.desktopTarget(owner);
    if (target.containerId !== containerId) throw new Error('Desktop container was replaced');
    return { ip: new URL(target.url).hostname, authorization: target.authorization };
  },
}) : undefined;

export async function desktopLink(owner: string): Promise<{ url: string; expiresInSeconds: number }> {
  if (!desktopAccess || !authorized(owner)) throw new Error('Desktop access is not configured or authorized');
  const target = await sandboxes.desktopTarget(owner);
  return { url: desktopAccess.issue(owner, target.containerId), expiresInSeconds: Math.floor(config.desktopTtlMs / 1000) };
}
export async function startDesktopAccess(): Promise<void> {
  if (!desktopAccess) return;
  await new Promise<void>((resolve, reject) => {
    desktopAccess!.server.once('error', reject);
    desktopAccess!.server.listen(config.desktopPort, config.desktopHost, resolve);
  });
}
