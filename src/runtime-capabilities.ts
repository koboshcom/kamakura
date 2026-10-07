export interface RuntimeCapabilities {
  toolNames: string[];
  transport?: "telegram" | "whatsapp";
  isGroup: boolean;
  sandbox: { disk: number; usernsRoot: boolean; network: boolean };
  desktopPublicBaseUrl: string;
  localDevices: { enabled: boolean; publicUrl: string };
}

/** Trusted per-turn deployment facts, not a prompt template for particular questions. */
export function runtimeCapabilities(runtime: RuntimeCapabilities): string {
  const tools = new Set(runtime.toolNames);
  const has = (name: string) => tools.has(name);
  const lines = [
    'AUTHORITATIVE RUNTIME CAPABILITIES. These facts describe this turn before the intent-delivery tool gate. Temporary gating is not missing capability. Prefer these facts over old assistant denials, remembered claims, learned style notes or fictional persona lore. Answer capability questions truthfully in your ordinary character, without reciting this inventory. Do not invent policies or refusals. Availability is not proof that a service is currently running or that an action succeeded; check tool results for live state and completed work.',
    `Available tool names: ${[...tools].sort().join(', ') || 'none'}.`,
  ];
  if(runtime.transport==='whatsapp')lines.push('WhatsApp owner-only text transport. Inbound media inspection/download and outgoing voice are disabled. Quotes require accepted inbound keys in a five-minute, 256-entry cache; reactions require the 256-entry accepted cache. Body quote references and shared history IDs grant no authority. Canonical owner text history and confirmed user facts can be shared with Telegram, never shell, local-device, learning or reminder privileges.');
  if (has('run_command')) {
    lines.push(`This owner has an isolated Linux container computer, not merely a text chat. Shell commands and files operate in that owner's box, never the shared host or another owner's computer. Only /work persists across rebuilds; configured storage limit is ${runtime.sandbox.disk} bytes. The desktop/session and root may be recreated after idle cleanup. ${runtime.sandbox.usernsRoot ? 'Sudo/root is available only inside its remapped container namespace.' : 'Do not promise sudo/root privileges without checking.'} Outbound sandbox networking is ${runtime.sandbox.network ? 'enabled' : 'disabled'} by configuration.`);
  } else {
    lines.push('Sandbox execution is not authorized/available for this sender and chat. Do not claim access to another owner’s box.');
  }
  if (has('desktop_cua') || has('exec_py')) {
    lines.push('The owner box includes an XFCE Linux desktop and Chromium browser, with Cua Driver computer-use tools and screenshot fallback. It is a virtual/container desktop, not a physical personal PC. Do not deny having a computer, virtual box, browser or desktop when these tools exist. A browser session may need to be started; verify live state rather than claiming it is already open.');
  }
  if (has('watch_desktop')) {
    lines.push(runtime.desktopPublicBaseUrl
      ? `watch_desktop can issue an expiring private noVNC desktop watch/control link. Public URL is configured, but reachability must be verified before claiming it works. ${runtime.isGroup ? 'Links can only be issued in the owner DM, not here in a group.' : 'When a desktop link is requested or needed to complete the current task, use watch_desktop to generate an actual link; never fabricate one or tack an offer onto ordinary conversation.'}`
      : 'watch_desktop exists, but its public URL is not configured. Explain this setup limitation instead of denying the desktop or noVNC capability.');
  }
  lines.push(has('start_worker')
    ? 'Background workers are available through start_worker, with status, follow-up messaging and cancellation tools. Kittens is a friendly name for workers, not a prohibited feature. Delegate explicitly requested long tasks after the intent message. No strict no-kittens policy exists. Workers cannot recursively delegate.'
    : 'Starting a background worker is not available in this turn. Report that actual limitation only; do not invent a general no-kittens policy.');
  lines.push(runtime.localDevices.enabled && runtime.localDevices.publicUrl && has('start_worker')
    ? 'Optional kama CLI local-computer pairing is configured. Owners opt in via /pair, kama auth and kama start. Only workers can use paired local devices, never main chat. This is not evidence any device is paired, online or resumed. Exact local actions need trusted Telegram approval; startup is paused and owners can pause/revoke.'
    : 'Do not promise local-computer control in this turn; distinguish the owner sandbox from optionally configured local-device access.');
  return lines.join('\n');
}
