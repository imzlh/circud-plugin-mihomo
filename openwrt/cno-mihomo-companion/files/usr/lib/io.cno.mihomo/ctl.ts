import {
  ControlError,
  decoder,
  encoder,
  failed,
  isControlVerb,
  MAX_CONTROL_BYTES,
  readStreamLimited,
  rootDirectory,
  runtimePaths,
  writeAll,
  type Envelope,
} from './runtime.ts';

async function main(): Promise<void> {
  const verb = Deno.args[0] ?? '';
  let envelope: Envelope;
  try {
    if (Deno.args.length !== 1 || !isControlVerb(verb)) throw new ControlError('unknown_verb', 'Exactly one supported control verb is required');
    const bytes = await readStreamLimited(Deno.stdin.readable, MAX_CONTROL_BYTES);
    const text = decoder.decode(bytes).trim();
    let input: unknown = {};
    if (text) {
      try { input = JSON.parse(text); } catch { throw new ControlError('invalid_json', 'stdin is not valid JSON'); }
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ControlError('invalid_request', 'stdin JSON must be an object');
    const paths = runtimePaths(rootDirectory());
    const conn = await Deno.connect({ transport: 'unix', path: paths.socket });
    try {
      const body = encoder.encode(JSON.stringify({ version: 1, verb, input }));
      const request = encoder.encode(`POST /v1/control HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${body.byteLength}\r\nConnection: close\r\n\r\n`);
      await writeAll(conn, request);
      await writeAll(conn, body);
      const response = await readConnection(conn, MAX_CONTROL_BYTES + 64 * 1024);
      const split = indexOfSequence(response, encoder.encode('\r\n\r\n'));
      if (split < 0) throw new ControlError('daemon_protocol_error', 'Daemon returned an incomplete HTTP response');
      const head = decoder.decode(response.subarray(0, split));
      if (!/^HTTP\/1\.1 200\b/.test(head)) throw new ControlError('daemon_protocol_error', `Daemon returned ${head.split('\r\n')[0] ?? 'an invalid status'}`);
      const responsePayload = responseBody(head, response.subarray(split + 4));
      try { envelope = JSON.parse(decoder.decode(responsePayload)) as Envelope; }
      catch { throw new ControlError('daemon_protocol_error', 'Daemon returned invalid JSON'); }
      if (!envelope || typeof envelope !== 'object' || typeof envelope.ok !== 'boolean') throw new ControlError('daemon_protocol_error', 'Daemon returned an invalid envelope');
    } finally {
      conn.close();
    }
  } catch (error) {
    envelope = failed(error);
  }
  // A protocol error is still a valid protocol response. Callers must inspect
  // ok; stdout is exactly one JSON document and never contains logs.
  await Deno.stdout.write(encoder.encode(`${JSON.stringify(envelope)}\n`));
}

async function readConnection(conn: Deno.Conn, maximum: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const buffer = new Uint8Array(16 * 1024);
    const count = await conn.read(buffer);
    if (count === null) break;
    total += count;
    if (total > maximum) throw new ControlError('response_too_large', 'Daemon response exceeds the control limit');
    chunks.push(buffer.slice(0, count));
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

function indexOfSequence(value: Uint8Array, sequence: Uint8Array): number {
  outer: for (let index = 0; index <= value.byteLength - sequence.byteLength; index++) {
    for (let offset = 0; offset < sequence.byteLength; offset++) if (value[index + offset] !== sequence[offset]) continue outer;
    return index;
  }
  return -1;
}

function responseBody(head: string, wireBody: Uint8Array): Uint8Array {
  const headers = new Map<string, string>();
  for (const line of head.split('\r\n').slice(1)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }
  const transferEncoding = headers.get('transfer-encoding')?.toLowerCase();
  if (transferEncoding) {
    if (transferEncoding !== 'chunked') throw new ControlError('daemon_protocol_error', 'Daemon returned an unsupported transfer encoding');
    if (headers.has('content-length')) throw new ControlError('daemon_protocol_error', 'Daemon returned conflicting body framing');
    return decodeChunked(wireBody);
  }
  const lengthHeader = headers.get('content-length');
  if (lengthHeader === undefined) return wireBody;
  if (!/^\d+$/.test(lengthHeader)) throw new ControlError('daemon_protocol_error', 'Daemon returned an invalid Content-Length');
  const length = Number(lengthHeader);
  if (!Number.isSafeInteger(length) || length > MAX_CONTROL_BYTES) throw new ControlError('response_too_large', 'Daemon response exceeds the control limit');
  if (wireBody.byteLength !== length) throw new ControlError('daemon_protocol_error', 'Daemon returned a truncated or oversized body');
  return wireBody;
}

function decodeChunked(wire: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let total = 0;
  for (;;) {
    const lineEnd = indexOfSequence(wire.subarray(offset), encoder.encode('\r\n'));
    if (lineEnd < 0) throw new ControlError('daemon_protocol_error', 'Daemon returned incomplete chunk framing');
    const sizeText = decoder.decode(wire.subarray(offset, offset + lineEnd)).split(';', 1)[0]!.trim();
    if (!/^[0-9a-f]+$/i.test(sizeText)) throw new ControlError('daemon_protocol_error', 'Daemon returned an invalid chunk size');
    const size = Number.parseInt(sizeText, 16);
    offset += lineEnd + 2;
    if (size === 0) {
      // A bare CRLF or a bounded trailer block may follow the terminal chunk.
      const trailer = decoder.decode(wire.subarray(offset));
      if (trailer !== '\r\n' && !trailer.endsWith('\r\n\r\n')) throw new ControlError('daemon_protocol_error', 'Daemon returned invalid chunk trailers');
      break;
    }
    total += size;
    if (total > MAX_CONTROL_BYTES) throw new ControlError('response_too_large', 'Daemon response exceeds the control limit');
    if (offset + size + 2 > wire.byteLength || wire[offset + size] !== 13 || wire[offset + size + 1] !== 10) {
      throw new ControlError('daemon_protocol_error', 'Daemon returned a truncated chunk');
    }
    chunks.push(wire.slice(offset, offset + size));
    offset += size + 2;
  }
  const body = new Uint8Array(total);
  let outputOffset = 0;
  for (const chunk of chunks) { body.set(chunk, outputOffset); outputOffset += chunk.byteLength; }
  return body;
}

if (import.meta.main) void main();
