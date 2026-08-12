import { PutEventsCommand, type EventBridgeClient } from '@aws-sdk/client-eventbridge';
import {
  EVENT_SOURCE,
  processedDetail,
  rejectedDetail,
  type DocumentProcessedDetail,
  type DocumentRejectedDetail,
} from '../application/events';
import type { DocumentEvents } from '../application/process-document';
import type { Document } from '../domain/document';

export class EventBridgeDocumentEvents implements DocumentEvents {
  constructor(
    private readonly client: EventBridgeClient,
    private readonly busName: string,
  ) {}

  processed(doc: Document): Promise<void> {
    return this.put('DocumentProcessed', processedDetail(doc));
  }

  rejected(doc: Document): Promise<void> {
    return this.put('DocumentRejected', rejectedDetail(doc));
  }

  private async put(
    detailType: string,
    detail: DocumentProcessedDetail | DocumentRejectedDetail,
  ): Promise<void> {
    const res = await this.client.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: this.busName,
            Source: EVENT_SOURCE,
            DetailType: detailType,
            // Lets a rule match on resources without parsing the detail.
            Resources: [`tenant/${detail.tenantId}/document/${detail.documentId}`],
            Detail: JSON.stringify(detail),
          },
        ],
      }),
    );
    // PutEvents reports per-entry failures with HTTP 200; treat them as errors so the record is retried.
    if ((res.FailedEntryCount ?? 0) > 0) {
      const entry = res.Entries?.[0];
      throw new Error(
        `PutEvents failed: ${entry?.ErrorCode ?? 'unknown'} ${entry?.ErrorMessage ?? ''}`,
      );
    }
  }
}
