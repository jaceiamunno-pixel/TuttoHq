import { defineConfig } from 'vitest/config';

// Minimal config added for the CPM engine slice (ADR-011). The repo previously
// had no test runner; this scopes vitest to src/ unit tests only so it never
// picks up node_modules or .claude/worktrees fixtures.
export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.ts'],
    environment: 'node',
  },
});
