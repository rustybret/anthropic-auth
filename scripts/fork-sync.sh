#!/usr/bin/env bash
# Fork sync — fast-forward-or-merge model for anthropic-auth.
#
# Syncs this fork (rustybret/anthropic-auth) with upstream (cortexkit/anthropic-auth)
# without ever rebasing or force-pushing:
#   1. fetch upstream and origin
#   1b. fast-forward to origin if origin is ahead
#   2. merge upstream/<branch> into current branch (default: main)
#   3. auto-resolve standing conflict classes from scripts/fork-sync-exclusions
#   4. reconcile regenerated artifacts (lockfiles) into the merge commit
#   5. verify build passes
#   6. push to origin (unless FORK_SYNC_NO_PUSH=1)
set -euo pipefail

ROOT="${FORK_SYNC_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
EXCLUSIONS="${FORK_SYNC_EXCLUSIONS:-$ROOT/scripts/fork-sync-exclusions}"
REMOTE="${1:-upstream}"
BRANCH="${2:-main}"
NO_PUSH="${FORK_SYNC_NO_PUSH:-0}"
SKIP_BUILD="${FORK_SYNC_SKIP_BUILD:-0}"
LOCAL_BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"

if [[ ! -f "$EXCLUSIONS" ]]; then
  echo "error: exclusion manifest not found: $EXCLUSIONS" >&2
  exit 2
fi

# --- guards ------------------------------------------------------------------
if git -C "$ROOT" rev-parse -q --verify REBASE_HEAD >/dev/null 2>&1; then
  echo "error: a rebase is in progress. The fork model is merge-only: abort or finish it first." >&2
  exit 2
fi
if git -C "$ROOT" rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1; then
  echo "error: a merge is already in progress. Resolve conflicts and run 'git commit --no-edit', or run 'git merge --abort', then re-run." >&2
  exit 2
fi
if git -C "$ROOT" status --porcelain | grep -v '^?? dist-arcus/' | grep -v '^?? captures/' | grep -q .; then
  echo "error: working tree is not clean. Commit or stash before syncing." >&2
  exit 2
fi

# --- parse the exclusion manifest ---------------------------------------------
KEEP_DELETED=()
TAKE_THEIRS=()
REGENERATE=()

# trim <string> — strip surrounding whitespace. Manifest values are used both as
# match patterns AND as literal git pathspecs, so they must be normalized here
# at parse time: a stray leading space silently turns `bun.lock` into a pathspec
# for a file named " bun.lock", which matches nothing and fails open.
trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%%#*}"                          # strip comments
  line="$(trim "$line")"
  [[ -z "$line" ]] && continue
  case "$line" in
    keep-deleted:*) KEEP_DELETED+=("$(trim "${line#keep-deleted:}")") ;;
    take-theirs:*)  TAKE_THEIRS+=("$(trim "${line#take-theirs:}")") ;;
    regenerate:*)   REGENERATE+=("$(trim "${line#regenerate:}")") ;;
    *) echo "warning: unrecognized manifest line: $line" >&2 ;;
  esac
done < "$EXCLUSIONS"

# matches_any <path> <glob>... — true when <path> matches any supplied glob.
# Callers must expand arrays with the ${ARR[@]+"${ARRARR[@]}"} guard so an empty
# manifest class does not trip `set -u`.
matches_any() {
  local file="$1"
  shift
  local g
  for g in "$@"; do
    [[ -z "$g" ]] && continue
    # Intentional glob match on the right-hand side, not a literal compare.
    # shellcheck disable=SC2053
    if [[ "$file" == $g ]]; then
      return 0
    fi
  done
  return 1
}

# ecosystem_for <basename> — map a regenerate target to its rebuild ecosystem.
# Dispatch keys on the MATCHED FILE'S BASENAME, not on the glob that matched it,
# so one manifest rule can cover several ecosystems in a polyglot fork.
# An unrecognized basename is a hard error: guessing a rebuild command would
# stage an artifact that was never actually regenerated.
ecosystem_for() {
  case "$1" in
    bun.lock | bun.lockb) printf 'bun' ;;
    Cargo.lock) printf 'cargo' ;;
    *) return 1 ;;
  esac
}

# regenerate_targets <path>... — rebuild every regenerate target from the merged
# manifests. Validates the full target set BEFORE running anything, so an
# unknown target aborts while the conflict is still intact for manual review
# rather than half-way through a partial regeneration.
regenerate_targets() {
  local target base eco
  local ecosystems=""

  for target in "$@"; do
    base="$(basename "$target")"
    if ! eco="$(ecosystem_for "$base")"; then
      echo "error: no rebuild command is known for regenerate target: $target" >&2
      echo "       add a dispatch entry to ecosystem_for(), or drop the rule and" >&2
      echo "       resolve this file manually. Refusing to guess." >&2
      exit 1
    fi
    case " $ecosystems " in
      *" $eco "*) ;;                          # already queued
      *) ecosystems="$ecosystems $eco" ;;
    esac
  done

  for eco in $ecosystems; do
    case "$eco" in
      bun)
        # `bun install --frozen-lockfile=false` is NOT valid — bun exits 1 with
        # "the argument does not take a value" and leaves the lockfile
        # unregenerated. `--no-frozen-lockfile` is the working spelling and is
        # stated explicitly so an inherited frozen default can never suppress
        # the regeneration this verb exists to perform.
        echo "== regenerating bun lockfile from merged manifests =="
        (cd "$ROOT" && bun install --no-frozen-lockfile)
        ;;
      cargo)
        echo "== regenerating Cargo lockfile from merged manifests =="
        (cd "$ROOT" && cargo metadata --format-version 1 >/dev/null)
        ;;
    esac
  done
}

# --- 1. fetch ------------------------------------------------------------------
echo "== fetch $REMOTE and origin =="
git -C "$ROOT" fetch "$REMOTE" "$BRANCH"
git -C "$ROOT" fetch origin "$LOCAL_BRANCH" || true

# --- 1b. fast-forward to origin if ahead --------------------------------------
if git -C "$ROOT" rev-parse -q --verify "origin/$LOCAL_BRANCH" >/dev/null 2>&1; then
  ORIGIN_HEAD="$(git -C "$ROOT" rev-parse "origin/$LOCAL_BRANCH")"
  LOCAL_HEAD="$(git -C "$ROOT" rev-parse HEAD)"

  if [[ "$LOCAL_HEAD" != "$ORIGIN_HEAD" ]]; then
    if git -C "$ROOT" merge-base --is-ancestor HEAD "origin/$LOCAL_BRANCH" 2>/dev/null; then
      echo "== fast-forwarding $LOCAL_BRANCH to origin/$LOCAL_BRANCH =="
      git -C "$ROOT" merge --ff-only "origin/$LOCAL_BRANCH"
    fi
  fi
fi

# --- 2. merge ------------------------------------------------------------------
echo "== merge $REMOTE/$BRANCH into $LOCAL_BRANCH =="
MERGE_BASE="$(git -C "$ROOT" merge-base HEAD "$REMOTE/$BRANCH")"
UPSTREAM_HEAD="$(git -C "$ROOT" rev-parse "$REMOTE/$BRANCH")"

PRE_MERGE_HEAD="$(git -C "$ROOT" rev-parse HEAD)"

if [[ "$MERGE_BASE" == "$UPSTREAM_HEAD" ]]; then
  echo "Already up to date with $REMOTE/$BRANCH."
elif git -C "$ROOT" merge "$REMOTE/$BRANCH" -m "chore(sync): merge upstream $BRANCH into $LOCAL_BRANCH" --no-edit; then
  echo "Clean merge completed."

  # Clean-merge safety: git can merge a lockfile textually without conflict and
  # still leave it inconsistent with the merged package.json set. Reconcile and
  # fold the result back into the merge commit so the commit is never broken.
  PARENT_COUNT="$(git -C "$ROOT" rev-list --parents -n 1 HEAD | awk '{print NF-1}')"
  if [[ "$PARENT_COUNT" -lt 2 ]]; then
    echo "Fast-forward merge; no fork-side manifest deltas to reconcile."
  else
    REGEN_TOUCHED=()
    while IFS= read -r changed_file; do
      [[ -z "$changed_file" ]] && continue
      if matches_any "$changed_file" ${REGENERATE[@]+"${REGENERATE[@]}"}; then
        REGEN_TOUCHED+=("$changed_file")
      fi
    done < <(git -C "$ROOT" diff --name-only "$PRE_MERGE_HEAD" HEAD)

    if [[ "${#REGEN_TOUCHED[@]}" -gt 0 ]]; then
      regenerate_targets "${REGEN_TOUCHED[@]}"
      if [[ -n "$(git -C "$ROOT" status --porcelain -- "${REGEN_TOUCHED[@]}")" ]]; then
        echo "Lockfile drifted after regeneration; amending into the merge commit."
        git -C "$ROOT" add -- "${REGEN_TOUCHED[@]}"
        git -C "$ROOT" commit --amend --no-edit
      else
        echo "Regenerated artifacts already consistent with the merge."
      fi
    fi
  fi
else
  echo "Resolving conflicts via exclusion manifest..."
  REGEN_PENDING=()

  while IFS= read -r conflict_file; do
    [[ -z "$conflict_file" ]] && continue

    if matches_any "$conflict_file" ${KEEP_DELETED[@]+"${KEEP_DELETED[@]}"}; then
      git -C "$ROOT" rm -f "$conflict_file" || true
      continue
    fi

    if matches_any "$conflict_file" ${TAKE_THEIRS[@]+"${TAKE_THEIRS[@]}"}; then
      git -C "$ROOT" checkout --theirs -- "$conflict_file"
      git -C "$ROOT" add -- "$conflict_file"
      continue
    fi

    if matches_any "$conflict_file" ${REGENERATE[@]+"${REGENERATE[@]}"}; then
      # Take upstream as the base, but do NOT stage yet: the regeneration must
      # run against the fully resolved manifest set, so it is deferred until
      # every other conflict class has been settled below.
      git -C "$ROOT" checkout --theirs -- "$conflict_file"
      REGEN_PENDING+=("$conflict_file")
      continue
    fi
  done < <(git -C "$ROOT" diff --name-only --diff-filter=U)

  # Any conflict left unmerged that is not a deferred regenerate target is a
  # genuine unhandled conflict — fail before spending an install on it.
  REMAINING=""
  while IFS= read -r unmerged_file; do
    [[ -z "$unmerged_file" ]] && continue
    if matches_any "$unmerged_file" ${REGEN_PENDING[@]+"${REGEN_PENDING[@]}"}; then
      continue
    fi
    REMAINING+="$unmerged_file"$'\n'
  done < <(git -C "$ROOT" diff --name-only --diff-filter=U)

  if [[ -n "${REMAINING//[$'\n'[:space:]]/}" ]]; then
    echo "error: unhandled merge conflicts in:" >&2
    printf '%s' "$REMAINING" >&2
    echo "Resolve the conflicts, then run 'git commit --no-edit', or abort with 'git merge --abort'." >&2
    exit 1
  fi

  if [[ "${#REGEN_PENDING[@]}" -gt 0 ]]; then
    regenerate_targets "${REGEN_PENDING[@]}"
    git -C "$ROOT" add -- "${REGEN_PENDING[@]}"
  fi

  git -C "$ROOT" commit --no-edit
fi

# --- 3. verify build -----------------------------------------------------------
echo "== verifying workspace build =="
cd "$ROOT"
if [[ "$SKIP_BUILD" == "1" ]]; then
  echo "FORK_SYNC_SKIP_BUILD=1; skipping workspace build."
else
  bun run build
fi

# --- 4. push -------------------------------------------------------------------
if [[ "$NO_PUSH" == "1" ]]; then
  echo "FORK_SYNC_NO_PUSH=1; skipping push to origin."
else
  echo "== push to origin/$LOCAL_BRANCH =="
  git -C "$ROOT" push origin "$LOCAL_BRANCH"
fi

echo "Fork sync complete."
