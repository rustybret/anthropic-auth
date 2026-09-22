import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { assertHostsStopped, defaultProcessFence } from './process-fence.ts'
import type { ProcessFence } from './types.ts'

export interface WriteOpenCodeTombstoneOptions {
  authPath: string
  fence?: ProcessFence
  beforeRename?: () => Promise<void>
}

const TOMBSTONE_PAYLOAD = {
  type: 'oauth',
  access: '',
  refresh: 'claustrum-tombstone:v1:anthropic',
  expires: 0,
}

export async function writeOpenCodeTombstoneAuth(
  options: WriteOpenCodeTombstoneOptions,
): Promise<void> {
  const fence = options.fence ?? defaultProcessFence

  // 1. Initial check: verify no hosts are running before reading
  await assertHostsStopped(fence)

  let content: Record<string, unknown> = {}
  let originalRaw: string | null = null

  if (existsSync(options.authPath)) {
    originalRaw = await readFile(options.authPath, 'utf8')
    try {
      content = JSON.parse(originalRaw)
      if (
        typeof content !== 'object' ||
        content === null ||
        Array.isArray(content)
      ) {
        content = {}
      }
    } catch {
      content = {}
    }
  }

  content.anthropic = TOMBSTONE_PAYLOAD
  const serialized = `${JSON.stringify(content, null, 2)}\n`

  const dir = dirname(options.authPath)
  await mkdir(dir, { recursive: true, mode: 0o700 })

  const tmpPath = join(dir, `.auth.${process.pid}.${Date.now()}.tmp`)

  // 2. Write temp file with mode 0600
  await writeFile(tmpPath, serialized, { mode: 0o600 })

  try {
    // 3. Re-verify host quiescence immediately before the atomic rename to prevent
    // an unsynchronized host launch from being clobbered.
    await assertHostsStopped(fence)

    // 4. Also check baseline: if authPath existed before, verify it hasn't changed since read
    if (originalRaw !== null && existsSync(options.authPath)) {
      const currentRaw = await readFile(options.authPath, 'utf8')
      if (currentRaw !== originalRaw) {
        throw new Error(
          'OpenCode auth.json was modified concurrently during setup',
        )
      }
    }

    if (options.beforeRename) {
      await options.beforeRename()
    }

    await rename(tmpPath, options.authPath)
  } catch (error) {
    await unlink(tmpPath).catch(() => {})
    throw error
  }
}
