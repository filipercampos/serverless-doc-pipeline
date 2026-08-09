import { createHash } from 'node:crypto';
import type { DocumentMetadata, ProcessingResult } from '../domain/document';
import { ContentRejectedError } from '../domain/errors';
import type { SupportedContentType } from '../domain/upload-policy';

/**
 * Extracts metadata from content that already passed sniffing.
 * - Throw {@link ContentRejectedError} for content you understand to be invalid.
 * - Any other error is treated as "unknown" by the processor: retried, then dead-lettered (ADR 0006).
 */
export interface MetadataExtractor {
  extract(bytes: Uint8Array): Promise<DocumentMetadata>;
}

export type MetadataExtractors = Record<SupportedContentType, MetadataExtractor>;

const PDF_MAGIC = Buffer.from('%PDF-', 'ascii');
const UTF8_BOM = [0xef, 0xbb, 0xbf];

/** Decodes strict UTF-8 text; used by the CSV and JSON extractors. */
export function decodeText(bytes: Uint8Array): string {
  const start = UTF8_BOM.every((b, i) => bytes[i] === b) ? 3 : 0;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start));
  } catch {
    throw new ContentRejectedError('content is not valid UTF-8 text');
  }
  if (text.includes('\u0000')) throw new ContentRejectedError('text content contains NUL bytes');
  return text;
}

/**
 * Trust nothing the client declared: the presigned POST pinned the Content-Type header,
 * but not the bytes. Check that the bytes plausibly are what the header says.
 */
export function sniff(contentType: SupportedContentType, bytes: Uint8Array): void {
  if (bytes.length === 0) throw new ContentRejectedError('file is empty');
  if (contentType === 'application/pdf') {
    if (!PDF_MAGIC.equals(Buffer.from(bytes.subarray(0, PDF_MAGIC.length)))) {
      throw new ContentRejectedError('content does not start with a PDF header');
    }
    return;
  }
  decodeText(bytes);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function inspectContent(
  bytes: Uint8Array,
  contentType: SupportedContentType,
  extractors: MetadataExtractors,
): Promise<ProcessingResult> {
  sniff(contentType, bytes);
  const metadata = await extractors[contentType].extract(bytes);
  return { sizeBytes: bytes.length, sha256: sha256Hex(bytes), metadata };
}
