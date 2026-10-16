#!/usr/bin/env bash

set -euo pipefail

# Collect changed files from unstaged, staged, and untracked sets.
changed_files=()
while IFS= read -r file; do
  changed_files+=("$file")
done < <(
  {
    git diff --name-only --diff-filter=ACMR
    git diff --cached --name-only --diff-filter=ACMR
    git ls-files --others --exclude-standard
  } | awk 'NF' | sort -u
)

if [[ ${#changed_files[@]} -eq 0 ]]; then
  echo "No changed files to format."
  exit 0
fi

bunx prettier --write --ignore-unknown "${changed_files[@]}"
