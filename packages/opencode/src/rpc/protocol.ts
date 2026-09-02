export const COMMAND_MODAL_NAMES = [
  'claude-account',
  'claude-cache',
  'claude-cachekeep',
  'claude-prime',
  'claude-start',
  'claude-quota',
  'claude-dump',
  'claude-fast',
  'claude-routing',
  'claude-killswitch',
  'claude-logging',
] as const

export type CommandModalName = (typeof COMMAND_MODAL_NAMES)[number]

export interface AccountDialogAccount {
  id: string
  label: string
  role: string
  enabled: boolean
  quotaPercent: number | null
  tierLabel?: string
  claustrumGate: 'on' | 'off' | 'na'
  vaultServed: boolean
}

export interface AccountDialogKnobs {
  accounts: AccountDialogAccount[]
  claustrumDetection: string
  [key: string]: unknown
}

export interface OpenDialogPayload {
  command: CommandModalName
  text: string
  knobs: Record<string, unknown>
}

export interface RpcNotification {
  id: number
  type: 'open-dialog'
  payload: OpenDialogPayload
  sessionId?: string
}

export interface ApplyRequest {
  command: CommandModalName
  arguments: string
  sessionId?: string
}

export interface ApplyResult {
  text: string
  knobs: Record<string, unknown>
}
