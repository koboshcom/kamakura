/** Conversational prose is never a delivery channel; workers may return results. */
export function finalResultText(text: string, conversational: boolean): string {
  return conversational ? '' : text;
}
