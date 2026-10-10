/** Remove provider citation artifacts, never ordinary URLs or quoted code. */
export function outgoingText(text: string): string {
  return text.split(/(```[\s\S]*?```|`[^`\n]*`)/g).map((part, index) => index % 2 ? part : part
    .replace(/\uE200cite\uE202[^\uE201]*\uE201/g, '')
    .replace(/\bcite(?:turn\d+(?:search|news|fetch|view)\d+)+\b/g, '')
  ).join('').trim();
}
