import { existsSync } from 'node:fs'
import {
  connectClaustrumEnrollmentClient,
  resolveClaustrumConnectionPath,
} from '@cortexkit/anthropic-auth-core'
import { defaultCommandRunner } from './command-runner.ts'
import { readJsonc } from './jsonc.ts'
import { detectOpenCodeConfigFile } from './opencode-config.ts'
import {
  getOpenCodeAuthPath,
  getOpenCodeConfigDir,
  getPiAgentDir,
  OPENCODE_PACKAGE_NAME,
} from './paths.ts'
import { hasPiLocalAnthropicAuth, isPiPackageInstalled } from './pi.ts'
import type {
  ClaustrumDetection,
  CommandRunner,
  HostDetection,
  SetupDetection,
} from './types.ts'

export async function detectOpenCode(
  env: NodeJS.ProcessEnv = process.env,
  runner: CommandRunner = defaultCommandRunner,
): Promise<HostDetection> {
  const versionRes = await runner.run('opencode', ['--version'], { env })
  const hasCli = versionRes.exitCode === 0
  const version = hasCli ? versionRes.stdout.trim() || null : null

  const configDir = getOpenCodeConfigDir(env)
  const { path: configPath, exists: configExists } =
    detectOpenCodeConfigFile(configDir)

  let pluginInstalled = false
  if (configExists) {
    const { value } = readJsonc<{ plugin?: string[] }>(configPath)
    if (Array.isArray(value?.plugin)) {
      pluginInstalled = value.plugin.some(
        (p) =>
          typeof p === 'string' &&
          (p === OPENCODE_PACKAGE_NAME ||
            p.startsWith(`${OPENCODE_PACKAGE_NAME}@`)),
      )
    }
  }

  const installed =
    hasCli || configExists || existsSync(getOpenCodeAuthPath(env))

  return {
    kind: 'opencode',
    installed,
    version,
    configPath,
    pluginInstalled,
  }
}

export async function detectPi(
  env: NodeJS.ProcessEnv = process.env,
  runner: CommandRunner = defaultCommandRunner,
): Promise<HostDetection> {
  const versionRes = await runner.run('pi', ['--version'], { env })
  const hasCli = versionRes.exitCode === 0

  let version: string | null = null
  if (hasCli) {
    const text = versionRes.stdout.trim() || versionRes.stderr.trim()
    const match = text
      .split(/\r?\n/)
      .find((l) => /^\d+\.\d+\.\d+/.test(l.trim()))
    version = match?.trim() ?? text ?? null
  }

  const agentDir = getPiAgentDir(env)
  const installed = hasCli || existsSync(agentDir)
  const pluginInstalled = isPiPackageInstalled(env)
  const hasLocalAuth = await hasPiLocalAnthropicAuth(env)

  return {
    kind: 'pi',
    installed,
    version,
    configPath: agentDir,
    pluginInstalled,
    hasLocalAuth,
  }
}

export async function detectClaustrum(
  env: NodeJS.ProcessEnv = process.env,
  runner: CommandRunner = defaultCommandRunner,
): Promise<ClaustrumDetection> {
  const ckRes = await runner.run('ck', ['--version'], { env })
  const ckInstalled = ckRes.exitCode === 0
  const ckVersion = ckInstalled ? ckRes.stdout.trim() || null : null

  let connectionPath: string | null = null
  let daemonRunning = false

  try {
    connectionPath = resolveClaustrumConnectionPath(undefined, env)
    if (connectionPath && existsSync(connectionPath)) {
      // Prove the daemon is actually running with a real handshake
      const client = await connectClaustrumEnrollmentClient({
        connectionFile: connectionPath,
        handshakeTimeoutMs: 2000,
      })
      daemonRunning = true
      client.close()
    }
  } catch {
    daemonRunning = false
  }

  return {
    ckInstalled,
    ckVersion,
    daemonRunning,
    connectionPath,
  }
}

export async function detectAll(
  env: NodeJS.ProcessEnv = process.env,
  runner: CommandRunner = defaultCommandRunner,
): Promise<SetupDetection> {
  const [opencode, pi, claustrum] = await Promise.all([
    detectOpenCode(env, runner),
    detectPi(env, runner),
    detectClaustrum(env, runner),
  ])

  return { opencode, pi, claustrum }
}
