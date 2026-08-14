import { s3NotificationBody } from '../../test/fixtures/sqs-event';
import { MalformedNotificationError, parseS3Notification } from './s3-notification';

describe('parseS3Notification', () => {
  it('decodes URL-encoded keys', () => {
    const [ref] = parseS3Notification(s3NotificationBody('tenants/acme/documents/a b+c.pdf'));
    expect(ref).toMatchObject({ bucket: 'uploads-test', key: 'tenants/acme/documents/a b+c.pdf' });
  });

  it('ignores test events', () => {
    expect(parseS3Notification(JSON.stringify({ Event: 's3:TestEvent' }))).toEqual([]);
  });

  it.each(['nope', '42', '{"foo":1}'])('rejects non-notifications: %s', (raw) => {
    expect(() => parseS3Notification(raw)).toThrow(MalformedNotificationError);
  });
});
