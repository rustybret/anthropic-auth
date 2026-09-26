import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { detectClaustrum } from '../setup/detect.ts'
import type { CommandRunner } from '../setup/types.ts'

test('Claustrum detection resolves the supplied environment instead of the host process environment', async () => {
  const root = process.env.OPENCODE_ANTHROPIC_AUTH_TEST_DIR
  if (!root) throw new Error('OpenCode test preload is missing')
  const explicit = join(root, 'isolated-detection-absent.json')
  const env: NodeJS.ProcessEnv = {
    HOME: root,
    XDG_RUNTIME_DIR: join(root, 'isolated-runtime'),
    OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE: explicit,
  }
  const runner = {
    run: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
  } as CommandRunner
  const result = await detectClaustrum(env, runner)
  expect(result.connectionPath).toBe(explicit)
  expect(result.daemonRunning).toBe(false)
})
