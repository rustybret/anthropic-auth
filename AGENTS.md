# Agent Notes

## Captured system prompts

The `captures/` directory is for local system-prompt captures from Claude Code and OpenCode via mitmproxy HTTPS interception. Capture artifacts are ignored by git; use them locally to verify proxy transform accuracy and understand what each tool sends to the Anthropic API.

- **Capture traffic**: `./scripts/capture-with-mitmproxy.sh -o <name>.flow -- <command>`
- **Extract prompt**: `bun run extract <name>.flow -o captures/<tool>-v<version>.txt`

## Arcus packaging & distribution

This repository is distributed via Arcus v2. Upstream pipeline scripts are integrated as symlinks to `submodules/arcus/skills/scripts/` (Option B: Git Submodule + Symlinks + setup.sh):

- **Fresh clone bootstrap**: `bun run setup` (or `git clone --recurse-submodules` / `bash scripts/setup.sh`) initializes `submodules/arcus`, repairs script symlinks, installs dependencies, and verifies the workspace build.
- **Packaging pipeline**: `bun run pipeline:arcus` drives the Arcus v2 lifecycle (pack, sign, validate, publish, migrate, self-test).
- **Hermetic pipeline verification**: `bun run test:arcus` runs self-tests across all Arcus pipeline scripts plus integration tests.

See [scripts/AGENTS.md](scripts/AGENTS.md) for full script inventory, conventions, and anti-patterns.

