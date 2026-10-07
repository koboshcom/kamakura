// Credentials stay in live request memory only. Recognizable values and exact captured
// values are stripped at persistence/delivery boundaries, never treated as policy.
const patterns = [
  /\b(?:tskey-[a-z]+-|sk[-_]|gh[pousr]_|github_pat_|xox[baprs]-|AKIA)[A-Za-z0-9_-]{8,}/g,
  /\b\d{7,}:[A-Za-z0-9_-]{20,}/g,
  /\bBearer\s+([^\s'"`]+)/gi,
  /\b(?:password|passwd|api[ _-]?key|auth[ _-]?key|access[ _-]?token|secret|credential|token)\s*(?:[:=]|\bis\b)\s*["'`]?([^\s"'`;,]+)/gi,
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
];
const captured = new Set<string>();
export function credentialValues(text: string): string[] {
  return [...new Set(patterns.flatMap(pattern => [...text.matchAll(pattern)].map(match => match[1] ?? match[0])).filter(value => value.length >= 4))];
}
export function captureCredentials(text: string): void {
  for (const value of credentialValues(text)) captured.add(value);
  // Bounded process memory, no disk. Pattern redaction still applies after eviction.
  while (captured.size > 256) captured.delete(captured.values().next().value!);
}
export function redactCredentials(text: string): string {
  let result = text;
  const values = [...captured, ...credentialValues(text), ...Object.entries(process.env)
    .filter(([key, value]) => /key|token|secret|password|credential/i.test(key) && value && value.length >= 8).map(([, value]) => value!)];
  for (const value of values.sort((a,b) => b.length-a.length)) result = result.split(value).join('[credential redacted]');
  return result;
}
export function hasCredentials(text: string): boolean { return redactCredentials(text) !== text; }
export function preventCredentialStorage(text: string): void {
  if (hasCredentials(text)) throw new Error('Credentials cannot be stored');
}
