import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectTaggingCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { ObjectStore, StoredObject } from '../application/process-document';

export class S3ObjectStore implements ObjectStore {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
  ) {}

  async read(key: string, maxBytes: number, versionId?: string): Promise<StoredObject | null> {
    let res;
    try {
      res = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key, VersionId: versionId }),
      );
    } catch (err) {
      if (err instanceof NoSuchKey) return null;
      throw err;
    }
    const sizeBytes = res.ContentLength ?? 0;
    if (sizeBytes > maxBytes || !res.Body) {
      // Do not buffer oversized bodies: release the socket and report the size only.
      (res.Body as { destroy?: () => void } | undefined)?.destroy?.();
      return { sizeBytes };
    }
    const bytes = await res.Body.transformToByteArray();
    return { sizeBytes: bytes.length, bytes };
  }

  async tag(key: string, status: 'rejected' | 'orphan'): Promise<void> {
    await this.s3.send(
      new PutObjectTaggingCommand({
        Bucket: this.bucket,
        Key: key,
        Tagging: { TagSet: [{ Key: 'pipeline-status', Value: status }] },
      }),
    );
  }
}
