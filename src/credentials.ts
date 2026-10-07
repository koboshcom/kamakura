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
const decode = (value:string,query=false):string => {try{return decodeURIComponent(query?value.replace(/\+/g,' '):value);}catch{return value;}};
export function credentialValues(text: string): string[] {
  const urls = [...text.matchAll(/https?:\/\/[^\s<>"'`]+/g)].flatMap(match=>{
    // Preserve raw spellings as well as decoded values. URLSearchParams alone
    // loses the exact encoded spans that must be removed from the original text.
    try{const url=new URL(match[0]);const values:string[]=[];
      if(url.password)values.push(url.password,decode(url.password));
      for(const pair of url.search.slice(1).split('&')){const equals=pair.indexOf('=');if(equals<0)continue;
        if(/token|key|secret|password|credential|signature|auth/i.test(decode(pair.slice(0,equals),true))){const raw=pair.slice(equals+1);if(raw)values.push(raw,decode(raw,true));}}
      return values;
    }catch{return [];}
  });
  return [...new Set([...urls.filter(Boolean),...patterns.flatMap(pattern => [...text.matchAll(pattern)].map(match => match[1] ?? match[0])).filter(value=>value.length>=4)])];
}
export function captureCredentials(text: string): void {
  for (const value of credentialValues(text)) if(value.length>=4)captured.add(value);
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
export function credentialAllowed(text: string, ownerRequest: string): boolean {
  const direct=credentialValues(text);
  const values = [...new Set([...direct,...[...captured].filter(value => text.includes(value))])];
  const authorized=new Set(credentialValues(ownerRequest));
  return values.every(value => ownerRequest.includes(value)||authorized.has(value));
}
// Desktop capability links may be sent to their owner, but must never survive
// history, journals, summaries, embeddings, lessons or log persistence.
export function redactStoredCredentials(text: string): string {
  return redactCredentials(text).replace(/\b[a-f0-9]{64}\b/gi, '[desktop access redacted]');
}
export function hasCredentials(text: string): boolean { return credentialValues(text).length>0 || redactStoredCredentials(text) !== text; }
export function preventCredentialStorage(text: string): void {
  if (hasCredentials(text)) throw new Error('Credentials cannot be stored');
}
