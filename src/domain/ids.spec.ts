import { uuidv7 } from './ids';
import { parseDocumentId } from './tenant';

describe('uuidv7', () => {
  it('produces valid version 7 UUIDs', () => {
    const id = uuidv7();
    expect(() => parseDocumentId(id)).not.toThrow();
    expect(id[14]).toBe('7');
  });

  it('encodes the timestamp in the first 48 bits so ids sort by creation time', () => {
    const t = Date.parse('2026-08-08T10:00:00Z');
    const earlier = uuidv7(t);
    const later = uuidv7(t + 1);
    expect(earlier.replace(/-/g, '').slice(0, 12)).toBe(t.toString(16).padStart(12, '0'));
    expect(earlier < later).toBe(true);
  });
});
