# SCRIPTS KNOWLEDGE BASE

## OVERVIEW
Repository lifecycle, Arcus v2 packaging, fork synchronization, and local development scripts.

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Setup & Bootstrap | `scripts/setup.sh` | Toolchain check, Arcus submodule initialization, symlink repair, and dependency installation |
| Arcus v2 Pipeline Dispatcher | `scripts/arcus-pipeline.sh` | Unified lifecycle runner (`pack`, `sign`, `validate`, `publish`, `migrate`, `self-test`) symlinked to Arcus submodule |
| Arcus v2 Release Packaging | `scripts/pack-arcus.sh` | Staged OpenCode plugin payload, dual-window envelope generation, sequence auto-allocation, distinct digest triple |
| Arcus v2 Signing / Migration | `scripts/sign-arcus.sh`, `scripts/migrate-arcus.sh` | Ed25519 envelope signing and legacy v1 manifest migration (symlinked to Arcus submodule) |
| Arcus v2 Validation | `scripts/validate-arcus.sh` | Strict fail-closed envelope validation (symlinked to Arcus submodule) |
| Arcus Release Publishing | `scripts/publish-arcus.sh` | GitHub release asset upload & local Arcus manifest synchronization (symlinked to Arcus submodule) |
| Fork Synchronization | `scripts/fork-sync.sh` | Fast-forward or merge synchronization with upstream CortexKit, lockfile reconciliation, and build verification |
| Claustrum Golden Fixture Check | `scripts/check-claustrum-golden.ts` | Asserts local Claustrum tombstone/handles fixtures match byte-pinned hash |
| Local OpenCode Plugin Dev | `scripts/dev.ts`, `scripts/dev-clean.ts` | Builds plugin, symlinks into `.opencode/plugins/`, runs watcher |
| System Prompt Interception | `scripts/capture-with-mitmproxy.sh`, `scripts/extract-system-prompt.ts` | mitmproxy HTTPS flow capture and system prompt extraction |

## CONVENTIONS
- **Upstream Arcus Submodule & Symlinks (Option B)**: Generic Arcus release scripts (`arcus-pipeline.sh`, `sign-arcus.sh`, `validate-arcus.sh`, `publish-arcus.sh`, `migrate-arcus.sh`) are symlinks to `../submodules/arcus/skills/scripts/*` to prevent upstream script drift. `scripts/setup.sh` hydrates `submodules/arcus` on initial clone and repairs symlinks if needed.
- **Project Packaging Driver**: `scripts/pack-arcus.sh` is anthropic-auth's specialized opencode-plugin pack driver that builds workspace packages, stages runtime assets (`dist`, `src/tui.tsx`, `src/tui-compiled`, `src/rpc`), generates dual-window v1/v2 envelopes, and auto-allocates sequences against the local Arcus catalog.
- **Fresh Clone Hydration**: Fresh clones require `bun run setup` (or `bash scripts/setup.sh` / `git clone --recurse-submodules`), which initializes `submodules/arcus`, verifies symlinks, and runs `bun install`.
- **Canonical Arcus Target IDs**: Target matrix is exactly `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `windows-x64`. Legacy `win32-x64` is never emitted.
- **Argv Key Protection**: Key material is never accepted as command-line arguments. Pass keys via `--key-file PATH`, `--key-file -` (stdin), or `--key-env NAME`.

## ANTI-PATTERNS
- **NO Duplicate Script Code**: Never copy or import upstream Arcus pipeline scripts directly into `scripts/`; keep them symlinked to `submodules/arcus/skills/scripts/`.
- **NO Publishing to NPM**: This repository is a personal fork distributed via Arcus (`bun run package:arcus`, `bun run pipeline:arcus`); never run npm publish or restore upstream release scripts.
- **NO Key Material in Command Arguments**: Never pass raw key bytes in `--key` or `--signing-key`.
