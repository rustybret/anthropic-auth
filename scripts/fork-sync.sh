#!/usr/bin/env bash
# Fork sync — fast-forward-or-merge model for anthropic-auth.
#
# Syncs this fork (rustybret/anthropic-auth) with upstream (cortexkit/anthropic-auth)
# without ever rebasing or force-pushing:
#   1. fetch upstream and origin
#   2. merge upstream/<branch> into current branch
#   3. auto-resolve standing conflict classes from scripts/fork-sync-exclusions
#   4. verify build passes
#   5. push to origin (unless FORK_SYNC_NO_PUSH=1)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXCLUSIONS="$ROOT/scripts/fork-sync-exclusions"
REMOTE="${1:-upstream}"
BRANCH="${2:-main}"
NO_PUSH="${FORK_SYNC_NO_PUSH:-0}"
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
if [[ -n "$(git -C "$ROOT" status --porcelain)" ]]; then
  echo "error: working tree is not clean. Commit or stash before syncing." >&2
  exit 2
fi

# --- parse the exclusion manifest ---------------------------------------------
KEEP_DELETED=()
TAKE_THEIRS=()
while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%%#*}"                          # strip comments
  line="${line#"${line%%[![:space:]]*}"}"     # trim leading whitespace
  [[ -z "$line" ]] && continue
  case "$line" in
    keep-deleted:*) KEEP_DELETED+=("${line#keep-deleted:}") ;;
    take-theirs:*)  TAKE_THEIRS+=("${line#take-theirs:}") ;;
    *) echo "warning: unrecognized manifest line: $line" >&2 ;;
  esac
done < "$EXCLUSIONS"

# --- 1. fetch ------------------------------------------------------------------
echo "== fetch $REMOTE and origin =="
git -C "$ROOT" fetch "$REMOTE" "$BRANCH"
git -C "$ROOT" fetch origin "$LOCAL_BRANCH" || true

# --- 2. merge ------------------------------------------------------------------
echo "== merge $REMOTE/$BRANCH into $LOCAL_BRANCH =="
MERGE_BASE="$(git -C "$ROOT" merge-base HEAD "$REMOTE/$BRANCH")"
UPSTREAM_HEAD="$(git -C "$ROOT" rev-parse "$REMOTE/$BRANCH")"

if [[ "$MERGE_BASE" == "$UPSTREAM_HEAD" ]]; then
  echo "Already up to date with $REMOTE/$BRANCH."
else
  if git -C "$ROOT" merge "$REMOTE/$BRANCH" -m "chore(sync): merge upstream $BRANCH into $LOCAL_BRANCH" --no-edit; then
    echo "Clean merge completed."
  else
    echo "Resolving conflicts via exclusion manifest..."
    # Check unmerged files against exclusions
    for conflict_file in $(git -C "$ROOT" diff --name-only --diff-filter=U); do
      for g in "${KEEP_DELETED[@]}"; do
        g="${g#"${g%%[![:space:]]*}"}"
        if [[ "$conflict_file" == $g ]]; then
          git -C "$ROOT" rm -f "$conflict_file" || true
          break
        fi
      done
      for g in "${TAKE_THEIRS[@]}"; do
        g="${g#"${g%%[![:space:]]*}"}"
        if [[ "$conflict_file" == $g ]]; then
          git -C "$ROOT" checkout --theirs "$conflict_file"
          git -C "$ROOT" add "$conflict_file"
          break
        fi
      done
    done

    # Check if remaining conflicts exist
    REMAINING="$(git -C "$ROOT" diff --name-only --diff-filter=U)"
    if [[ -n "$REMAINING" ]]; then
      echo "error: unhandled merge conflicts in:" >&2
      echo "$REMAINING" >&2
      exit 1
    fi

    git -C "$ROOT" commit --no-edit
  fi
fi

# --- 3. verify build -----------------------------------------------------------
echo "== verifying workspace build =="
cd "$ROOT"
bun run build

# --- 4. push -------------------------------------------------------------------
if [[ "$NO_PUSH" == "1" ]]; then
  echo "FORK_SYNC_NO_PUSH=1; skipping push to origin."
else
  echo "== push to origin/$LOCAL_BRANCH =="
  git -C "$ROOT" push origin "$LOCAL_BRANCH"
fi

echo "Fork sync complete."
