# anthropic-auth — Feature Catalogue (for openai-auth parity consolidation)

Ground-truth inventory of every anthropic-auth feature: what it does, how it works (entry point +
mechanism), and its **provider coupling** (generic plumbing vs Anthropic/Claude-Max-specific).
Built for the bidirectional parity diff with openai-auth (s2s consolidation, 2026-06-18).

Coupling legend: **[G]** generic plumbing (portable as-is) · **[A]** Anthropic-specific (needs an
OpenAI/Codex analogue) · **[G+A]** generic mechanism wrapping a provider-specific core.

---

## Entry points

- **OpenCode plugin** — `packages/opencode/src/index.ts`, exported `AnthropicAuthPlugin`. Registers
  5 hooks: `config` (command registration), `experimental.chat.system.transform` (parallel-tool
  prompt), `provider` (model list + cost-zeroing), `command.execute.before` (slash-command intercept),
  `auth` (OAuth loader + token refresh). **[G]** hook shape; **[A]** provider id `'anthropic'`.
- **CLI** — `packages/opencode/src/cli.ts`, bin `opencode-anthropic-auth`. Subcommands:
  `login [label]`, `api add [label]`, `list`, `relay setup`. **[G+A]** flow generic, OAuth/endpoints [A].
- **TUI** — source in `packages/opencode/src/tui.tsx`, exported through the host-runtime-aware
  `src/tui/entry.mjs` loader and mounted via `api.slots.register`. Published packages ship a
  precompiled Solid/OpenTUI tree so node_modules loading preserves reactivity. Sidebar + command
  modals. **[G]** rendering; **[A]** quota window labels + command names.
- **Pi frontend** — `packages/pi/` — a SECOND frontend reusing `packages/core/`. Proof the core is
  already frontend-agnostic. Out of scope for openai-auth but relevant to the shared-core question.

---

## A. Auth & token lifecycle — [G+A]

- **What:** OAuth login to Claude Max / Console; long-lived main-token auto-refresh; Claude Code
  identity bootstrap.
- **How:** `core/auth.ts` — `authorize(mode)` builds the PKCE authorize URL (`pkce.ts`), `exchange()`
  trades code→tokens, `refreshClaudeOAuthToken()` refreshes with retry + `Retry-After` parse +
  `ClaudeOAuthRefreshError{status,retryAfter}`. Main refresh lives in the `auth.loader` hook
  (index.ts): shared inflight promise (dedup), cross-process **file-lock + lease** serialization,
  persisted 429 backoff, and a background timer that refreshes before expiry.
- **Coupling:** refresh/retry/backoff/lease machinery **[G]**; OAuth endpoints, scopes, `CLIENT_ID`,
  Claude Code bootstrap (`claude-code.ts` device/account_uuid/session → `metadata.user_id`) **[A]**.

## B. Request transform pipeline — [A] (the provider heart)

- **What:** Rewrites every Anthropic request so an OAuth/Claude-Code-identity call is accepted and
  billed correctly; reverses tool-name munging on the streamed response.
- **How:** `opencode/transform.ts` — `rewriteUrl()` (adds `?beta=true`, base-URL override);
  `rewriteRequestBody()` pipeline: strip trailing assistant msgs → normalize Fable/Mythos thinking →
  inject billing header → sanitize system prompt (remove OpenCode identity, prepend Claude Code
  identity; `sanitize-memo.ts` memoized + `prompt-context.ts`) → apply cache strategy → add fast mode
  → prefix tool names `mcp_` → sign body with `cch` (xxhash). `createStrippedStream()` reverses the
  tool prefix in SSE events. Fail-closed: returns original body on parse failure.
- **Coupling:** almost entirely **[A]** (Claude headers, betas, identity, cch, Anthropic SSE shape).
  The pipeline *structure* (buffer body → transform → re-serialize → sign) is the [G] graft pattern
  openai-auth reuses with a Codex core.

## C. Multi-account & fallback — [G+A]

- **What:** Ordered fallback accounts (OAuth + API-key); auto-route off the main account on
  rate-limit/auth failure; main-first or fallback-first ordering.
- **How:** `core/accounts.ts` — two-file sidecar store (config `anthropic-auth.json` + runtime
  `anthropic-auth-state.json`), atomic temp+rename writes, cross-process file lock. `FallbackAccount`
  Manager` orchestrates per-account background refresh + quota. `getUsableFallbackAccounts()` FILTERS
  (never ranks) by quota policy + killswitch + `enabled`. `shouldFallbackStatus()` = [401,403,429].
  Ingestion is **CLI-only** (`upsertAccount` called only from `cli.ts` login/api routes).
- **Coupling:** store mechanics, file lock, backoff, selection-as-filter, routing modes **[G]**;
  OAuth account shape + the request-time quota pull (Anthropic GET) **[A]**. Provider seam = 2 fns
  (token-refresh, quota-fetch) — see memory #387/#399.

## D. Quota management — [G+A]

- **What:** Track usage % per account across two windows; force-refresh display via `/claude-quota`.
- **How:** `core/quota-manager.ts` `QuotaManager` — dedup, 1s serial gate, per-route 429 backoff,
  token-fingerprint binding, staleness. ACTIVE-PULL from `api.anthropic.com/api/oauth/usage`
  (`fetchOAuthQuotaSnapshot`, module import — NO injection point today). Windows: `five_hour`,
  `seven_day` (`{usedPercent, resetsAt}`).
- **Coupling:** the class machinery (dedup/backoff/fingerprint/staleness/`setMain`/`setFallback`) **[G]**;
  the pull source + window names **[A]**. openai-auth flips this to PASSIVE-PUSH (x-codex-* headers via
  `setMain`) — same class, pull machinery dormant. memory #398.

## E. Killswitch — [G+A]

- **What:** Hard-block requests before they hit the API when an account's quota drops below per-account
  thresholds. `/claude-killswitch on|off|set <id> <5h%> <7d%>`.
- **How:** `core/killswitch.ts` `killswitchPassesPolicy()` keyed on `failClosedOnUnknownQuota`
  (unknown quota → blocked when fail-closed). Gated before request dispatch.
- **Coupling:** policy engine **[G]**; the two window names it reads **[A]**.

## F. Cache control — [G+A]

- **1h cache** (`core/cache1h.ts`, `/claude-cache on|off|mode explicit|automatic|hybrid`): chooses how
  `cache_control` breakpoints + extended-TTL beta are applied. **[A]** (Anthropic prompt-cache model).
- **cacheKeep** (`core/cachekeep.ts`, `/claude-cachekeep status|off|HH-HH`): keeps the Anthropic
  **1-hour** extended cache warm. SELF-ARMING via `track()` (every real main request arms the timer +
  captures freshest body); 60s tick prewarms ≤5min before expiry; replays captured body w/ max_tokens=0.
  **[G]** self-arming timer + replay pattern; **[A]** 1h TTL, cache_control gate, max_tokens=0. memory #405.

## G. Fast mode — [A]

- **What:** `/claude-fast on|off` — adds the fast-mode beta for supported Opus models (`speed:'fast'`).
- **How:** `core/fast.ts` + transform. **[A]** (Anthropic beta + model gating).

## H. Dump (debug capture) — [G+A]

- **What:** `/claude-dump on|off` — capture request bodies/headers/diffs to a dir for debugging.
- **How:** `core/dump.ts` — `redactForDump()` redacts secrets; per-session/request file segments; body
  structure + diff summaries. **[G]** capture+redaction pattern; **[A]** the Anthropic body shape it
  summarizes. NOTE: redaction lives HERE, not in the logger (see N).

## I. Relay — [A] — EXPLICITLY OUT OF SCOPE for openai-auth

- Cloudflare Worker HTTP/WebSocket relay that sends body PATCHES to cut upload bytes on large contexts.
  `core/relay.ts` (+ embedded `WORKER_SCRIPT`), `cli.ts relay setup`. Excluded by operator decision.

## J. TUI — [G+A]

- **What:** Live sidebar (quota bars per account, routing, cache/fast/relay status, killswitch state)
  + interactive command modals.
- **How:** `tui.tsx` mounts via `api.slots.register`; polls the sidebar-state JSON file
  (`sidebar-state.ts`, `setSidebarState`/`readStateFromFile`). Modals = host primitives composed in
  `tui/command-dialogs.tsx` (`DialogSelect/Confirm/Prompt` + `dialog.replace()` for multi-step). Prefs
  in `tui-preferences.ts` (shared JSONC, per-plugin key `anthropic-auth`). Host owns the keyboard.
- **Coupling:** rendering, slot mount, JSON-poll, dialog composition, prefs **[G]**; quota window
  labels + `claude-*` command names **[A]**. memory #402, #61.

## K. RPC — [G] (fully generic)

- **What:** Loopback-HTTP bridge so a slash command in the server process opens a modal in the TUI
  process. `rpc/` — `rpc-server.ts` (bearer-auth HTTP on 127.0.0.1), `rpc-client.ts`, `port-file.ts`
  (pid-stamped discovery), `rpc-dir.ts` (dir keyed on project hash), `notifications.ts`, `protocol.ts`.
- **Coupling:** 100% **[G]** — only the dir namespace + the command-name union are renamed. NOTE: carries
  the multi-session keying bug (parity-backlog #1, memory #410).

## L. Provider model handling — [A]

- `provider.models` hook: `addFableMythos5Models()` injects model specs; `zeroModelCosts()` zeroes
  OAuth per-token costs (quota-billed, not per-token) unless `costZeroing.enabled=false`. `models.ts` =
  model IDs/pricing/context windows. **[A]**.

## M. Quota toast — [G+A]

- `showQuotaToast()` (index.ts) pushes a quota summary via `client.tui.showToast`. **[G]** mechanism;
  **[A]** window labels.

## N. Logging — [G] but NEGATIVE reference

- `core/logger.ts` → `$TMPDIR/opencode-anthropic-auth.log`. All-or-nothing, **no levels, no verbosity
  knob, no sink redaction** (redaction lives only in dump.ts), no env override, no rotation. This is the
  module openai-auth is REPLACING (and we should backport the replacement). parity-backlog #3.

---

## Bidirectional parity framing

- **openai-auth → anthropic-auth** (what WE adopt — already tracked in `docs/parity-backlog.md`):
  RPC multi-session fix [READY], cacheKeep per-warm cost logging [READY], duck-typed ProviderHttpError
  [GATED], leveled/redacting/rotating logger [GATED], in-plugin account control surface + OSC-52 [PARITY].
- **anthropic-auth → openai-auth** (what THEY need — confirm against their catalogue): full feature set
  above MINUS relay (I). Known-built on their side per s2s: transport graft (B-analogue), passive quota
  push (D), sidebar (J), multi-account+fallback (C), account ingestion (CLI+/openai-account add),
  fast/dump/cache analogues TBD, killswitch (E) TBD, cost-zeroing/model handling (L) TBD.
- **NEEDS THEIR CATALOGUE to complete the diff:** which of {fast mode, dump, 1h-cache modes, killswitch,
  cost-zeroing, quota toast, parallel-tool prompt, system-prompt sanitization analogue} they have vs not.

---

## Bidirectional diff (resolved against openai-auth's as-built surface, 2026-06-18)

**parity-match (both have, provider-specifics aside):** auth (OAuth+device+manual API key) · multi-account
main+fallbacks · reactive fallback on 401/403/429 + replay guard · killswitch per-account 5h/7d thresholds ·
quota 2-window + QuotaManager setMain/setFallback · sidebar · cacheKeep self-arming track+replay · routing
main-first/fallback-first MODES · cost-zero display · CLI fallback mgmt.

**I-have-you-dont (openai-auth should add for parity):**
- Routing SELECTION richness (they adopt — see s2s B): 2-tier OAuth→API-key, confirmed-exhaustion gate, per-account backoff gating, every-N active-route refresh.
- API-key fallback TIER gated behind `refreshMainQuotaConfirmsExhausted` (paid routes never fire on stale quota).
- cost-zeroing TOGGLE (`costZeroing.enabled`, default on) — they zero unconditionally.
- Main-refresh cross-process file-lock + lease + persisted backoff + shared-inflight dedup.
- Parallel-tool-calls system-prompt injection (`experimental.chat.system.transform`).

**you-have-I-dont (anthropic-auth should add — = parity-backlog.md):** interactive modals · leveled/redacting/
rotating logger + `/logging` cmd · cacheKeep per-warm cost logging · RPC multi-session pid fix · in-plugin
`/account` mgmt + OSC-52 · persistent-cachekeep auto-arm + subagent mode.

**provider-specific (stay per-plugin, NOT parity gaps):** anthropic — 1h-cache modes (`/claude-cache`),
fast mode (`/claude-fast`), Fable/Mythos models, cch/Claude-Code identity, relay. openai — web_search
prompt-cache stabilizer, WS/raw-WS transports, Codex rewrite, x-codex-* passive quota.

**Agreed unified surface — LOCKED 2026-06-18 (7 shared command nouns, same modal UX):** quota · account ·
routing · killswitch · dump · cachekeep · logging — each an interactive L1→L2 control-surface modal.
Prefix stays provider (`claude-`/`openai-`). Provider extras allowed (`claude-cache`, `claude-fast`).
Routing = anthropic's selection algorithm both sides (openai-auth already inherited it via copy-adapt).
Modal pattern = openai-auth's DialogSelect + replace-loop + OSC-52 (anthropic-auth adopts; build-time
notes in parity-backlog.md #5). cacheKeep UX = on/off-persistent + subagent toggle both sides; anthropic's
daily-window kept as an optional extra row (parity-backlog.md #6). openai-auth's residual delta to us was
only 3 items (API-key tier [operator-gated, billing], main-refresh lease wiring, sanitize-memo) — the rest
it inherited from our accounts.ts.

_Provenance: built firsthand from the live tree for the openai-auth consolidation, 2026-06-18._
