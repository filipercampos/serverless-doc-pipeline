// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      '.aws-sam/**',
      'coverage/**',
      'eslint.config.mjs',
      'jest.config.js',
      'test/setup-env.js',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@aws-sdk/*', '@aws-lambda-powertools/*'],
              message: 'domain/ must stay free of AWS dependencies',
            },
          ],
        },
      ],
    },
  },
  {
    // Only the domain and application layers are AWS-free (hexagonal rule).
    files: [
      'src/adapters/**/*.ts',
      'src/handlers/**/*.ts',
      'src/infra/**/*.ts',
      'test/**/*.ts',
      'scripts/**/*.ts',
      'src/**/*.spec.ts',
    ],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    files: ['test/**/*.ts', 'src/**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
);
