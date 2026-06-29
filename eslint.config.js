import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/no-this-alias': 'warn',
      'no-empty': 'warn',
      'no-control-regex': 'off',
      'no-useless-assignment': 'off'
    }
  },
  {
    ignores: [
      'dist', 'node_modules', 'out', 'release',
      'build/**', 'scripts/**', 'docs/**',
      '*.config.js', '*.config.cjs'
    ]
  }
);
