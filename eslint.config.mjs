import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const typedRules = {
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/no-misused-promises': [
    'error',
    // React event handlers are allowed to be async; the rule still catches
    // promises passed where a void return is used elsewhere.
    { checksVoidReturn: { attributes: false } },
  ],
  // Provider payloads and a few legacy boundaries are deliberately `any`;
  // turning this on would bury the signal from the two promise rules.
  '@typescript-eslint/no-explicit-any': 'off',
  '@typescript-eslint/no-unused-vars': [
    'error',
    {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      ignoreRestSiblings: true,
    },
  ],
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'apps/server/src/generated/**',
      'packages/types/src/openapi.ts',
      'apps/mobile/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/server/**/*.ts'],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        project: ['./apps/server/tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: typedRules,
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        project: ['./apps/web/tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: typedRules,
  },
  {
    files: ['packages/types/**/*.ts'],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        project: ['./packages/types/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: typedRules,
  },
  {
    files: ['apps/mcp/**/*.ts'],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        project: ['./apps/mcp/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: typedRules,
  },
);
