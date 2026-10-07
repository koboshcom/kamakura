/** Preserve verbatim recall only when the current owner explicitly asks for it. */
export function asksForExactHistory(text: string): boolean {
  const request = text.replace(/(?:do not|don't|dont|without|no|never)\s+(?:use\s+)?(?:quotes?|quotations?|backticks?)/gi, '');
  return /\b(?:quote|verbatim|word[ -]for[ -]word|exact\s+(?:full\s+)?(?:words?|text|wording|message)|preserv(?:e|ing)\s+(?:(?:the|its)\s+)?(?:original\s+)?(?:capitalization|punctuation|spelling))\b/i.test(request);
}

/** Delivery-boundary fallback, used only after an actual historical lookup. */
export function cleanHistoryReply(text: string, request: string, recalled: boolean): string {
  if (!recalled || asksForExactHistory(request)) return text;
  return text
    .replace(/```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)\n```/g, '$1')
    .replace(/`+([^`]+)`+/g, '$1')
    .replace(/"([^"\n]+)"/g, '$1')
    .replace(/“([^”\n]+)”/g, '$1')
    .replace(/«([^»\n]+)»/g, '$1')
    .replace(/(^|[\s(])'([^'\n]+)'(?=$|[\s.,!?:;)])/g, '$1$2')
    .replace(/(^|[\s(])‘([^’\n]+)’(?=$|[\s.,!?:;)])/g, '$1$2');
}
