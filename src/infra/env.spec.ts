import { intEnv, optionalEnv, requireEnv } from './env';

describe('env', () => {
  afterEach(() => {
    delete process.env.TEST_VALUE;
  });

  it('returns required values and rejects missing ones', () => {
    process.env.TEST_VALUE = 'x';
    expect(requireEnv('TEST_VALUE')).toBe('x');
    delete process.env.TEST_VALUE;
    expect(() => requireEnv('TEST_VALUE')).toThrow(
      'Missing required environment variable TEST_VALUE',
    );
  });

  it('treats empty strings as absent', () => {
    process.env.TEST_VALUE = '';
    expect(optionalEnv('TEST_VALUE')).toBeUndefined();
  });

  it('parses positive integers with a fallback', () => {
    expect(intEnv('TEST_VALUE', 7)).toBe(7);
    process.env.TEST_VALUE = '42';
    expect(intEnv('TEST_VALUE', 7)).toBe(42);
    process.env.TEST_VALUE = '-1';
    expect(() => intEnv('TEST_VALUE', 7)).toThrow('positive integer');
  });
});
