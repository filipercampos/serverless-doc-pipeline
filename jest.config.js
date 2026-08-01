/** @type {import('jest').Config} */
const transform = { '^.+\\.ts$': ['ts-jest', { isolatedModules: true }] };
const common = {
  testEnvironment: 'node',
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform,
  setupFiles: ['<rootDir>/test/setup-env.js'],
};

module.exports = {
  projects: [
    { ...common, displayName: 'unit', testMatch: ['<rootDir>/src/**/*.spec.ts'] },
    {
      ...common,
      displayName: 'integration',
      testMatch: ['<rootDir>/test/**/*.int-spec.ts'],
    },
  ],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts'],
};
