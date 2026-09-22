import { existsSync, readFileSync } from 'node:fs'
import {
  applyEdits,
  format,
  modify,
  type ParseError,
  parse,
} from 'jsonc-parser'

export function readJsonc<T = unknown>(
  path: string,
): { value: T | null; text: string; exists: boolean } {
  if (!existsSync(path)) {
    return { value: null, text: '', exists: false }
  }
  const text = readFileSync(path, 'utf8')
  const errors: ParseError[] = []
  const value = parse(text, errors, { allowTrailingComma: true })
  return { value: errors.length === 0 ? value : null, text, exists: true }
}

export function updateJsoncArray(
  originalText: string,
  arrayPath: (string | number)[],
  entryToInsertOrUpdate: string,
  matcher: (existing: string) => boolean,
): { text: string; changed: boolean } {
  const parsed = parse(originalText, [], { allowTrailingComma: true }) ?? {}
  let currentArray: unknown = parsed
  for (const segment of arrayPath) {
    if (typeof currentArray === 'object' && currentArray !== null) {
      currentArray = (currentArray as Record<string, unknown>)[segment]
    } else {
      currentArray = undefined
      break
    }
  }

  const list = Array.isArray(currentArray) ? (currentArray as unknown[]) : []
  const existingIndex = list.findIndex(
    (e) => typeof e === 'string' && matcher(e),
  )

  if (existingIndex !== -1 && list[existingIndex] === entryToInsertOrUpdate) {
    return { text: originalText, changed: false }
  }

  let edits: ReturnType<typeof modify>
  if (existingIndex !== -1) {
    edits = modify(
      originalText,
      [...arrayPath, existingIndex],
      entryToInsertOrUpdate,
      {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      },
    )
  } else {
    // If array doesn't exist, create it with one element; otherwise append
    if (!Array.isArray(currentArray)) {
      edits = modify(originalText, arrayPath, [entryToInsertOrUpdate], {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      })
    } else {
      edits = modify(
        originalText,
        [...arrayPath, list.length],
        entryToInsertOrUpdate,
        {
          formattingOptions: { insertSpaces: true, tabSize: 2 },
        },
      )
    }
  }

  const modified = applyEdits(originalText, edits)
  const formatted = applyEdits(
    modified,
    format(modified, undefined, { insertSpaces: true, tabSize: 2 }),
  )
  return { text: formatted, changed: true }
}
