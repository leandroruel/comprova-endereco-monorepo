import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'

const k6Globals = {
  files: ['load/**/*.js'],
  languageOptions: { globals: { __ENV: 'readonly', __ITER: 'readonly', __VU: 'readonly' } },
  rules: { 'no-undef': 'off' },
}

export default tseslint.config(
  {
    ignores: ['**/node_modules/', '**/dist/', '**/coverage/', '**/.turbo/'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  k6Globals,
)
