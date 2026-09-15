import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

const bundlePath = join(import.meta.dir, '..', 'dist', 'index.js')
const minBundleBytes = 1024

let size: number
try {
  size = (await stat(bundlePath)).size
} catch {
  throw new Error(`Bundle artifact check failed: ${bundlePath} is missing`)
}

if (size <= minBundleBytes) {
  throw new Error(
    `Bundle artifact check failed: ${bundlePath} is not substantial (${size} bytes)`,
  )
}

const bundle = await readFile(bundlePath, 'utf8')
const registryMatches = bundle.match(/__anthropicAuthRpcServers/g)?.length ?? 0
if (registryMatches === 0) {
  throw new Error(
    'Bundle positive-control check failed: __anthropicAuthRpcServers is absent',
  )
}

// This catches one identifier; the positive control makes its zero assertion meaningful, not proof that no other stale global exists.
const singularMatches =
  bundle.match(/__anthropicAuthRpcServer(?!s)/g)?.length ?? 0
if (singularMatches !== 0) {
  throw new Error(
    `Bundle stale-global check failed: __anthropicAuthRpcServer appears ${singularMatches} time(s)`,
  )
}
