import { readSSEData } from '../../packages/providers/src/sseParser';

const streamOf = (parts: Array<string | Uint8Array>): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({ start(c) { const e = new TextEncoder(); parts.forEach((p) => c.enqueue(typeof p === 'string' ? e.encode(p) : p)); c.close(); } });
const collect = async (rs: ReadableStream<Uint8Array>): Promise<string[]> => { const out: string[] = []; for await (const d of readSSEData(rs)) out.push(d); return out; };

describe('readSSEData', () => {
  it('parses events split across arbitrary chunk boundaries and CRLF', async () => {
    expect(await collect(streamOf(['da', 'ta: {"a":1}\r\n\r', '\n: keep-alive\n\ndata: x\ndata: y\n\n', 'data: [DONE]\n\n']))).toEqual(['{"a":1}', 'x\ny', '[DONE]']);
  });
  it('handles a multibyte character split across chunks and a final event without a blank line', async () => {
    const bytes = new TextEncoder().encode('data: héllo\n\ndata: tail');
    expect(await collect(streamOf([bytes.slice(0, 9), bytes.slice(9)]))).toEqual(['héllo', 'tail']);
  });
  it('ignores non-data fields', async () => {
    expect(await collect(streamOf(['event: ping\nid: 7\nretry: 100\ndata: ok\n\n']))).toEqual(['ok']);
  });
  it('rejects an oversized line instead of buffering forever', async () => {
    await expect(collect(streamOf(['data: ' + 'a'.repeat(1_100_000)]))).rejects.toMatchObject({ kind: 'malformed_response' });
  });
});
