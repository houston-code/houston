import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

/**
 * Pragmatic flat config: catch real bugs (unused vars, React hooks misuse,
 * fallthroughs) without fighting the codebase's deliberate `as` casts at the
 * provider/IPC boundaries. Type-aware rules are intentionally off to keep lint
 * fast and free of project-service wiring.
 */
export default tseslint.config(
  { ignores: ['out/**', 'release/**', 'build/**', 'dist/**', 'node_modules/**', 'scripts/**', '*.config.*'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }
      ],
      'no-empty': ['error', { allowEmptyCatch: true }]
    }
  }
)
