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
  // The config is plain JavaScript outside every tsconfig, so the type-aware
  // rules cannot resolve its imports and only report noise about itself.
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.d.ts', 'eslint.config.js'] },
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
  // Test code only; production source keeps every rule above.
  //
  // * `require-await`: the in-memory fakes under `test/` implement the same
  //   async interfaces as the Postgres-backed stores, so their methods must
  //   return a Promise but have nothing to wait on.
  // * the `no-unsafe-*` family and `no-explicit-any`: the tests assert on
  //   response bodies read straight off the wire as untyped JSON. Typing each
  //   one would restate the production schemas inside the tests, and a wrong
  //   restatement would pass silently. `no-floating-promises` and
  //   `no-misused-promises` stay on for tests, since a forgotten `await` there
  //   is a test that passes without asserting.
  {
    files: ['**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
);
