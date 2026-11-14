// Flat config. Lints the TypeScript of the gateway, packages, scripts and tests.
// Ignored on purpose: the dashboard (has its own `tsc` typecheck in its build), plain-JS tooling (k6 scripts, shims, manual checks).
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', '**/node_modules/**', 'apps/dashboard/**', 'load-tests/**', 'tests/manual/**', 'tests/shim/**', '**/*.js', '**/*.mjs', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
      // tsconfig.json covers apps/packages/scripts; tsconfig.test.json covers tests/
      parserOptions: { project: ['./tsconfig.json', './tsconfig.test.json'], tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true, caughtErrors: 'none' }],
      '@typescript-eslint/no-explicit-any': 'error',
      // A forgotten `await` on a promise is a classic source of lost errors/races; intentional fire-and-forget uses `void`.
      '@typescript-eslint/no-floating-promises': 'error',
      // Express accepts async handlers (wrapped by asyncHandler); only the "void-return" check is noise here.
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['warn', { allow: ['error', 'warn'] }],
    },
  },
  {
    // CLI scripts print to the console by design.
    files: ['scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // Tests use non-null assertions and loose typing for HTTP bodies.
    files: ['tests/**/*.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off', 'no-console': 'off' },
  },
);