export const OPENCODE_MAIN_OAUTH_REFRESH_LOCK = 'opencode-main-oauth-refresh'

export class CustodyStateMismatchError extends Error {
  readonly code = 'custody_state_mismatch'
  constructor(
    readonly verdict: string,
    readonly dimensions: {
      mode: 'L' | 'C'
      main: 'R' | 'T' | 'X'
      fallbacks: 'R' | 'T' | 'M'
      evidence: 'V' | 'N'
    },
  ) {
    super(`custody state mismatch: ${verdict}`)
  }
  toJSON() {
    return {
      code: this.code,
      verdict: this.verdict,
      dimensions: this.dimensions,
    }
  }
}

/** Only a scoped roster and a non-secret host tombstone can activate custody. */
export function reconcileCustodyStartup(input: {
  mode: 'L' | 'C'
  main: 'R' | 'T' | 'X'
  fallbacks: 'R' | 'T' | 'M'
  evidence: 'V' | 'N'
}): { verdict: 'LOCAL_SERVE' | 'CLAUSTRUM_SERVE' } {
  if (input.mode === 'L' && input.main === 'R' && input.fallbacks === 'R') {
    return { verdict: 'LOCAL_SERVE' }
  }
  if (
    input.mode === 'C' &&
    input.main === 'T' &&
    input.fallbacks === 'T' &&
    input.evidence === 'V'
  ) {
    return { verdict: 'CLAUSTRUM_SERVE' }
  }
  throw new CustodyStateMismatchError('FAIL_CLOSED', input)
}
