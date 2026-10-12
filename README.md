# Anthropic Auth — Arcus Fleet Fork

This is `rustybret/anthropic-auth`, a downstream fork of
[`cortexkit/anthropic-auth`](https://github.com/cortexkit/anthropic-auth)
(Claude Pro/Max OAuth for [OpenCode](https://opencode.ai) and
[Pi](https://pi.dev)).

**This README documents only what differs from upstream.** Everything about how
the plugin works — setup, accounts and Claustrum custody, routing, quotas, cache
control, relay, environment variables, request rewriting, troubleshooting — is
documented upstream and is deliberately **not** vendored here, so a sync can
never conflict with it:

| Topic | Canonical (upstream) documentation |
| --- | --- |
| Usage, setup, configuration, commands | [`README.md`](https://github.com/cortexkit/anthropic-auth/blob/main/README.md) |
| OpenCode plugin and CLI | [`packages/opencode/README.md`](https://github.com/cortexkit/anthropic-auth/blob/main/packages/opencode/README.md) |
| Pi extension | [`packages/pi/README.md`](https://github.com/cortexkit/anthropic-auth/blob/main/packages/pi/README.md) |
| Shared core | [`packages/core/README.md`](https://github.com/cortexkit/anthropic-auth/blob/main/packages/core/README.md) |
| Release notes | [`CHANGELOG.md`](https://github.com/cortexkit/anthropic-auth/blob/main/CHANGELOG.md) (upstream) and this repo's [`CHANGELOG.md`](CHANGELOG.md) (fork entries) |

The `packages/*/README.md` files in this repository are byte-identical to
upstream's. Treat the upstream links above as the source of truth when a command
in them mentions `bunx @cortexkit/...` or an npm install — see
[Install](#install-in-the-fleet) for the fork equivalent.

## What differs from upstream

| Dimension | Upstream | This fork |
| --- | --- | --- |
| Distribution | Public npm (`@cortexkit/opencode-anthropic-auth`, `@cortexkit/pi-anthropic-auth`) | **Arcus v3 release envelopes** in `rustybret/arcus`, never npm |
| Release tooling | `scripts/release.sh`, `scripts/wait-release.sh`, `release.yaml` | Purged. Arcus consumer template instead (`packages/arcus/`, `scripts/*-arcus.sh`) |
| Upstream tracking | — | `scripts/fork-sync.sh` (`bun run fork-sync`), driven by `scripts/fork-sync-exclusions` |
| Plugin loading | `@cortexkit/...` in `opencode.json` | Arcus blessed set, or a local `file://` bundle |
| Fleet role | Standalone project | Promoted by `uc-studio` after independent download, digest and hydration checks |

### Behavior changes (code)

These are the only intentional deviations from upstream behavior:

- **Request timeouts on quota and token refresh.** `fetchOAuthQuotaSnapshot`
  (`QUOTA_FETCH_TIMEOUT_MS`) and `refreshClaudeOAuthToken`
  (`TOKEN_REFRESH_TIMEOUT_MS`) abort after 30 s, and `isTransientNetworkError`
  classifies `TimeoutError`/`AbortError` as transient so they retry instead of
  poisoning account state. (`packages/core/src/accounts.ts`, `auth.ts`,
  `network-errors.ts`)
- **Cross-provider tool-call history repair (OpenCode).** When a session that
  used another provider is switched to a Claude model, the outgoing history can
  carry tool IDs or provider-executed tool calls Anthropic rejects
  (`server_tool_use.id` not matching `^srvtoolu_[a-zA-Z0-9_]+$`, or a
  `web_search` use with no `web_search_tool_result`). `rewriteRequestBody` now
  normalizes IDs and keeps `tool_use_id` references paired
  (`normalizeServerToolUseId`, `sanitizeToolUseId`, `normalizeToolCallIds`), and
  `repairServerToolUseBlocks` drops orphaned server tool uses or converts them to
  client `tool_use` when a client result exists.
  (`packages/opencode/src/transform.ts`)
- **Claustrum connection discovery honors `env.TMPDIR`** instead of only
  `os.tmpdir()`. (`packages/core/src/claustrum.ts`)

### Test and tooling adaptations

Kept minimal so merges stay cheap:

- `scripts/check-pi-dist-imports.test.ts` tolerates the purged `release.yaml`.
- Two tests resolve their temp root with `realpath` so they pass on macOS
  (`/var` → `/private/var`): `packages/e2e-tests/tests/opencode-executable.test.ts`
  and `packages/core/src/tests/native-enrollment-authority.test.ts`.
- `packages/opencode/src/tests/provider-error.test.ts` restores one baseline
  environment so FIFO fixture cleanup cannot leak
  `OPENCODE_ANTHROPIC_AUTH_STATE_FILE` into later test files.
- `package.json` adds the Arcus/fork-sync scripts and drops `prepublishOnly`;
  `biome.json` excludes Arcus-managed paths.

## Fresh clone

```bash
git clone https://github.com/rustybret/anthropic-auth.git
cd anthropic-auth
bun run setup
```

`bun run setup` (`scripts/setup.sh`) bootstraps the Arcus publisher toolchain via
`packages/arcus/bootstrap.sh`, repairs the `scripts/*-arcus.sh` symlinks, installs
workspace dependencies, and verifies the build. The Arcus repository is **never**
added as a git submodule.

Toolchain versions are pinned in `mise.toml` (bun, node). Run the test suites
under those versions; newer runtimes can fail upstream tests for reasons that
have nothing to do with a change.

## Install in the fleet

Where upstream says to add `@cortexkit/opencode-anthropic-auth` to your OpenCode
config or run `bunx @cortexkit/opencode-anthropic-auth <command>`:

1. **Arcus (fleet default).** The plugin is declared in
   `arcus-blessed-plugins.json` and installed by the Arcus toolchain.
2. **Local build (`file://`).** Build, then point OpenCode at the bundle:

   ```bash
   bun run build
   ```

   `~/.config/opencode/opencode.json`:

   ```json
   { "plugin": ["file:///<path>/anthropic-auth/packages/opencode/dist/index.js"] }
   ```

   `~/.config/opencode/tui.json`:

   ```json
   { "plugin": ["file:///<path>/anthropic-auth/packages/opencode/src/tui/entry.mjs"] }
   ```

   `bun run dev` watches and rebuilds (`bun run dev:clean` removes its symlink).
   Restart OpenCode after rebuilds and clear its plugin cache with
   `rm -rf ~/.cache/opencode` after plugin-config changes.
3. **Pi.** `pi -e file:///<path>/anthropic-auth/packages/pi`.
4. **Setup wizard and CLI.** Run the built CLI directly instead of `bunx`:
   `node packages/opencode/dist/cli.js setup`. Do not let the wizard add the
   upstream npm package name to this fork's config.

## Verify

```bash
bun run typecheck
bun run test          # core, opencode, pi, scripts
bun run test:e2e
bun run build
bun run test:arcus    # Arcus pipeline self-tests + packaging assertions
```

## Releasing through Arcus

Sequence is the release timeline; version is display-only. Sequences only ever
increase and never reset on an upstream version bump. For a multi-component
suite the shared sequence is `max(all component sequences) + 1`.

```text
dist/<sequence>/<package_id>/<version>/    # one self-contained submission bundle
```

```bash
bun run pack:arcus       # allocate sequence, build, pack 5 targets, sign, validate
arcus publish submit --bundle dist/<sequence>/opencode-anthropic-auth/<version>/ \
  --gateway https://arcus-auth.rustybret.com --wait
arcus publish status <submission_id> --gateway https://arcus-auth.rustybret.com
```

Packing allocates the sequence from the live gateway (`--offline` falls back to a
local Arcus checkout) and asserts distinct archive/content/tree digests per
target. Full process and agent checklist: [`docs/arcus-release-process.md`](docs/arcus-release-process.md);
script inventory and rules: [`scripts/AGENTS.md`](scripts/AGENTS.md).

## Syncing with upstream

```bash
bun run fork-sync
```

Fetches `upstream` and `origin`, fast-forwards if `origin` is ahead, merges
`upstream/main`, resolves standing conflict classes from
`scripts/fork-sync-exclusions`, regenerates `bun.lock`, runs `bun install` and the
workspace build, then pushes. The manifest verbs are:

| Verb | Meaning |
| --- | --- |
| `keep-deleted` | Files this fork removed; stay removed if upstream changes them |
| `keep-ours` | Fork-owned files (this `README.md`); our version always wins |
| `take-theirs` | Upstream's version always wins |
| `regenerate` | Take upstream, rebuild the artifact (`bun.lock`), stage it into the merge |

Because `README.md` is `keep-ours`, upstream README changes never block a sync.
Read them upstream (links above) rather than expecting them here.

Other fork-edited docs (`ARCHITECTURE.md`, `STRUCTURE.md`, `CHANGELOG.md`,
`AGENTS.md`) still merge normally and may need manual reconciliation. Fork-only
changelog entries live under "Fleet Fork Enhancements" in `CHANGELOG.md`.

## Architecture and layout

- [`ARCHITECTURE.md`](ARCHITECTURE.md), [`STRUCTURE.md`](STRUCTURE.md) — design
  and directory map (inherited from upstream, with fork notes).
- [`packages/arcus/`](packages/arcus/README.md) — Arcus consumer template
  (`bootstrap.sh`, `arcus.json`); `toolchain/` is a git-ignored symlink.

## License

MIT
