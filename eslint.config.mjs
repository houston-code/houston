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
    // to non-Electron hosts (the standalone CLI, the full-screen TUI as its own
    // bundle, a future embeddable SDK) and unit-testable without a running app.
    // Engine code reads settings/secrets via the injected `agentHost` accessor,
    // never `store` / `secrets` (which import electron) or `electron` directly.
    // Host capabilities that genuinely need Electron at runtime live in the shell
    // and are injected (`localhostCapture.ts` → viewlocalhost's capture backend;
    // `openInEditor.ts` → the Files panel's reveal gesture), so this boundary has
    // no exceptions. Tests mock the boundary, so they're exempt.
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
  },
  {
    // The standalone CLI ships as a plain Node bundle — Electron isn't installed
    // where it runs, so nothing under src/cli may import it, directly or via the
    // one shell module that still does (`secrets`, whose safeStorage needs a
    // running desktop app; the CLI's credential source is src/cli/credentials.ts).
    // The build (scripts/build-cli.mjs) also fails if electron reaches the bundle
    // graph transitively; this rule just catches it earlier, in the editor.
    files: ['src/cli/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message:
                'The standalone CLI runs without Electron — wire host capabilities in the entry (see src/cli/index.ts) instead.'
            }
          ],
          patterns: [
            {
              group: ['**/secrets'],
              message:
                'secrets.ts needs Electron safeStorage; the CLI resolves credentials via ./credentials (env-first).'
            }
          ]
        }
      ]
    }
  }
)
