import { defaultCommandRunner } from './command-runner.ts'
import type { CommandRunner, ProcessFence } from './types.ts'

const HOST_PATTERN = /(?:^|\/)(opencode|litecode|opencode2|pi)(?:$|\s)/i

export class ProcessFenceViolationError extends Error {
  constructor(readonly activeHosts: Array<{ pid: number; command: string }>) {
    const list = activeHosts
      .map((h) => `  - PID ${h.pid}: ${h.command.slice(0, 80)}`)
      .join('\n')
    super(
      `OpenCode or Pi processes are currently running:\n${list}\n\n` +
        `Please quit all OpenCode, LiteCode, and Pi processes before running setup.`,
    )
    this.name = 'ProcessFenceViolationError'
  }
}

export function createProcessFence(
  runner: CommandRunner = defaultCommandRunner,
): ProcessFence {
  return {
    async listRunningHosts(
      env?: Record<string, string | undefined>,
    ): Promise<Array<{ pid: number; command: string }>> {
      const isWin = process.platform === 'win32'
      const cmd = isWin ? 'tasklist' : 'ps'
      const args = isWin ? ['/fo', 'csv', '/nh'] : ['-eo', 'pid,command']
      const result = await runner.run(cmd, args, { env })

      if (result.exitCode !== 0) {
        throw new Error(
          `Process inspection failed (${result.stderr.trim() || `exit ${result.exitCode}`})`,
        )
      }

      const lines = result.stdout.split(/\r?\n/)
      const running: Array<{ pid: number; command: string }> = []
      const currentPid = process.pid

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        let pid: number
        let command: string

        if (isWin) {
          // CSV format: "Image Name","PID","Session Name","Session#","Mem Usage"
          const parts = trimmed.split(',').map((p) => p.replace(/^"|"$/g, ''))
          if (parts.length < 2) continue
          command = parts[0] ?? ''
          pid = Number(parts[1])
        } else {
          const match = /^(\d+)\s+(.+)$/.exec(trimmed)
          if (!match) continue
          pid = Number(match[1])
          command = match[2] ?? ''
        }

        if (!Number.isInteger(pid) || pid === currentPid) continue
        if (HOST_PATTERN.test(command)) {
          running.push({ pid, command })
        }
      }

      return running
    },
  }
}

export const defaultProcessFence = createProcessFence(defaultCommandRunner)

export async function assertHostsStopped(
  fence: ProcessFence = defaultProcessFence,
): Promise<void> {
  const active = await fence.listRunningHosts()
  if (active.length > 0) {
    throw new ProcessFenceViolationError(active)
  }
}
