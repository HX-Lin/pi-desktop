/**
 * Highlighting policy: Prism tokenisation plus the thousands of spans it
 * produces are expensive — a large code block can block the main thread for
 * hundreds of ms and makes window painting feel sluggish. Keep syntax
 * highlighting for normal code; very large blocks render as plain text.
 */
export const MAX_HIGHLIGHT_CODE_BYTES = 12 * 1024;

export function shouldHighlightCode(code: string): boolean {
  return new TextEncoder().encode(code).byteLength <= MAX_HIGHLIGHT_CODE_BYTES;
}
