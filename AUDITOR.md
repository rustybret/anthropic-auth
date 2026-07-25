# Auditor Notes

Guidance for future audits of intentional tradeoffs in this repository.

## Relay/WebSocket routing

- **Per-affinity WebSocket serialization is intentional.** The relay protocol keeps one ordered request stream per `x-session-affinity` so patch bases, revisions, and Worker checkpoint state remain consistent. Do not flag the per-affinity queue as a bug unless proposing a protocol-level design with independent per-request state or resumable streams.
- **Patch mismatch recovery can require `full_sync`.** When the local patch base does not match Worker state, the safe recovery path is to retry as `full_sync` before sending upstream. This costs upload bytes but prevents sending reconstructed-corrupt bodies to Anthropic.
- **Fallback routes are intentionally sequential.** Sending multiple model requests in parallel can double-spend OAuth quota or API-key credits and can produce duplicate assistant/tool streams. Do not recommend parallel fallback dispatch without an explicit cancellation/billing design.
- **WebSocket requests currently use fixed internal ready/response timeouts.** HTTP relay now propagates request abort signals. WebSocket abort/resume support is a larger protocol concern and should be evaluated with the Durable Object/resumable-stream design, not as a small local patch.

## Cache and request transforms

- **Pi cache-marker behavior intentionally does not yet mirror OpenCode hybrid anchoring.** OpenCode receives already-shaped provider request JSON and has Magic Context-specific anchor logic; Pi builds Anthropic bodies from Pi messages. Treat Pi cache parity as a product/design task rather than a drive-by perf fix.
- **CCH/signing and cache rewrites parse/stringify request bodies.** This is expected because signing must cover the final serialized body and cache markers are JSON-structural. Optimizations should preserve exact wire-body semantics and be backed by benchmarks.
- **Relay patch creation is linear in body size.** This is currently acceptable relative to JSON serialization/signing and network upload costs. Replacing it should be justified by measurements and must preserve hash-gated reconstruction.

## Quota and fallback policy

- **API-key fallback routes are deliberately stricter than OAuth fallback accounts.** They may only run after confirmed main OAuth quota exhaustion: fresh token-bound 0% quota, or main OAuth 429/streaming rate-limit followed by a live quota check confirming 0%. Low-but-nonzero quota, stale cached quota, unconfirmed 429s, 401, and 403 must not trigger API-key routes.
- **Killswitch quota refresh can block request routing.** This is intentional for safety when the user enables killswitch behavior. Any performance optimization must preserve fail-closed semantics.

## Logging

- **The temp-file logger uses buffered synchronous writes.** It flushes at a 500ms cadence or 50-line buffer to avoid losing diagnostics on crashes while keeping normal request-path overhead low. Do not flag as a correctness issue without latency measurements showing it is material.

## Sticky-balanced routing

- **Session affinity intentionally outranks moment-to-moment quota ranking.** Once assigned, a session remains on its OAuth account across transient transport/provider/quota-probe failures and relative quota changes so its large prompt cache is not rewritten on another account.
- **A confirmed five-hour exhaustion does not migrate when reset is within 15 minutes.** The route returns `Retry-After` and remains assigned; longer 5h exhaustion, 7d/model-scoped exhaustion, killswitch blocks, removed/disabled accounts, and permanent re-login failures may migrate.
- **API-key routes are not candidates for quota-balanced first assignment.** Their existing confirmed-main-exhaustion gate remains authoritative.
