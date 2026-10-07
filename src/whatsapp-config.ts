import { isAbsolute, resolve, sep } from "node:path";
export interface WhatsAppConfig {
  enabled: boolean;
  authDir: string;
  owners: Map<string, string>;
  lidBindings: Map<string, string>;
  maxMediaBytes: number;
  maxAgeMs: number;
}
export function whatsappConfig(
  env: NodeJS.ProcessEnv = process.env,
): WhatsAppConfig {
  const enabled = env.WHATSAPP_ENABLED === "true";
  if (env.WHATSAPP_ENABLED && !["true", "false"].includes(env.WHATSAPP_ENABLED))
    throw new Error("Invalid WhatsApp flag");
  const result: WhatsAppConfig = {
    enabled,
    authDir: env.WHATSAPP_AUTH_DIR ?? "",
    owners: new Map(),
    lidBindings: new Map(),
    maxMediaBytes: Math.min(20971520, Number(env.MAX_MEDIA_BYTES ?? 20971520)),
    maxAgeMs: 120000,
  };
  if (!enabled) return result;
  if (!isAbsolute(result.authDir))
    throw new Error("Private absolute auth volume required");
  for (const unsafe of [
    env.DATA_DIR ?? "./data",
    env.SANDBOX_ROOT ?? "./sandboxes",
    process.cwd(),
  ]) {
    const root = resolve(unsafe);
    if (
      resolve(result.authDir) === root ||
      resolve(result.authDir).startsWith(root + sep)
    )
      throw new Error("Auth volume overlaps exposed storage");
  }
  const rows: unknown = JSON.parse(env.WHATSAPP_OWNER_NUMBERS ?? "{}");
  if (!rows || typeof rows !== "object" || Array.isArray(rows))
    throw new Error("Invalid owner mapping");
  const chats = new Set((env.WHATSAPP_ALLOWED_NUMBERS ?? "").split(","));
  const owners = new Set((env.SANDBOX_ALLOWED_USERS ?? "").split(","));
  for (const [phone, owner] of Object.entries(rows)) {
    if (
      !/^[+][1-9][0-9]{7,14}$/.test(phone) ||
      !["6612253937", "7853500388"].includes(String(owner)) ||
      typeof owner !== "string" ||
      !chats.has(phone) ||
      !owners.has(owner)
    )
      throw new Error("Owner mapping not explicitly authorized");
    result.owners.set(phone.slice(1) + "@s.whatsapp.net", owner);
  }
  if (
    !result.owners.size ||
    chats.has("*") ||
    owners.has("*") ||
    !Number.isSafeInteger(result.maxMediaBytes) ||
    result.maxMediaBytes < 1024
  )
    throw new Error("Invalid WhatsApp authorization");
  const bindings: unknown = JSON.parse(env.WHATSAPP_LID_BINDINGS ?? "{}");
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings))
    throw new Error("Invalid operator LID bindings");
  for (const [lid, phone] of Object.entries(bindings)) {
    if (!/^[1-9][0-9]{0,19}@lid$/.test(lid) || typeof phone !== "string" ||
        !/^[+][1-9][0-9]{7,14}$/.test(phone) ||
        !result.owners.has(phone.slice(1) + "@s.whatsapp.net"))
      throw new Error("LID binding not explicitly authorized");
    result.lidBindings.set(lid, phone.slice(1) + "@s.whatsapp.net");
  }
  return result;
}
