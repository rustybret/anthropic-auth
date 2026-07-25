# Parity Backlog — improvements to not fall behind openai-auth

Tracking list of improvements surfaced through the **openai-auth ↔ anthropic-auth** design
collaboration (s2s sessions, 2026-06-17 → 2026-06-18). openai-auth was built by copy-and-adapt
from anthropic-auth, then extended past it — these are the items anthropic-auth should adopt or
fix so the *reference* plugin does not fall behind its own descendant.

Status legend: **READY** = latent bug/gap in our tree, fix anytime · **GATED** = backport waiting
on an upstream proof in openai-auth · **PARITY** = feature openai-auth built beyond us.

---

## 1. RPC multi-session keying fix — READY (latent bug, confirmed in our tree; fix proven live in openai-auth)

Two opencode instances on the SAME project share one RPC dir → both TUIs connect to the
newest instance's server → commands in the older instance see `isTuiConnected=false` → modal
falls back to text, no dialog. Single-session never surfaces it.

- Root: `getRpcDir` keys only on `sha256(projectDirectory)` — `packages/opencode/src/rpc/rpc-dir.ts:11-16`;
  `discoverPortFile` returns most-recent live — `packages/opencode/src/rpc/port-file.ts:62-63`.
- **KEY = `process.pid`** (NOT the opencode server port — that was my original guess and openai-auth
  DISPROVED it live, commit c79256d failed): `input.serverUrl` is the `http://localhost:4096` fallback
  for a normal `opencode -s` session (opencode only calls `Server.listen()` for serve/web/acp/--port
  modes), and the TUI's `api.client.getConfig().baseUrl` is synthetic `http://opencode.internal` —
  neither is a real per-instance port. Both plugin halves run in the SAME OS process for `opencode -s`
  (server/RPC in a worker thread, TUI in the main thread) → `process.pid` is shared between them AND
  unique per instance. The port file ALREADY records `pid` (our server writes it at
  `rpc-server.ts:105`; used for `pidAlive`) — no new field needed.
- Fix (3 changes, keep `getRpcDir` directory-hash-based; verified against our tree):
  1. `discoverPortFile(dir, expectedPid?)` — after the existing `pidAlive` live-filter
     (`port-file.ts:49-61`): `const candidates = expectedPid && expectedPid >= 1 ? live.filter(e => e.pid === expectedPid) : []; const entries = candidates.length > 0 ? candidates : live;` then the existing
     most-recent sort on `entries` (`port-file.ts:62-63`). Fallback preserves single-session + remote/--port.
  2. `createRpcClient(dir, expectedPid?)` — thread `expectedPid` into both `call()` sites, pending + apply
     (`rpc-client.ts:40-54`, `call` at `:12-17`).
  3. TUI half: `createRpcClient(getRpcDir(api.state.path.directory ?? ''), process.pid)` (`tui.tsx:773`).
     Server half already writes `process.pid` — leave it. [DONE on feat/parity, commit 56039c1]
- TWO GOTCHAS (cost openai-auth cycles — apply to our backport):
  - NEVER `console.error`/`console.log` in the TUI bundle or RPC path — it writes to the terminal
    opencode draws on and CORRUPTS the TUI render. Route diagnostics through the file logger.
  - The TUI bundle is a SEPARATE module instance from the server-half loader, so a persisted
    `setLogLevel` in the loader does NOT raise the TUI's logger level — force it with an env override
    on launch to see TUI-side debug lines live.
- VERIFY (live, don't skip): launch session1 → drive a turn (writes its port file) → launch session2
  (newer port file) → open a modal in session1. Fixed → TUI logs `myPid===matchedPortFilePid` and the
  modal OPENS in session1 despite session2 being newer.
- Shared with openai-auth (same verbatim rpc/ code) — fix proven live there (commits 1c44c95 + a5267f3).
  Memory #410.

## 2. Duck-typed `ProviderHttpError { status?, retryAfter? }` error contract — GATED

The latent shared-core blocker: replace `instanceof ClaudeOAuthRefreshError` / message-regex error
checks with duck-typing on `error?.status` so the error contract is provider-agnostic at extraction.

- 4 predicate sites in `packages/core/src/accounts.ts`: `isTransientRefreshError` (~1049),
  `isTransientQuotaError` (~1127), `buildRefreshOperationError` (~1064), `recordQuotaRefreshError`
  (~1517) — the 4th was caught in the seam review (was missed in the original 3-site count).
- Producer side: attach `.status` to the throw in `fetchOAuthQuotaSnapshot` (~1450) — today it
  throws a plain Error.
- GATE STATUS (2026-06-18, from openai-auth): PARTIALLY satisfied — contract built, unit-proven, and
  `.status`-capture seen live on the cacheKeep HTTP-400 path; but NO forced real 401/429 (hard to force
  an OpenAI rate-limit on demand). So the original "prove against real 401/429" gate is NOT fully met.
  → OPERATOR DECISION pending: ungate on the partial proof (contract + unit + live-400 status-capture),
  or hold for a natural rate-limit. Then gate the backport with full test suite + backup tag (memory #210).
- Error-decoupling ONLY — do NOT make the refresh/quota fns constructor-injectable on our side until
  the shared package exists (one provider = no present benefit). Memory #399, #387.

## 3. Leveled, redacting, rotating logger — READY (proven live in openai-auth 2026-06-18)

Our `packages/core/src/logger.ts` is the **negative reference**: all-or-nothing, no levels, no
verbosity knob, no secret redaction at the sink (redaction lives only in the `dump` path).

- Target (built + proven live in openai-auth): levels (error/warn/info/debug/trace) + `setLogLevel`
  runtime knob orthogonal to dump + sink-side token/secret redaction + namespaced file + 3-level
  size rotation (5MB×3) + env override for log level (`OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL`). Never
  logs request/response bodies. Ungated: logger is proven live on openai-auth (hot-path logging +
  persisted log-level on real traffic); no forced-429 dependency (that's only item #2's concern).
- **SHARED LEVELING CONVENTION (adopt verbatim so `run at info` means the same on both plugins):**
  - clean session at default `info` = NEAR-SILENT.
  - routine per-operation / lifecycle (refresh lifecycle, cacheKeep started/stopped/fired/skip) = **DEBUG**.
  - per-request FIREHOSE (every-request capture-decision / header log) = **TRACE**.
  - best-effort / non-fatal failures (failed cacheKeep WARM, fallback background-refresh failure) =
    **WARN** — NOT error (error is reserved for genuine breakage).
  - user-initiated SETTING CHANGES = **INFO** (notable, infrequent) — emit an info log on every mutation:
    account add/switch/remove/reorder, routing mode change, killswitch on/off/thresholds, dump on/off,
    log-level change, cacheKeep on/off + subagents on/off. **Values only** (ids/labels/mode/level/
    booleans) — NEVER tokens or bodies. (This INFO-on-mutation work spans item #5's commands too.)
- Still gate the backport with full test suite + backup tag (memory #210).
- **SHARED LOG SCHEMA (agreed with openai-auth — build identical so logs parse the same on both):**
  - Line: `[<ISO8601-UTC>] <LEVEL> [<channel>] <message> <payload-json?>` — one line, payload omitted
    when none, buffered + flushed, never throws.
  - Channels (canonical shared set, LOCKED): `auth · refresh · transport · quota · accounts · cachekeep ·
    commands · rpc · rpc-tui · dump · sidebar`. anthropic-only EXTRA channels: `cache` (1h modes),
    `fast`, `relay`. (`sidebar` is shared: best-effort sidebar-state-write failures log WARN under
    `[sidebar]`, never swallowed.)
  - Setting-change mapping: a user SETTING CHANGE → INFO under `commands` (the mutation); the feature's
    OPERATIONAL behavior → its own channel at debug/trace. (e.g. `[commands] routing mode changed` INFO
    vs `[accounts]` route-selection debug.)
  - Payload: structured JSON object (never interpolate values into the message); message = short
    lowercase noun-phrase; ALWAYS include `pid` (multi-process attribution — instances share one file);
    standard keys accountId/sessionKey/status/mode/level/error. NEVER log tokens, auth/cookie header
    VALUES, or bodies.
  - Redaction (recursive over payload), LOCKED matcher (adopt verbatim so both plugins match) — value
    patterns (Bearer…/sk-…/eyJ… JWT) → ***REDACTED*** AND this key test:
    ```
    const SECRET_KEY_EXACT = /^(authorization|x-api-key|cookie|set-cookie|refresh|access|token)$/i
    function isSecretKey(key) {
      if (SECRET_KEY_EXACT.test(key)) return true           // access/refresh/token anchored → lastAccessAt safe
      const k = key.toLowerCase().replace(/[-_]/g, '')      // normalize camel/snake/kebab
      if (k.includes('apikey')) return true                 // apiKey, api_key, x-api-key
      if (k.endsWith('secret') || k.endsWith('password')) return true   // clientSecret
      if (k.endsWith('token') && !k.endsWith('tokens')) return true     // accessToken YES; input_tokens/cached_tokens NO
      return false
    }
    ```
    Redacts accessToken/refreshToken/bearerToken/relayToken/apiKey/clientSecret; KEEPS sessionKey,
    cacheKey, lastAccessAt, accountId, input_tokens, cached_tokens, output_tokens, status, mode, level,
    pid. The `!endsWith('tokens')` guard is load-bearing — it protects the cacheKeep cost-log counts
    (item #4). Value-pattern net stays for hex-secret-under-innocent-key (but: never log a raw token —
    log a boolean/length). EXTRACT one shared redaction fn used by BOTH the logger sink AND dump.ts's
    redactForDump (single source of truth, no drift).
  - File: `tmpdir()/opencode-anthropic-auth.log`; rotate at 5MB, keep 3 (.1/.2/.3). Env:
    `OPENCODE_ANTHROPIC_AUTH_LOG_FILE` (path), `OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL` (level). Persisted
    via `logging.level` in the account store; `setLogLevel` at runtime. TUI bundle is a separate module
    instance → loader's setLogLevel does NOT raise the TUI logger; env override sees TUI debug live.

---

## Live verification method (PTY self-drive — from openai-auth, use in build phase)

How to exercise the live request-path end-to-end YOURSELF (pitfall #10: green unit suite ≠ done).
Especially for cacheKeep (item #4/#6) + modals (item #5).

1. Build dist, then launch opencode in a PTY background task on a controlled session:
   `bash({ command: "OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL=debug opencode -s <session_id>", pty:true, background:true })`
   (env override REQUIRED to see TUI-side debug; `-s` resumes a specific session you control).
2. Drive with `bash_write`: prompt string + `{ key: "enter" }` → a REAL turn through the fetch
   override → transport → quota → cacheKeep capture.
3. Watch the pid-tagged log (`tail -F` + grep `<pid>`) — distinguish your fresh build from stale
   processes by pid (instances share the one log file).
4. **DRIVER MODEL = `anthropic/claude-haiku-4-5`** (the anthropic adaptation): cheap Claude that
   ROUTES THROUGH our plugin (so transform/transport/quota/cacheKeep all fire); multi-turn idle
   cacheKeep probes cost ~nothing. NEVER drive with Opus/Sonnet (burns budget on cache-warm probes).
   Set the driven session's model to claude-haiku-4-5 first.
   - cacheKeep: drive MULTIPLE same-session turns (cache only warms within a session), go idle, watch
     the warm fire (~just under the cache TTL). Subagent mode: have the session dispatch a Task →
     produces the `x-parent-session-id` request to verify the capture gate + parent-header replay.
   - RPC modal multi-session: drive session1, launch a NEWER session2, open a modal in session1 →
     verify `myPid===matchedPortFilePid` and the modal opens in session1.
5. GOTCHAS: kill the old PTY before relaunching a new build (else stale-process logs); confirm dist is
   the fresh build (mtime + a pid-tagged 'started' line) before trusting results.

---

## 4. cacheKeep per-warm cost logging — READY (gap in our tree)

`packages/core/src/cachekeep.ts` logs prewarm succeeded/failed/skipped but NOT the token cost of each
keepwarm. A keepwarm is a real API call (cache-read input tokens; moves the quota window).

- Add: read `usage` / `cached_tokens` off the prewarm response and log
  `{ cached_tokens, input_tokens, est_cost }` per warm so the cost is visible, not hidden.
- openai-auth is building this cost telemetry from the start (they have live `cached_tokens`
  instrumentation). Adopt the same. Memory #405.

## 5. Adopt openai-auth's unified interactive-modal surface — PARITY (operator-directed convergence)

Convergence LOCKED 2026-06-18: both plugins implement ONE modal UX = openai-auth's DialogSelect +
in-place-replace + OSC-52 pattern. anthropic-auth adopts it verbatim across ALL command modals, and
ADDS `/claude-account` (no in-plugin account mgmt today — ingestion is CLI-only) + `/claude-logging`
(after logger item #3 lands).

**Reference source (read verbatim at build time, same host):**
`/home/icetea/projects/openai-auth/packages/opencode/src/tui/command-dialogs.tsx`
(`openCommandDialog` + `openAccountDialog`) and `tui.tsx` (rpcClient poll → dispatch + pid-match).

**7 structural notes (cost openai-auth cycles — do not re-derive):**
1. `openCommandDialog(api, payload, apply)` switches on `payload.command`; each branch builds a
   `DialogSelect<string>` via `api.ui.DialogSelect`, `api.ui.dialog.setSize('xlarge')`,
   `api.ui.dialog.replace(() => JSX)`.
2. **Solid reactivity does NOT cross the RPC boundary** — for in-place refresh you MUST manually
   re-read + `dialog.replace`: a local `render(state)` closure does `apply → await rpc → render(newState)`
   so the modal refreshes without closing.
3. account L1→L2: `openAccountDialog` showL1 (main + fallbacks + "Add account…") → onSelect →
   showL2Main/showL2Fallback (Switch / Remove / Move up / Move down / Back).
4. add-flow: showAddFlow → showLabelPrompt → startBrowserAdd/startDeviceAdd →
   showBrowserAuthScreen/showDeviceCodeScreen; `osc52Copy = api.renderer.copyToClipboardOSC52`
   (remote-SSH-safe) + openUrl auto-open.
5. phantom-cell: filter zero-length `<text>` segments or DialogSelect eats a flex cell (memory #61).
6. NO raw key capture — host owns the keyboard; `esc` is host-closed, so add an explicit **Back** row
   in every submenu.
7. `command.execute.before` gates on MODAL_COMMANDS → buildDialogPayload → if `isTuiConnected`
   pushNotification else sendIgnoredMessage → cleanAbort. (We already have this shape.)

- Our modals are ALREADY interactive (DialogSelect/Confirm/Prompt + replace; killswitch is the
  multi-step precedent) — this is an upgrade to their richer L1→L2 + add-flow, not a from-scratch build.
  Memory #402.

## 7. Boot quota seed (sidebar cold-start) — CANDIDATE (openai-auth extra; verify-first)

openai-auth extra: on loader boot, instant-write the sidebar from PERSISTED last-known quota (no
"checking…"), then fire the usage API once in the background to refresh to live numbers; module-guarded
(once-per-process, survives loader re-invocation on re-auth), `void`+`.catch` (non-blocking best-effort),
`respectBackoff=true` (a recent 429 suppresses the reboot refresh so repeated restarts don't hammer usage).
- CAVEAT: our quota is ACTIVE-poll, so we may ALREADY populate the sidebar on boot/first-poll. VERIFY
  whether our sidebar shows empty/"checking…" before the first poll completes. If yes → adopt (we already
  have poll-all + persisted-quota + writeSidebarState; just wire at boot behind a once-guard). If already
  seeded → skip. Evaluate during the cacheKeep/sidebar work.

## 6. cacheKeep UX convergence + subagent mode — PARITY (operator-directed convergence)

Convergence LOCKED 2026-06-18: cacheKeep base UX converges to openai-auth's model — **on/off-persistent
(auto-arms every session until off) + a subagent toggle** — exposed identically in both plugins' modals.
anthropic-auth KEEPS its daily-window `HH-HH` as an OPTIONAL EXTRA row (for the 1-hour extended cache),
not a divergent base UX.

- Add to our cacheKeep: an on/off persistent mode (today we gate on the daily window + hybrid 1h-cache
  mode) and a SUBAGENT-warm mode (theirs: subagents on/off, 30min cap, replays `x-parent-session-id`
  sessions). Today our `track()` gate is `route==='main' && !subagentRequest` (memory #405) — subagent
  mode would extend warming to subagent sessions under a separate cap.
- The TTL/cadence stays provider-specific (our 1h extended cache vs their 5min) — only the UX converges.

---

---

## Build-time pitfalls (from openai-auth's build — each cost real cycles)

Provider-agnostic traps the openai-auth session hit building the same features. Apply when implementing
items 1, 3, 5, 6 above. ✓ = already correct/clean in our tree (verified this session).

**cacheKeep on/off-persistent + subagent (item #6):**
1. **Stale-storage-snapshot (a council Must, bit them twice):** a per-request gate reading a storage
   const captured ONCE at loader init is a NO-OP after a mutation until restart. The new cacheKeep
   `enabled` AND `subagents` flags must each read a LIVE mutable `let` updated by a setter callback
   (mirror our `setCache1hState`/`setDumpEnabled`/`setFastModeEnabled` at index.ts:498-503), NOT
   `storage?.cacheKeep?.subagents`. Add a command test that flips the RUNTIME gate, not just the disk
   round-trip.
2. **Subagent warm must replay the parent-session header:** our subagent signal is `x-parent-session-id`
   (memory #405). It MUST be in the prewarm replay allow-list, or the backend sees a child session with
   no parent → phantom top-level session → corrupted cost attribution. Add the session-id-resolving
   headers too. VERIFY the header is actually injected (see #9) before trusting the subagent gate.
3. **Per-target idle cap keyed on `lastRealRequestAt`; the WARM must NOT bump it** — only a real request
   does, else an abandoned idle session warms forever (quota burn). Subagent cap tighter than main
   (they used 30min vs 1h). `pruneStale` must run BEFORE the warm loop in `tick()` (ours does).
4. ✓ **Manager desync ("captured but never fires"):** self-arming `track()` must call an idempotent
   `start()` guarded on `this.timer` — NOT a `this.started` flag (a desync can leave
   started=true,timer=null → self-arm no-ops). OURS IS CORRECT (cachekeep.ts:276 `if (this.timer) return`,
   track→start at :384). Preserve this if refactoring.
5. **Privacy:** never log conversation/request bodies. Log only the failure-path error envelope +
   non-PII shape (key names, status, token counts); redact token values + auth/cookie header names.
   Applies to the new logger (item #3) + cacheKeep cost logging (item #4).

**Modal pattern adoption (item #5):**
6. ✓ **`console.*` ANYWHERE in the TUI bundle or RPC path CORRUPTS the TUI render** (opencode draws on
   that terminal). Diagnostics → FILE logger only. Our `tui.tsx`/`rpc/*`/`tui/` are clean today — KEEP
   them clean as modal code is added. Grep before shipping.
7. **TUI bundle is a SEPARATE module instance from the server-half loader:** a persisted `setLogLevel`
   in the loader does NOT raise the TUI logger's level — force with an env override
   (`OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL=debug`) to SEE TUI-side debug live. Don't misread
   log-level-suppression as "the code didn't run."
8. **Solid reactivity does NOT cross the RPC boundary:** after `apply()` mutates server state, manually
   re-read the state file + `dialog.replace()` to refresh the modal (the load-bearing modal note).

**Methodology (the meta-pitfalls — most important, match operator doctrine):**
9. **Verify load-bearing integration assumptions EMPIRICALLY before building.** Type-def truth ≠ runtime
   truth (their serverPort RPC fix keyed on `serverUrl.port` which the types declare but runtime gives
   the 4096 fallback for `opencode -s`). Prove from source + a live log line, not a signature.
10. **Green unit suite ≠ done for request-path / live-API / integration features.** All ~8 of their
    cacheKeep/modal bugs lived in entry-point WIRING or live contracts that mocked unit tests can't
    exercise; 300+ passing tests caught none. Live-test the real production path end-to-end; on a live
    failure log the ACTUAL response/error and fix from THAT, never guess. Pid-tag logs for multi-process.
11. ✓ **Cross-process token refresh needs file-lock + lease, not just in-process inflight-promise dedup**
    (two instances refreshing the same token). OURS COVERS THE MAIN PATH (auth.loader
    `acquireRefreshFileLock` + leaseId/Until/TokenHash, index.ts:1329-1357), not just fallbacks. Preserve.

---

## Shared-origin concurrency hardening (from openai-auth PR #7 — cubic AI review + 3-round concurrency council, 2026-06-18)

openai-auth lifted accounts.ts / refresh-file-lock / quota-manager / atomic-write / rpc from our tree,
so its PR #7 review findings very likely apply HERE. VERIFY each against our tree before fixing (don't
blind-apply). Review the fixes with a **gemini-3.1-pro-led concurrency panel** — on PR #7 gemini-3.1-pro
ALONE caught all 8 concurrency musts while M3 + opus both APPROVED; for race/lock/lifecycle code trust
its lone MUST. (This is a per-task routing choice for THIS hardening cycle, not a durable claim.)

HIGH-CONFIDENCE (shared primitives):
1. **[CONFIRMED in our tree] file-lock stale-steal TOCTOU** — `accounts.ts:830-844` `acquireRefreshFileLock`:
   unconditional `rm(lockPath)` + `tryAcquire` on a stale lock → 2 contenders both rm (2nd rm's a winner's
   FRESH lock) + both re-acquire → broken mutual exclusion (double OAuth main-refresh). FIX = wx-guarded
   `.evicting` eviction marker: one evictor (O_EXCL; EEXIST→check marker mtime vs ~5s TTL else yield);
   holding marker, re-read lock — if FRESH return null (never rm a fresh lock), if stale rm it; final wx
   `tryAcquire` is the election. Stress: 8×20 → exactly 1 winner. ALSO `:837` stat-fallback uses
   `Date.now()` not the pluggable `now()` — fix.
2. **[CONFIRMED] atomic-write temp orphan** — `accounts.ts:653-661` `writeJsonAtomic`: `rename` has no
   try/catch → orphaned temp on failure. FIX: wrap rename, `rm(tempPath,{force:true})` on failure, rethrow.
3. **readJsonIfPresent swallows non-ENOENT** (accounts.ts) — JSON-parse/EACCES treated as "missing" → masks
   corruption + clobbers a corrupt store on next write. FIX: only ENOENT→absent; rethrow else; clear
   "store at <path> is corrupt" boot message.
4. **rpc-server.ts oversized-body**: `req.destroy()` then catch writes 500 to the DESTROYED socket. FIX:
   guard write on `!res.headersSent && !res.writableEnded && !res.destroyed`.
5. **rpc-dir.ts env override not absolute** → relative override → two processes compute different dirs →
   RPC/modal breakage. FIX: `resolve(override)`.
6. **OAuth callback server bind**: `listen(PORT)` without host → binds 0.0.0.0 (callback/cancel network-
   reachable). FIX: `listen(PORT, '127.0.0.1')`.
7. **Fire-and-forget `void foo()` without `.catch`** → unhandled rejection. Add `.catch(()=>{})` to every
   one. (Sidebar chain already has it post-086fdf3; audit refresh/quota/others.)

CHECK-IF-APPLIES (structure may differ):
8. quota-manager `refreshMain` dedup NOT token-keyed → a concurrent refresh with a DIFFERENT token joins
   the in-flight promise → wrong-account quota. Fallback path already keys by accountId+fingerprint (the
   asymmetry). FIX: track `inflightMainFp`, join only if fp matches, clear in finally only if still own slot.
9. read-modify-write lock must be held ACROSS the read (not just write) else lost update; AND every
   path accessor (read/write/lock) must honor the OPENCODE_ANTHROPIC_AUTH_* env override identically
   (snapshot once/call) — a writer bypassing the override writes/locks a different file than readers read.
10. quota normalizers: guard `Number.isFinite(used_percent)` before computing remaining — NaN → remaining=NaN
    → `remaining<threshold` always false → SILENTLY bypasses quota/killswitch protection.
11. WS/relay pool keyed by sessionID only → account switch mid-session reuses socket → late frame
    misattributed. (May not apply — check relay pooling.) FIX: add token+account-id discriminator to pool key.

12. **[CONFIRMED in our tree — robustness, not concurrency] TUI crash on malformed sidebar-state file** —
    `sidebar-state.ts:67` is a bare `JSON.parse(raw) as SidebarState` with NO shape validation; `tui.tsx`
    accesses `state().main.quota` (:390,:670), `state().fallbacks.filter` (:377,:529), `state().main.quotaBackedOff`
    (:571), `.refreshBackedOff` (:572), `.quotaBackoffUntil` (:741), `.refreshBackoffUntil` (:749) directly.
    A valid-JSON-but-wrong-shape file (missing `main`, `fallbacks` not an array, old/partial/half-written
    shape) → host TUI crashes (`undefined is not an object`). A plugin must NEVER crash the host on a bad
    state file. FIX (2 parts): (a) `normalizeSidebarState(raw)` in getSidebarState — merge over DEFAULT,
    guarantee `main` is an object w/ quota(null)+killed, `fallbacks` always an array, route/lastUpdated
    defaulted, preserve well-shaped extras, non-object→DEFAULT, keep the parse-error→DEFAULT catch, export
    for tests; (b) optional-chain every tui.tsx state() access (defense-in-depth — TUI bundle reads the file
    independently). Tests: {}, {SENTINEL:true}, {main:{}}, {fallbacks:"x"}, non-object → well-formed no-throw;
    valid round-trips. (Surfaced via openai-auth, whose leak-gate wrote a sentinel to the LIVE default path +
    crashed the operator's TUI — LESSON for OUR live-verify: never write test sentinels to the live default
    path; use the temp-floor override for ALL leak probes.)

Process notes that mattered: cubic-dev-ai (GitHub AI reviewer) was 13/13 valid, 0 false positives (whole-
surface re-scan beats delta-scoped council) — consider running it on our PR too. A green unit suite HID a
production-only regression (env-override bypass) — first-hand DIFF review caught it; tests can't.

---

## 8. Relay response eligibility for quota harvest — DONE

OpenCode harvests genuine upstream headers from both relay transports without a quota side channel.
HTTP delivery is gated on `usedRelay`; WebSocket delivery comes from `response_start` before the
optimistic-response early return. Relay-to-direct fallback invokes only the direct-path harvester,
and synthetic optimistic headers remain ineligible.

## 9. Pi quota-header harvest parity — FOLLOW-UP

Pi uses the distinct `packages/pi/src/stream.ts` response path. Header harvest, served-account
attribution, sidecar persistence, and quota display parity remain out of scope for v1. Port the
OpenCode direct-path behavior without sharing request-path state implicitly, then gate Pi's own
streaming response headers and malformed-header handling.
Relay-header callback wiring is also OpenCode-only; Pi parity remains outstanding.

## Implementation phase (operator directive)

When implementation begins, create a **fresh parity branch off `upstream/main`** — NOT off `dev`,
`main`, or any stale local base. Operator-directed 2026-06-18.

- Remotes: `upstream` = `github.com/cortexkit/anthropic-auth` (canonical), `origin` =
  `github.com/iceteaSA/anthropic-auth` (fork). `dev` is currently ahead of `upstream/main` by 9.
- Exact start: `git fetch upstream && git checkout -b feat/parity upstream/main`
  (branch name `feat/parity` mirrors openai-auth's branch for symmetry; confirm with operator).
- WHY fresh upstream base: branching off an older/diverged base produces silent semantic merge
  breaks even on a clean text-merge (memory #210). Starting from current `upstream/main` avoids it.
- Gate before shipping: full typecheck + build + test suite + backup tag at the pre-ship tip
  (memory #210). READY items can land first; GATED items wait on the operator's ungate decision.
- **SHIP TARGET (operator decision 2026-06-18): a PR from the fork `iceteaSA/anthropic-auth` branch
  `feat/parity` → UPSTREAM `cortexkit/anthropic-auth:main`** — NOT a local `main` merge. Mirrors the
  openai-auth ship path (its feat/parity → cortexkit/openai-auth:main PR). Main agent owns the push +
  PR open.
- These planning docs (`docs/parity-backlog.md`, `docs/feature-catalogue.md`) are currently untracked
  — they live on `feat/parity` now; decide with the operator whether to commit them or keep local.

---

_Provenance: s2s design collaboration with the openai-auth session
(`ses_129cb2270ffe2RShrFfNChkZyh`), 2026-06-17 → 2026-06-18. Items 1 & 4 are latent
bugs/gaps in anthropic-auth's own tree; 2 & 3 are gated backports; 5 is a parity feature._
