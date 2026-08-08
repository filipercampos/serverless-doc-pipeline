import { randomBytes } from 'node:crypto';

/**
 * UUIDv7 (RFC 9562): 48-bit millisecond timestamp + random bits.
 * Time-ordered ids make the DynamoDB sort key `DOC#<id>` sort by creation time,
 * so "latest documents of a tenant" is a plain Query without a GSI.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  let ts = now;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ts & 0xff;
    ts = Math.floor(ts / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
