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
  },
  {
    // Keep the agent engine's dependency graph Electron-free so it stays portable
    // to non-Electron hosts (the full-screen TUI as its own bundle, a future
    // embeddable SDK) and unit-testable without a running app. Engine code reads
    // settings/secrets via the injected `agentHost` accessor, never `store` /
    // `secrets` (which import electron) or `electron` directly. The two existing
    // host-capability tools that genuinely need Electron at runtime
    // (`viewlocalhost` — offscreen BrowserWindow screenshot; `fileTree` — Finder
    // reveal) carry a documented `eslint-disable` until their capabilities are
    // injected too. Tests mock the boundary, so they're exempt.
    files: [
      'src/main/agent/**/*.ts',
      'src/main/providers/**/*.ts',
      'src/main/mcp/**/*.ts',
      'src/main/sandbox/**/*.ts'
    ],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message:
                'Agent-engine code must not import electron directly — inject host capabilities via ../agentHost so the engine stays portable (TUI/SDK). See agentHost.ts.'
            }
          ],
          patterns: [
            {
              group: ['**/store', '**/secrets'],
              message:
                'Agent-engine code must stay Electron-free: read settings/secrets from ../agentHost, not store/secrets (which import electron). See agentHost.ts.'
            }
          ]
        }
      ]
    }
  }
)
