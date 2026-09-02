# Claude Fable 5.1 support research

Date: 2026-09-02

## Sources

Primary documentation:

- [Claude Fable and Mythos 5.1 announcement](https://www.anthropic.com/claude-fable-and-mythos-5-1)
- [Claude Fable 5.1 model overview](https://platform.claude.com/docs/en/models/fable-5-1/overview)
- [What's new in Claude Fable 5.1](https://platform.claude.com/docs/en/models/fable-5-1/whats-new-fable-5-1)
- [Migrating to Claude Fable 5.1](https://platform.claude.com/docs/en/about-claude/models/migration-guide)
- [Effort](https://platform.claude.com/docs/en/build-with-claude/effort)

Implementation inputs:

- PR #179 (`aa699961`): model catalogue, pricing, transforms, routing, recovery, and Pi catalogue support
- PR #180 (`bc188e7e`): Claude Code identity/CCH updates and Fable 5.1 thinking-block controls
- Live Claude Code 2.1.258 HTTPS captures from single-turn, multi-turn, and tool-enabled Fable 5.1 sessions

Capture artifacts remain local under `/tmp`; this document records only redacted findings.

## Verified public contract

| Property | Value |
| --- | --- |
| Claude API ID | `claude-fable-5-1` |
| Mythos invitation-only ID | `claude-mythos-5-1` |
| Released | 2026-09-01 |
| Context window | 1,000,000 tokens |
| Maximum output | 128,000 tokens |
| Thinking | Adaptive, always on |
| Default effort | `high` |
| Supported efforts | `low`, `medium`, `high`, `xhigh`, `max` |
| Input | $10 / MTok |
| Output | $50 / MTok |
| 5-minute cache write | $12.50 / MTok |
| 1-hour cache write | $20 / MTok |
| Cache read | $0.25 / MTok |
| Knowledge/training cutoff | June 2026 |

Additional migration constraints:

- Forced tool choice (`any` or a specific tool) is not supported.
- Prefilled assistant responses are not supported.
- Temperature and top-p cannot both be set.
- Fable 5.1 validates replayed thinking blocks against the exact conversation prefix that produced their signatures. Anthropic's `thinking-binding-controls-2026-08-01` beta and `thinking.block_binding.prefix_mismatch_behavior = "drop_block"` allow a client that intentionally rewrites history to discard mismatched thinking blocks instead of failing the request.
- Anthropic documents this prefix check as a Fable 5.1 behavior; it does not affect Mythos 5.1.
- New API accounts default to mismatch errors. Existing accounts are temporarily warning-only before the stricter default is applied. CortexKit therefore exposes `thinkingBinding.prefixMismatchBehavior` with `account-default`, `error`, and `drop_block` values instead of assuming one account-wide default.

## Verified Claude Code 2.1.258 wire contract

Interactive Fable 5.1 requests used:

- `model: "claude-fable-5-1"`
- `thinking: { type: "adaptive", display: "updates" }` for the interactive summarized-updates UI
- `output_config.effort`
- `fallbacks: "default"`
- `User-Agent: claude-cli/2.1.258 (external, cli)`
- Stainless package version `0.112.1` and runtime `v26.3.0`
- Existing Claude Code full-agent beta selection plus server-side fallback and fallback-credit betas

CortexKit should continue using `display: "summarized"`: OpenCode and Pi consume ordinary summarized thinking deltas and do not implement Claude Code's private summarized-updates UI path.

Claude Code only sends thinking-binding controls when replaying thinking signatures that need the control. A first-turn Fable 5.1 capture with no prior signed thinking contained neither the binding beta nor `thinking.block_binding`.

The `cch` body signature from PR #180 matches both captured request bodies exactly. The proposed three-hex-digit `cc_version` suffix calculation also matches when given the visible user prompt, but PR #180 extracts the first text block. In the captured request, Claude Code prepended two `<system-reminder>` blocks and derived suffix `97a` from the final visible user text block. PR #180 derived `4fa` from the first reminder block. The extractor must prioritize command blocks and otherwise use the final non-empty text block in the first user message.

## Live binding-control validation

A direct OAuth probe against Fable 5.1 generated a signed thinking block, replayed it after deliberately changing the preceding user prefix, and compared the binding behaviors:

- `prefix_mismatch_behavior: "error"` returned HTTP 400 `invalid_request_error`: the thinking block was bound to a different conversation.
- `prefix_mismatch_behavior: "drop_block"` returned HTTP 200 and completed normally with new thinking and text blocks.

This proves the shared control covers the actual Pi/OpenCode compaction failure mode rather than only satisfying a request-schema test.

## Live mid-conversation effort validation

A three-turn OAuth Fable 5.1 probe changed effort with empty system messages carrying `output_config.effort` under beta `mid-conversation-output-config-2026-07-01`. The request kept top-level effort anchored to the first retained turn. Anthropic read the full 6,378-token cached prefix after the effort change, confirming that the marker changes reasoning effort without rewriting the cache prefix. Reasoning effort was not present in the system prompt.

CortexKit now includes the mid-conversation beta on every OAuth Fable 5.1 request so the beta set itself remains stable across a session. OpenCode derives changes from per-user model variants; Pi derives them from `thinking_level_change` entries. Both fold the current effort into a newly compacted prefix and begin a fresh transition timeline. Mythos 5.1, older models, and API-key routes remain outside this behavior.

## PR assessment

### PR #179

Correct coverage:

- Adds Fable 5.1 and Mythos 5.1 to shared and Pi/OpenCode model catalogues.
- Uses the documented pricing, context, output, adaptive-thinking, and effort behavior.
- Extends model-aware quota, sticky routing, server fallback, deterministic recovery, cache warming, and sidebar naming to Fable 5.1.
- Correctly excludes Mythos 5.1 from server-side safety fallback eligibility.

Required correction:

- `CLAUDE_FABLE_MYTHOS_5_RELEASE_DATE` remains `2026-06-09` and is assigned to every generated model. The official Fable 5.1 release date and live Models API `created_at` are `2026-09-01`. Release metadata must be model-specific.

### PR #180

Correct coverage:

- Correct full-body `cch` signing against live Claude Code 2.1.258 request bytes.
- Adds the Fable 5.1 thinking-binding request control and beta on the OpenCode OAuth path.
- Updates Claude Code identity headers and beta selection substantially toward the current wire shape.

Required corrections:

1. Update identity constants and fixtures from Claude Code 2.1.257 to the current published/captured 2.1.258.
2. Extract the visible final user text block for the `cc_version` suffix instead of the first prepended reminder block.
3. Apply thinking-binding controls only when replayed signed/redacted thinking exists. The current implementation adds the beta and body field on first turns where Claude Code does not.
4. Put thinking-binding detection/application in the shared core and use it from both OpenCode and Pi. Pi compaction replaces old history with a generated summary while retaining recent same-model assistant messages; `convertMessages()` currently replays their signatures. Without `drop_block`, Fable 5.1 can reject the first post-compaction request.
5. Preserve the original first-user suffix input in a bounded process-local Pi session tracker as OpenCode already does. Pi compaction otherwise changes the first message and therefore changes the supposed session-stable Claude Code suffix.

## Integration recommendation

Do not merge either PR independently. They conflict in `packages/core/src/models.ts`, and shipping #179 without the shared binding control leaves Pi's compaction path incomplete.

Use one reconciled integration:

1. Keep PR #179's model catalogue/routing/recovery work.
2. Keep PR #180's corrected `cch` implementation and identity work, updated to 2.1.258.
3. Add model-specific release dates.
4. Centralize thinking-binding eligibility and application in core; enable it for OAuth Fable 5.1 only when prior replayable thinking exists; add the beta based on the resulting body shape.
5. Use the shared behavior in OpenCode direct/relay/CacheKeep paths and Pi direct/relay/CacheKeep paths while leaving custom API-key routes unchanged.
6. Add direct regressions for first-turn no-op behavior, post-compaction signed-thinking behavior, Pi header propagation, suffix extraction with prepended reminders, and session-stable Pi suffixes.
7. Validate the combined implementation against the captured 2.1.258 bodies, package unit suites, OpenCode E2E, and packed TUI smoke tests before merge or release.
