/**
 * Typed access to Lambda environment variables. Fails fast at cold start
 * (module scope) instead of on the first request that needs a missing value.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

export function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

export function intEnv(name: string, fallback: number): number {
  const raw = optionalEnv(name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, got "${raw}"`);
  }
  return parsed;
}

/** Endpoint override used for LocalStack; undefined in AWS. */
export function awsEndpoint(): string | undefined {
  return optionalEnv('AWS_ENDPOINT_URL');
}
