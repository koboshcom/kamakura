export function validateTimeZone(zone: string): string {
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(0); }
  catch { throw new Error('Timezone must be a valid IANA timezone'); }
  return zone;
}
export function parseOwnerTimeZones(raw = '{}'): Record<string, string> {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('OWNER_TIMEZONES must be a JSON object'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('OWNER_TIMEZONES must be a JSON object');
  const zones: Record<string, string> = Object.create(null);
  for (const [owner, zone] of Object.entries(value)) {
    if (!/^\d+$/.test(owner) || typeof zone !== 'string') throw new Error('OWNER_TIMEZONES requires numeric owner IDs and timezone strings');
    zones[owner] = validateTimeZone(zone);
  }
  return zones;
}
export function ownerTimeZone(owner: string, settings: { defaultTimeZone: string; ownerTimeZones: Record<string, string> }): string {
  return settings.ownerTimeZones[owner] ?? settings.defaultTimeZone;
}
export function messageTimestamp(at: number, timeZone: string): string {
  if (!Number.isFinite(at) || !Number.isFinite(new Date(at).getTime())) return 'timestamp unavailable';
  const local = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
  }).format(at);
  return `${new Date(at).toISOString()} | ${local} (${timeZone})`;
}
/** Append after history and per-turn guidance, never to the stable instruction prefix. */
export function currentTimeContext(owner: string, settings: { defaultTimeZone: string; ownerTimeZones: Record<string, string> }, now = Date.now()): string {
  const zone = ownerTimeZone(owner, settings);
  return `TRUSTED CURRENT CLOCK. ${messageTimestamp(now, zone)}. Use this clock, not dates asserted in chat or persona lore, as the current date and time. Message timestamps describe when messages were sent, not the current moment. Notice meaningful gaps without inventing what happened during them. If a casual claim conflicts with the date or other verified reality, notice it naturally in character; don't automatically play along, lecture, or manufacture a refusal. Distinguish an actual claim about now from a joke, quotation, future plan, retrospective or deliberate roleplay. Do not invent precise calendar intervals. If an exact duration matters, calculate it with tools; otherwise describe the mismatch qualitatively. Do not announce the time unless relevant.`;
}
