/// <reference types="bun-types" />

import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '../../..')
const PLUGIN_ENTRY = join(REPO_ROOT, 'packages/opencode/src/index.ts')

export type IsolatedEnv = {
  configDir: string
  dataDir: string
  cacheDir: string
  workdir: string
}

export type SpawnedOpencode = {
  url: string
  port: number
  env: IsolatedEnv
  kill: () => Promise<void>
  stdout: () => string
  stderr: () => string
}

export type SpawnOptions = {
  anthropicBaseURL: string
  hybridCache?: boolean
  relay?: {
    url: string
    token: string
    transport: 'websocket' | 'http'
  }
  port?: number
}

async function pickFreePort() {
  const server = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = server.port ?? 0
  server.stop(true)
  if (!port) throw new Error('could not allocate free port')
  return port
}

function createIsolatedEnv(): IsolatedEnv {
  const base = join(
    tmpdir(),
    `anthropic-auth-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  const env = {
    configDir: join(base, 'config'),
    dataDir: join(base, 'data'),
    cacheDir: join(base, 'cache'),
    workdir: join(base, 'work'),
  }
  for (const dir of Object.values(env)) mkdirSync(dir, { recursive: true })
  env.workdir = realpathSync(env.workdir)
  writeFileSync(join(env.workdir, 'sample.txt'), 'hello from sample file\n')
  return env
}

function writeConfigs(env: IsolatedEnv, options: SpawnOptions) {
  writeFileSync(
    join(env.configDir, 'opencode.json'),
    JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        plugin: [`file://${PLUGIN_ENTRY}`],
        autoupdate: false,
        compaction: { auto: false, prune: false },
        permission: { read: 'allow', bash: 'allow', edit: 'allow' },
      },
      null,
      2,
    ),
  )

  writeFileSync(
    join(env.configDir, 'anthropic-auth.json'),
    JSON.stringify(
      {
        version: 1,
        main: { type: 'opencode', provider: 'anthropic' },
        accounts: [],
        quota: { enabled: false },
        refresh: { enabled: false },
        ...(options.hybridCache
          ? { claudeCache: { enabled: true, mode: 'hybrid' } }
          : {}),
        ...(options.relay
          ? {
              relay: {
                enabled: true,
                url: options.relay.url,
                token: options.relay.token,
                transport: options.relay.transport,
                fallbackToDirect: false,
              },
            }
          : {}),
      },
      null,
      2,
    ),
  )
}

async function waitForReady(
  url: string,
  getLogs: () => { stdout: string; stderr: string },
  timeoutMs = 60_000,
) {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  let readySince = 0

  while (Date.now() < deadline) {
    const logs = getLogs()
    const combinedLogs = `${logs.stdout}\n${logs.stderr}`
    const migrationStarted = combinedLogs.includes('database migration')
    const migrationDone =
      combinedLogs.includes('Database migration complete') ||
      combinedLogs.includes('sqlite-migration:done')

    try {
      const response = await fetch(`${url}/global/health`, {
        signal: AbortSignal.timeout(2_000),
      })
      const serverAcceptsRequests = response.ok || response.status === 401
      if (serverAcceptsRequests && (!migrationStarted || migrationDone)) {
        readySince ||= Date.now()
        if (Date.now() - readySince >= 1_000) return
      } else {
        readySince = 0
      }
    } catch (error) {
      readySince = 0
      lastError = error
    }
    await Bun.sleep(200)
  }
  throw new Error(`opencode serve did not become ready: ${String(lastError)}`)
}

export async function spawnOpencode(
  options: SpawnOptions,
): Promise<SpawnedOpencode> {
  const env = createIsolatedEnv()
  const port = options.port ?? (await pickFreePort())
  writeConfigs(env, options)

  const childEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value == null) continue
    if (key === 'OPENCODE_SERVER_PASSWORD') continue
    if (key === 'OPENCODE_SERVER_USERNAME') continue
    if (key === 'NODE_ENV') continue
    childEnv[key] = value
  }
  childEnv.OPENCODE_CONFIG_DIR = env.configDir
  childEnv.OPENCODE_ANTHROPIC_AUTH_FILE = join(
    env.configDir,
    'anthropic-auth.json',
  )
  childEnv.XDG_CONFIG_HOME = env.configDir
  childEnv.XDG_DATA_HOME = env.dataDir
  childEnv.XDG_CACHE_HOME = env.cacheDir
  childEnv.OPENCODE_AUTH_CONTENT = JSON.stringify({
    anthropic: {
      type: 'oauth',
      access: 'test-access-token',
      refresh: 'test-refresh-token',
      expires: Date.now() + 60 * 60 * 1000,
    },
  })
  childEnv.ANTHROPIC_BASE_URL = options.anthropicBaseURL
  childEnv.ANTHROPIC_API_KEY = 'test-key-not-real'

  const child: ChildProcess = spawn(
    'opencode',
    ['serve', '--port', String(port), '--hostname', '127.0.0.1'],
    { cwd: env.workdir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] },
  )

  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })

  const url = `http://127.0.0.1:${port}`
  try {
    await waitForReady(url, () => ({ stdout, stderr }))
  } catch (error) {
    child.kill('SIGTERM')
    throw new Error(
      `opencode serve failed to start\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n${String(error)}`,
    )
  }

  return {
    url,
    port,
    env,
    stdout: () => stdout,
    stderr: () => stderr,
    kill: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          resolve()
        }, 3000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    },
  }
}
