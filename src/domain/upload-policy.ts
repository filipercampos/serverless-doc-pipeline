import { ValidationError } from './errors';

export const SUPPORTED_CONTENT_TYPES = ['application/pdf', 'text/csv', 'application/json'] as const;
export type SupportedContentType = (typeof SUPPORTED_CONTENT_TYPES)[number];

export interface UploadPolicy {
  /** Upper bound enforced by S3 itself through the presigned POST `content-length-range`. */
  maxBytes: number;
  /** How long the presigned POST stays valid. */
  urlTtlSeconds: number;
}

export const DEFAULT_UPLOAD_POLICY: UploadPolicy = {
  maxBytes: 10 * 1024 * 1024,
  urlTtlSeconds: 300,
};

export function parseContentType(raw: unknown): SupportedContentType {
  if (typeof raw === 'string') {
    const normalized = raw.split(';')[0]!.trim().toLowerCase();
    if ((SUPPORTED_CONTENT_TYPES as readonly string[]).includes(normalized)) {
      return normalized as SupportedContentType;
    }
  }
  throw new ValidationError(`contentType must be one of ${SUPPORTED_CONTENT_TYPES.join(', ')}`);
}

// Control characters and path separators are rejected rather than stripped: silently changing
// a file name is surprising, and the name is only ever metadata.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_FILE_NAME_CHARS = /[\u0000-\u001f\u007f/\\]/;

export function parseFileName(raw: unknown): string {
  if (typeof raw !== 'string') throw new ValidationError('fileName is required');
  const name = raw.trim();
  if (name.length === 0 || name.length > 255 || FORBIDDEN_FILE_NAME_CHARS.test(name)) {
    throw new ValidationError('fileName must be 1-255 characters without path separators');
  }
  if (name === '.' || name === '..') throw new ValidationError('fileName is invalid');
  return name;
}

export function parseDeclaredSize(raw: unknown, policy: UploadPolicy): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 0) {
    throw new ValidationError('sizeBytes must be a positive integer');
  }
  if (raw > policy.maxBytes) {
    throw new ValidationError(`sizeBytes exceeds the limit of ${policy.maxBytes} bytes`);
  }
  return raw;
}
