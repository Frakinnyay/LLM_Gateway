import { ProviderError } from './types';

const MAX_LINE_BYTES = 1_048_576; // guard against an upstream that never sends a newline

/**
 * Parses a Server-Sent-Events byte stream and yields each event's `data` payload (multi-line data joined by \n).
 * Handles chunk boundaries splitting lines/UTF-8 sequences, CRLF/LF/CR line endings and `:` comment lines.
 */
export async function* readSSEData(body: ReadableStream<Uint8Array>, provider = 'upstream'): AsyncGenerator<string, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let dataLines: string[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_LINE_BYTES && !/[\r\n]/.test(buffer)) {
        throw new ProviderError(provider, 'malformed_response', 'oversized SSE line');
      }
      for (;;) {
        const m = /\r\n|\n|\r/.exec(buffer);
        if (!m) break;
        // A lone trailing \r might be the first half of \r\n; wait for more bytes.
        if (m[0] === '\r' && m.index + 1 === buffer.length) break;
        const line = buffer.slice(0, m.index);
        buffer = buffer.slice(m.index + m[0].length);
        if (line === '') {
          if (dataLines.length) { yield dataLines.join('\n'); dataLines = []; }
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''));
        } // other fields (event:, id:, retry:) and ':' comments are ignored
      }
    }
    buffer += decoder.decode();
    if (buffer.startsWith('data:')) dataLines.push(buffer.slice(5).replace(/^ /, ''));
    if (dataLines.length) yield dataLines.join('\n');
  } finally {
    reader.releaseLock();
  }
}
