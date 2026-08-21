import { lambdaContext } from '../../test/fixtures/sqs-event';
import { logger, metrics, observe } from './observability';

describe('observe', () => {
  it('flushes metrics and clears per-invocation log keys on success and on failure', async () => {
    const publish = jest.spyOn(metrics, 'publishStoredMetrics');
    const reset = jest.spyOn(logger, 'resetKeys');
    const append = jest.spyOn(logger, 'appendKeys');

    await expect(
      observe(lambdaContext(), { tenantId: 'acme' }, () => Promise.resolve(1)),
    ).resolves.toBe(1);
    await expect(
      observe(undefined, { tenantId: 'globex' }, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');

    expect(append).toHaveBeenCalledWith({ tenantId: 'acme' });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(reset).toHaveBeenCalledTimes(2);
  });
});
