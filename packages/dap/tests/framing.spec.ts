import { describe, expect, it } from 'vitest'
import { MessageFramer, encodeDapMessage } from '../src/index.ts'

/** Drain a freshly created framer after pushing chunks; yields parsed JSON bodies. */
function decode(chunks: (Buffer | string)[]): unknown[] {
  const framer = new MessageFramer()
  const seen: unknown[] = []
  for (const chunk of chunks) framer.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk)
  for (const text of framer.drain(() => {})) seen.push(JSON.parse(text) as unknown)
  return seen
}

describe('encodeDapMessage', () => {
  it('wraps a JSON body with a Content-Length header frame', () => {
    const encoded = encodeDapMessage({ seq: 1, type: 'request', command: 'foo', arguments: { x: 1 } })
    const headerEnd = encoded.indexOf(Buffer.from('\r\n\r\n'))
    const header = encoded.subarray(0, headerEnd).toString('utf8')
    const body: unknown = JSON.parse(encoded.subarray(headerEnd + 4).toString('utf8'))
    expect(header).toMatch(/^Content-Length: \d+$/m)
    expect(encoded.subarray(0, headerEnd)).toEqual(
      Buffer.from(`Content-Length: ${Buffer.byteLength(JSON.stringify({ seq: 1, type: 'request', command: 'foo', arguments: { x: 1 } }))}`, 'ascii'),
    )
    expect(body).toEqual({ seq: 1, type: 'request', command: 'foo', arguments: { x: 1 } })
  })
})

describe('MessageFramer', () => {
  it('delivers a single complete frame', () => {
    expect(decode(['Content-Length: 16\r\n\r\n{"type":"event"}'])).toEqual([{ type: 'event' }])
  })

  it('assembles frames split across arbitrary chunk boundaries', () => {
    const msg = { seq: 1, type: 'request', command: 'initialize' }
    const enc = encodeDapMessage(msg)
    const bytes = [...enc]
    const framer = new MessageFramer()
    const seen: unknown[] = []
    for (const byte of bytes) {
      framer.push(Buffer.from([byte]))
      for (const text of framer.drain(() => {})) seen.push(JSON.parse(text) as unknown)
    }
    expect(seen).toEqual([msg])
  })

  it('handles padding before the next frame and retains an incomplete tail', () => {
    const first = encodeDapMessage({ seq: 1, type: 'request', command: 'initialize' })
    const second = encodeDapMessage({ seq: 2, type: 'request', command: 'launch' })
    const head = Buffer.concat([first, Buffer.from('junk-header-without-colon\r\n\r\n'), second.subarray(0, second.length - 4)])
    const framer = new MessageFramer()
    const seen: unknown[] = []
    framer.push(head)
    for (const text of framer.drain(() => {})) seen.push(JSON.parse(text) as unknown)
    // The junk header is dropped (onResync fired), the first frame decoded,
    // and the incomplete second frame stays buffered.
    expect(seen).toEqual([{ seq: 1, type: 'request', command: 'initialize' }])
    framer.push(second.subarray(second.length - 4))
    for (const text of framer.drain(() => {})) seen.push(JSON.parse(text) as unknown)
    expect(seen[1]).toEqual({ seq: 2, type: 'request', command: 'launch' })
  })

  it('tolerates a CRLFCRLF header terminator split across two pushes', () => {
    const framer = new MessageFramer()
    const seen: unknown[] = []
    framer.push(Buffer.from('Content-Length: 11\r\n'))
    framer.push(Buffer.from('\r\n{"ok":true}'))
    for (const text of framer.drain(() => {})) seen.push(JSON.parse(text) as unknown)
    expect(seen).toEqual([{ ok: true }])
  })

  it('waits for a message body that arrives later', () => {
    const framer = new MessageFramer()
    const seen: unknown[] = []
    framer.push(Buffer.from('Content-Length: 16\r\n\r\n{"type":'))
    for (const text of framer.drain(() => {})) seen.push(JSON.parse(text) as unknown)
    expect(seen).toEqual([])
    framer.push(Buffer.from('"event"}'))
    for (const text of framer.drain(() => {})) seen.push(JSON.parse(text) as unknown)
    expect(seen).toEqual([{ type: 'event' }])
  })

  it('exercises remainder() for reader restart resume', () => {
    const framer = new MessageFramer()
    const full = encodeDapMessage({ seq: 9, type: 'response', request_seq: 9, success: true, command: 'x' })
    framer.push(full.subarray(0, full.length - 3))
    expect(Array.from(framer.drain(() => {}))).toEqual([])
    const tail = framer.remainder()
    const restarted = new MessageFramer(tail)
    const seen: unknown[] = []
    restarted.push(full.subarray(full.length - 3))
    for (const text of restarted.drain(() => {})) seen.push(JSON.parse(text) as unknown)
    expect(seen).toEqual([{ seq: 9, type: 'response', request_seq: 9, success: true, command: 'x' }])
  })
})
