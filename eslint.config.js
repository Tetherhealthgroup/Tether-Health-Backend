// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Lint rules, chosen for what has actually gone wrong in this codebase's
 * lineage rather than for taste.
 *
 * `no-floating-promises` is the one that matters most: every request handler
 * here is async, and an un-awaited promise inside one becomes an unhandled
 * rejection, which `@tether/core`'s server treats as fatal and exits on.
 */
export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.d.ts'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // Underscore-prefixed args are the Express `next` a handler must declare
      // to be recognised as error middleware but does not call.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': 'error',
    },
  },
  {
    files: ['**/test/**/*.ts', 'db/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // `node:test` registers a test by calling `test(...)`, which returns a promise
    // the runner owns. Awaiting it would serialise every test in a file and
    // `void`-ing each one would be noise on every line, so the rule that exists
    // for request handlers (above) is off where it can only be a false positive.
    files: ['**/test/**/*.ts'],
    rules: { '@typescript-eslint/no-floating-promises': 'off' },
  },
);
