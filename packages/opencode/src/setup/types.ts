export type HarnessKind = 'opencode' | 'pi'

export interface HostDetection {
  kind: HarnessKind
  installed: boolean
  version: string | null
  configPath: string
  pluginInstalled: boolean
  hasLocalAuth?: boolean
}

export interface ClaustrumDetection {
  ckInstalled: boolean
  ckVersion: string | null
  daemonRunning: boolean
  connectionPath: string | null
}

export interface SetupDetection {
  opencode: HostDetection
  pi: HostDetection
  claustrum: ClaustrumDetection
}

export interface CommandRunnerResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface CommandRunner {
  run(
    command: string,
    args: string[],
    options?: {
      env?: Record<string, string | undefined>
      timeoutMs?: number
    },
  ): Promise<CommandRunnerResult>
}

export interface ProcessFence {
  listRunningHosts(
    env?: Record<string, string | undefined>,
  ): Promise<Array<{ pid: number; command: string }>>
}
