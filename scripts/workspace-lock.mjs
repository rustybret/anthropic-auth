import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyEdits, modify, parse } from 'jsonc-parser'

const WORKSPACES = [
  '',
  'packages/core',
  'packages/e2e-tests',
  'packages/opencode',
  'packages/pi',
]
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
]

function readLock(root) {
  const path = join(root, 'bun.lock')
  const text = readFileSync(path, 'utf8')
  const errors = []
  const value = parse(text, errors, { allowTrailingComma: true })
  if (
    errors.length ||
    !value ||
    typeof value !== 'object' ||
    !value.workspaces
  ) {
    throw new Error('Invalid bun.lock workspace metadata')
  }
  return { path, text, value }
}

function readWorkspaceManifest(root, workspace) {
  const path = join(root, workspace, 'package.json')
  const value = JSON.parse(readFileSync(path, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid workspace manifest: ${workspace || '.'}`)
  }
  return value
}

export function workspaceLockErrors(root) {
  const { value } = readLock(root)
  const issues = []
  for (const workspace of WORKSPACES) {
    const label = workspace || '.'
    const expected = readWorkspaceManifest(root, workspace)
    const actual = value.workspaces[workspace]
    if (!actual || typeof actual !== 'object') {
      issues.push(`${label}: workspace missing from bun.lock`)
      continue
    }
    if (expected.version !== actual.version) {
      issues.push(
        `${label}.version: manifest ${expected.version ?? '(absent)'} != lock ${actual.version ?? '(absent)'}`,
      )
    }
    for (const field of DEPENDENCY_FIELDS) {
      const manifestDeps = expected[field] ?? {}
      const lockedDeps = actual[field] ?? {}
      for (const name of new Set([
        ...Object.keys(manifestDeps),
        ...Object.keys(lockedDeps),
      ])) {
        if (manifestDeps[name] !== lockedDeps[name]) {
          issues.push(
            `${label}.${field}.${name}: manifest ${manifestDeps[name] ?? '(absent)'} != lock ${lockedDeps[name] ?? '(absent)'}`,
          )
        }
      }
    }
  }
  return issues
}

export function syncVersionLock(root, version, { dryRun = false } = {}) {
  const { path, value, text: original } = readLock(root)
  let text = original
  const updates = [
    ['packages/core', ['version']],
    ['packages/opencode', ['version']],
    ['packages/pi', ['version']],
    ['packages/opencode', ['dependencies', '@cortexkit/anthropic-auth-core']],
    ['packages/pi', ['dependencies', '@cortexkit/anthropic-auth-core']],
  ]
  const changes = []
  for (const [workspace, fields] of updates) {
    const actual = value.workspaces[workspace]
    if (!actual)
      throw new Error(`Workspace missing from bun.lock: ${workspace}`)
    let current = actual
    for (const field of fields) current = current?.[field]
    if (typeof current !== 'string') {
      throw new Error(
        `Version missing from bun.lock: ${workspace}.${fields.join('.')}`,
      )
    }
    if (current === version) continue
    text = applyEdits(
      text,
      modify(text, ['workspaces', workspace, ...fields], version, {
        formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' },
      }),
    )
    changes.push(`${workspace}.${fields.join('.')}: ${current} → ${version}`)
  }
  if (changes.length && !dryRun) writeFileSync(path, text, 'utf8')
  return changes
}
