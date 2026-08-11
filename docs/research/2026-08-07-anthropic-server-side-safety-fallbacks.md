# Anthropic server-side safety fallbacks

Date: 2026-08-07

## Sources

- Anthropic, [Improving Fable 5's biology safeguards](https://www.anthropic.com/news/improving-fable-5-s-biology-safeguards)
- Anthropic, [Introducing Claude Opus 5](https://www.anthropic.com/news/claude-opus-5)
- Anthropic Platform, [Refusals and fallback](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback)
- Anthropic Platform, [Fallback credit](https://platform.claude.com/docs/en/build-with-claude/fallback-credit)
- Live Anthropic Models and Messages APIs queried with the `server-side-fallback-2026-07-01` beta on 2026-08-07

## Findings

Anthropic's safety fallback is not a universal model ladder. Routing is conditioned on the classifier category and source model:

- A Fable 5 request flagged by the biology safeguard is routed to Opus 5 in Anthropic's first-party products, including Claude Code.
- An Opus 5 request flagged by the cybersecurity safeguard is routed to Opus 4.8 in Anthropic's first-party products.
- The API supports the same mechanism as an opt-in beta by sending `fallbacks: "default"` with `anthropic-beta: server-side-fallback-2026-07-01`.
- Anthropic recommends `default` routing because the category-specific routes can change. The default route table is not a stable public mapping that clients should duplicate.
- Classifier routing is category-aware, but server-side fallback also uses best-effort sticky routing: after a fallback serves a conversation, later requests containing `fallbacks` can go directly to that model for approximately one hour without trying the requested model again.

The live Models API currently reports:

| Requested model | Allowed fallback models |
| --- | --- |
| `claude-fable-5` | `claude-opus-4-8`, `claude-opus-5` |
| `claude-opus-5` | `claude-opus-4-8` |
| `claude-opus-4-8` | none |

This confirms a routing graph rather than a fixed Fable → Opus 5 → Opus 4.8 chain. Fable can legally route to either Opus model; Anthropic chooses the target according to the safety category. The two launch articles publicly identify Fable-biology → Opus 5 and Opus-5-cybersecurity → Opus 4.8.

A live OAuth Messages request to `claude-fable-5` with `fallbacks: "default"` and the beta header returned HTTP 200. The non-refused response stayed on Fable 5 and exposed the beta response additions `stop_details: null` and `usage.iterations`. This proves that the OAuth Messages path accepts the beta request shape. Anthropic's protocol documentation specifies the fallback stream shape: the top-level `model` identifies the serving model, an ordinary `fallback` content block marks an actual handoff, and final `usage.iterations` records requested-model attempts as `message` and fallback-served attempts as `fallback_message`.

Sticky-served follow-up turns have no `fallback` boundary because no new refusal occurred. They remain distinguishable: the top-level model is the fallback model and `usage.iterations` contains `fallback_message` without a requested-model `message` attempt. A return to the selected model is likewise observable when the top-level model matches the requested model and no `fallback_message` served the response.

## Live OAuth verification

Testing against the OAuth Messages route confirmed:

- Sending only `anthropic-beta: server-side-fallback-2026-07-01` does not activate fallback; the request body must also contain `fallbacks: "default"`.
- A Fable 5 biology refusal with both opt-ins was served by Opus 5. The response contained a `fallback` block from `claude-fable-5` to `claude-opus-5`, and usage contained one `message` iteration plus one `fallback_message` iteration.
- Follow-up requests remained on the fallback model under Anthropic's best-effort sticky policy. Replaying or omitting the historical fallback block was accepted in controlled continuation probes, but preserving the block retains the complete Anthropic conversation boundary rather than silently discarding provider state.
- A large cached prompt was charged one Fable cache write and one Opus cache write on the initial server fallback. This is the same cold dual-write shape observed with a tokenless manual retry.

## Fallback Credit is not available to OAuth

Anthropic's separate Fallback Credit beta (`fallback-credit-2026-07-01`) can issue a short-lived credit token and optional prefill claim for client-managed retries under supported API-key authentication. It would have preserved the plugin's exact ten-response policy while avoiding duplicate prompt-cache writes.

The OAuth spike did not issue a credit token:

- Fable 5 cyber and biology refusals returned no `fallback_credit_token` or prefill claim.
- The result was unchanged across two OAuth accounts, streaming and non-streaming requests, and requests carrying the server-fallback beta.
- Server-side fallback succeeded on the same OAuth route and refusal prompt.

Therefore Fallback Credit cannot implement OAuth refusal recovery in this plugin. Custom client retries remain useful only as the existing rollback path, without fallback-credit repricing.

## Implemented policy

OpenCode now defaults eligible Fable 5 and Opus 5 OAuth requests to Anthropic server-side safety fallback:

1. Add `fallbacks: "default"` to the final request body and `server-side-fallback-2026-07-01` to the beta header.
2. Detect an initial handoff from the streamed `fallback` content block.
3. Detect sticky fallback turns from the top-level served model and `usage.iterations[].type === "fallback_message"`.
4. Detect restoration when the requested model serves a completed non-refusal turn without fallback evidence.
5. Publish one session-scoped active/restored transition to the TUI sidebar or, when no matching TUI is connected, OpenCode Desktop.

OpenCode's protocol does not natively retain Anthropic's `fallback` block. The stream rewriter therefore converts it to a hidden thinking block containing a CortexKit-owned signature before OpenCode persists the response. On the next eligible server-fallback request, the body transformer validates that signature and reconstructs the original `fallback` block before cache transforms and `cch` signing. Markers are dropped rather than forwarded to ineligible models or custom API-key providers.

The fallback beta and payload field are OAuth/provider-specific. Custom Anthropic-compatible API-key routes strip both before forwarding.

## Rollback mode

Set:

```bash
OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE=legacy
```

before starting OpenCode to restore the previous client-managed policy. Legacy mode keeps the existing ten-successful-response Opus 4.8 recovery, source-model zero-output prewarming, account-bound standby cache anchors, and deterministic countdown UX. No coexistence path runs both policies on one request: the environment variable selects server or legacy behavior at process startup.

## Conclusion

Server-side fallback is the default because it is the only Anthropic-supported OAuth mechanism that can turn safety refusals into completed responses. Its trade-offs remain server-controlled model selection, approximately one-hour best-effort stickiness, and cold fallback-model cache writes. The legacy mode remains intact as an explicit rollback path if live behavior proves worse than the deterministic ten-response policy.
