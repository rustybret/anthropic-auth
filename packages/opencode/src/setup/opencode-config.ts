import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readJsonc, updateJsoncArray } from './jsonc.ts'
import {
  getOpenCodeConfigDir,
  OPENCODE_PACKAGE_NAME,
  opencodePluginEntry,
  opencodeTuiEntry,
} from './paths.ts'

function isOurPluginEntry(entry: string): boolean {
  return (
    entry === OPENCODE_PACKAGE_NAME ||
    entry.startsWith(`${OPENCODE_PACKAGE_NAME}@`)
  )
}

export function detectOpenCodeConfigFile(configDir: string): {
  path: string
  exists: boolean
} {
  const jsoncPath = join(configDir, 'opencode.jsonc')
  if (existsSync(jsoncPath)) return { path: jsoncPath, exists: true }
  const jsonPath = join(configDir, 'opencode.json')
  if (existsSync(jsonPath)) return { path: jsonPath, exists: true }
  return { path: jsoncPath, exists: false }
}

export function detectOpenCodeTuiConfigFile(configDir: string): {
  path: string
  exists: boolean
} {
  const jsoncPath = join(configDir, 'tui.jsonc')
  if (existsSync(jsoncPath)) return { path: jsoncPath, exists: true }
  const jsonPath = join(configDir, 'tui.json')
  if (existsSync(jsonPath)) return { path: jsonPath, exists: true }
  return { path: jsoncPath, exists: false }
}

export async function ensureOpenCodePluginConfig(
  version: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ configPath: string; changed: boolean; created: boolean }> {
  const configDir = getOpenCodeConfigDir(env)
  await mkdir(configDir, { recursive: true })

  const { path: configPath, exists } = detectOpenCodeConfigFile(configDir)
  const entry = opencodePluginEntry(version)

  if (!exists) {
    const initial = `{\n  "$schema": "https://opencode.ai/config.json",\n  "plugin": [\n    "${entry}"\n  ]\n}\n`
    await writeFile(configPath, initial, 'utf8')
    return { configPath, changed: true, created: true }
  }

  const { text } = readJsonc(configPath)
  const { text: updatedText, changed } = updateJsoncArray(
    text,
    ['plugin'],
    entry,
    isOurPluginEntry,
  )

  if (changed) {
    await writeFile(configPath, updatedText, 'utf8')
  }

  return { configPath, changed, created: false }
}

export async function ensureOpenCodeTuiConfig(
  version: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ configPath: string; changed: boolean; created: boolean }> {
  const configDir = getOpenCodeConfigDir(env)
  await mkdir(configDir, { recursive: true })

  const { path: tuiPath, exists } = detectOpenCodeTuiConfigFile(configDir)
  const entry = opencodeTuiEntry(version)

  if (!exists) {
    const initial = `{\n  "plugin": [\n    "${entry}"\n  ]\n}\n`
    await writeFile(tuiPath, initial, 'utf8')
    return { configPath: tuiPath, changed: true, created: true }
  }

  const { text } = readJsonc(tuiPath)
  const { text: updatedText, changed } = updateJsoncArray(
    text,
    ['plugin'],
    entry,
    isOurPluginEntry,
  )

  if (changed) {
    await writeFile(tuiPath, updatedText, 'utf8')
  }

  return { configPath: tuiPath, changed, created: false }
}
