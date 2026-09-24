# Anthropic custody serving states

## Authority

`anthropic-auth.json` records a global mode: `local` (default) or `claustrum`. In local mode, OpenCode's own Anthropic OAuth entry and fallback sidecar credentials are authoritative; no vault connection is made. In Claustrum mode, `scopedRoster: true`, an approved host enrollment token, and a `category:anthropic-native` read grant make Claustrum's `credential.list_scoped` inventory authoritative for every OAuth account. The default `oauth:anthropic` record is main. API-key routes remain separate.

The handle manifest, capability-handle cache, and per-account custody switches are **not** serving inputs. An old Claustrum-mode config without `scopedRoster: true` is refused; it is not converted to local serving or silently adopted. Account discovery under a cross-process lock projects secret-free IDs, account UUIDs, quotas, and preferences into the sidecar. Removed credentials leave the roster, and disabled accounts remain disabled. Fresh quota is requested for newly discovered accounts.

Every model request, quota or profile query, Prime fire, and CacheKeep prewarm authorizes against `credential.get_scoped` at the physical dispatch boundary with at least five minutes' remaining TTL. Each send's exact record version is used for its own 401 failure report; a subsequent credential rotation cannot change that provenance. A replayable direct or HTTP-relay model request, CacheKeep prewarm, Prime fire, or quota/profile GET that receives a genuine upstream 401 is reauthorized once: only a different record version for the same credential and provider account permits one retry. OpenCode maps its stable main-quota UUID to the `main` scoped route before querying Anthropic. If the version did not advance, the exact rejected record is reported. An optimistic WebSocket response may already be streaming before its upstream 401 arrives, so that status is reported against its served receipt rather than silently replayed after response delivery. Relay-owned 401s without Anthropic request-ID provenance fall back direct if configured, or return 502 rather than marking an OAuth account permanently invalid. A failed or revoked scoped authorization never spends a stale local credential. Neither access tokens nor enrollment tokens appear in public account configuration or UI projections.

## OpenCode activation and refusal

OpenCode needs an OAuth-shaped, non-secret Anthropic entry for `auth.loader` to run:

```json
{ "type": "oauth", "access": "", "refresh": "claustrum-tombstone:v1:anthropic", "expires": 0 }
```

An empty `access` is intentional: the host decodes it as OAuth, while it is not importable as a usable vault credential. The loader recognizes the exact provider-scoped tombstone. The irreversible token-exchange and request-header boundaries reject **any** `claustrum-tombstone:` prefix, including a foreign-provider tombstone. Thus refusal is strictly wider than recognition.

At boot, `reconcileCustodyStartup` admits only:

| Mode | Main host entry | Fallback material | Verified scoped primary | Outcome |
|---|---|---|---|---|
| local | real | local | irrelevant | `LOCAL_SERVE` |
| claustrum | tombstone | secret-free scoped roster | yes | `CLAUSTRUM_SERVE` |
| anything else | any | any | any | `FAIL_CLOSED` |

A missing or malformed host entry cannot activate the loader at all. A real main OAuth token under `claustrum` mode, an incomplete roster, a changed primary identity, or an unavailable credential cannot cause a local-token fallback. Legacy local fallback OAuth material under an incomplete Claustrum mode cannot be refreshed by background maintenance.

OpenCode's `Auth.set` performs unlocked whole-file writes without CAS. The plugin does not install the tombstone from a live mode command. `bunx @cortexkit/opencode-anthropic-auth setup` requires hosts to be stopped, enrolls and verifies scoped access, installs configuration with process fences, and writes the main tombstone offline. `/claude-account claustrum` directs the user to setup; `/claude-account local` explains that returning to local mode requires replacing the tombstone with verified local OAuth outside the running host. Neither command changes authority on its own.

Pi uses a separate `anthropic-auth-pi` enrollment and native ambient authentication, with no host auth tombstone. Setup requires explicit consent to remove any conflicting stored Pi Anthropic OAuth credential before activation. The hosts can be revoked independently.

## Explicit enrollment lifecycle

Only `bunx @cortexkit/opencode-anthropic-auth setup` proposes and polls consumer enrollment. Host startup and `/claude-account` read the owner-only token/state files without creating a request or scheduling polls. `/claude-account enrollment-reset` deletes terminal local metadata under lock but never proposes a replacement; run setup afterward. A live pending request cannot be reset blindly. During explicit setup, a pending secret without a request ID resumes with that secret; a daemon-proven superseded, consumed, or missing request ID is reset under lock and reproposed at most once. Denials and other terminal errors remain blocked. Core treats every code Claustrum marks permanently refused as terminal even while older clients label Error frames retryable. This removes the host-process-multiplied enrollment poll loop, while scoped roster discovery after approved enrollment remains active for new account logins.
