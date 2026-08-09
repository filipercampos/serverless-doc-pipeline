import { CsvError, parse } from 'csv-parse/sync';
import { PDFDocument } from 'pdf-lib';
import {
  decodeText,
  type MetadataExtractor,
  type MetadataExtractors,
} from '../application/inspect-content';
import type { DocumentMetadata } from '../domain/document';
import { ContentRejectedError } from '../domain/errors';

const MAX_HEADER_COLUMNS = 50;
const MAX_HEADER_LENGTH = 100;

export const csvExtractor: MetadataExtractor = {
  extract(bytes) {
    let records: string[][];
    try {
      records = parse(decodeText(bytes), {
        skip_empty_lines: true,
        relax_column_count: false,
        max_record_size: 1024 * 1024,
      });
    } catch (err) {
      if (err instanceof CsvError) {
        throw new ContentRejectedError(`malformed CSV: ${err.code}`);
      }
      throw err;
    }
    const header = records[0] ?? [];
    const metadata: DocumentMetadata = {
      kind: 'csv',
      rowCount: Math.max(records.length - 1, 0),
      columnCount: header.length,
      // Header values are tenant data echoed back by the API: bound their size.
      header: header.slice(0, MAX_HEADER_COLUMNS).map((h) => h.slice(0, MAX_HEADER_LENGTH)),
    };
    return Promise.resolve(metadata);
  },
};

export const jsonExtractor: MetadataExtractor = {
  extract(bytes) {
    let value: unknown;
    try {
      value = JSON.parse(decodeText(bytes));
    } catch (err) {
      if (err instanceof SyntaxError) throw new ContentRejectedError('malformed JSON');
      throw err;
    }
    if (Array.isArray(value)) {
      return Promise.resolve({ kind: 'json', topLevelType: 'array', topLevelKeys: value.length });
    }
    if (typeof value === 'object' && value !== null) {
      return Promise.resolve({
        kind: 'json',
        topLevelType: 'object',
        topLevelKeys: Object.keys(value).length,
      });
    }
    throw new ContentRejectedError('JSON document must be an object or an array');
  },
};

const PDF_VERSION = /^%PDF-(\d\.\d)/;

/**
 * pdf-lib parses the cross-reference table and page tree without rendering anything,
 * so embedded JavaScript, fonts and images are never executed or decoded.
 * Parser exceptions are deliberately NOT mapped to rejections: see ADR 0006.
 */
export const pdfExtractor: MetadataExtractor = {
  async extract(bytes) {
    const pdf = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
    });
    const pageCount = pdf.getPageCount();
    if (pageCount === 0) throw new ContentRejectedError('PDF has no pages');
    const header = Buffer.from(bytes.subarray(0, 16)).toString('latin1');
    return {
      kind: 'pdf',
      pageCount,
      pdfVersion: PDF_VERSION.exec(header)?.[1] ?? null,
      encrypted: pdf.isEncrypted,
    };
  },
};

export const defaultExtractors: MetadataExtractors = {
  'application/pdf': pdfExtractor,
  'text/csv': csvExtractor,
  'application/json': jsonExtractor,
};
