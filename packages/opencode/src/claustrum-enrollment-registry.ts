import {
  adoptClaustrumEnrollment as adoptSharedEnrollment,
  CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
  getHostClaustrumEnrollmentPaths,
} from '@cortexkit/anthropic-auth-core'

export type { ClaustrumEnrollmentAdoption } from '@cortexkit/anthropic-auth-core'

export function getOpenCodeClaustrumEnrollmentPaths(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
) {
  return getHostClaustrumEnrollmentPaths('opencode', env, cwd)
}

export function adoptClaustrumEnrollment(
  options: Omit<Parameters<typeof adoptSharedEnrollment>[0], 'proposedName'>,
) {
  return adoptSharedEnrollment({
    ...options,
    proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
  })
}
