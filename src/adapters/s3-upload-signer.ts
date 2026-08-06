import type { S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import type { SignedUpload, UploadRequest, UploadSigner } from '../application/ports';

/**
 * Presigned POST rather than presigned PUT: a POST policy lets S3 enforce
 * `content-length-range`, an exact key and an exact Content-Type. A presigned PUT
 * cannot bound the body size, so a client could upload 5 GB to a "10 MB" URL.
 */
export class S3UploadSigner implements UploadSigner {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
  ) {}

  async sign(request: UploadRequest): Promise<SignedUpload> {
    const { url, fields } = await createPresignedPost(this.s3, {
      Bucket: this.bucket,
      Key: request.key,
      Expires: request.ttlSeconds,
      Fields: {
        'Content-Type': request.contentType,
      },
      Conditions: [
        ['content-length-range', 1, request.maxBytes],
        ['eq', '$Content-Type', request.contentType],
        // The key condition is added by createPresignedPost from `Key` (exact match).
      ],
    });
    return { url, fields };
  }
}
