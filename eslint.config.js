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
    // 零依赖 node 测试脚本（.mjs）：用 setTimeout/console/process 等 node 全局
    // 不引入 globals 包（避免新依赖），按 globals.node 子集内联声明
    files: ['src/**/*.mjs'],
    languageOptions: {
      globals: {
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        queueMicrotask: 'readonly',
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        Promise: 'readonly'
      }
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
