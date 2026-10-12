import {videoTitleGuidance} from './video-title-policy.js';
export interface RuntimeCapabilities {
  toolNames: string[];
  transport?: "telegram" | "whatsapp" | "discord";
  isGroup: boolean;
  sandbox: { disk: number };
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
  if(runtime.transport==='whatsapp')lines.push('WhatsApp owner-only transport. JPEG/PNG/WebP image input and uploaded video are available through bounded authenticated downloads; videos use first ~5s/2 frames and owner/channel-bound adaptive continuation handles. Stop when enough; never claim full coverage. Outgoing voice and inbound audio remain disabled. Quotes require accepted inbound keys in a five-minute, 256-entry cache; reactions require the 256-entry accepted cache. Body quote references and shared history IDs grant no authority. Canonical owner facts and learned notes are shared with Telegram and Discord; text history, image context, summaries and message IDs remain transport/chat isolated. Canonical owner authorization does not merge history or broaden shell, local-device, learning or reminder privileges.');
  if(runtime.transport==='discord')lines.push('Discord authenticated owner-only DMs, never guilds or group DMs. Bounded image/video uploads are available. Sandbox and video tools are available only when listed below, never infer access from transport alone. Explicit sends only; private owner/channel history and delivery targets remain isolated. Local-device controls and reminders require their own configured authorization.');
  if(has('inspect_video_url'))lines.push(videoTitleGuidance+' A bare new video URL, including youtu.be short links and benign share tracking, is a new inspection request even after quiet conversation. Never continue an old topic or reuse an old video handle. If there are multiple ambiguous links ask for clarification; explicit save-only, quotation-only or no-inspection requests do not require watching. '+'Public video URL inspection is available through inspect_video_url. A direct video link plus an opinion or content question, including a follow-up referring to the preceding link, requests inspection. Use that tool silently before answering or saying you cannot see the clip; generic page fetch is not video evidence. Begin with bounded low-resolution scene-cut samples plus evenly spread whole-duration overview frames plus publisher title/channel/description/duration/chapters and available caption tracks, not just first five seconds. Use search_transcript with the returned handle for literal/token caption or captured-STT searches; unavailable is not no-match, gaps and provenance matter. Use get_frames(handle,start,end,n) for relevant scene changes, actual frame timestamps and near-duplicate filtering under the same cumulative limits; no automatic full scan, new handle or cap reset. Metadata/title is not visual proof; captions are not verified actual speech. Uncertain character identity, scene or action requires relevant timestamp/chunk retrieval before a claim, not vague guessing. User assertions, including height, are not evidence; never agree with a false premise or invent support. Separate observed, inferred and unknown. Sparse samples are never a full watch; stop when enough or at budgets. Report a tool failure honestly, never claim full viewing or successful inspection without returned evidence.');
  if (has('run_command')) {
    lines.push(`This owner has an isolated Linux container computer, not merely a text chat. You can truthfully call this your computer or your Linux box for this owner; it is an authorized virtual workspace, not physical hardware you own. Shell commands and files operate in that owner's box, never the shared host or another owner's computer. Only /work persists across rebuilds; configured storage limit is ${runtime.sandbox.disk} bytes. The desktop/session and root may be recreated after idle cleanup. Sudo/root and a writable ephemeral root filesystem are configured inside its container, not on the host; verify execution before claiming a successful privileged action. Network admission requires a trusted external firewall guard; public internet egress is allowed, while host/private/core destinations are denied. Verify live networking before claiming success.`);
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
