#!/usr/bin/env bash
# The body of the pull request this run is for, on stdout; empty when it is for none. Where the actions that read a
# `Depends-On:` line (.github/actions/depends-on, .github/actions/starter) get the line from.
#
# A run started by a pull request event is for that pull request: its number is in PULL. A run started by hand on a branch
# other than the default one has no event pull request, so it is for the open pull request whose head is that branch of this
# repository (a pull request from a fork has no branch here, so a hand-started run on one finds none); with none open, or on
# the default branch or a tag, the run is for no pull request and the line is not read. The pull request is named on stderr, so
# that the log of the run says which one it took the line from. The body is read now, not from the event: a re-run after the
# body gained its Depends-On line sees the line.
#
# Needs GH_TOKEN; reads PULL, GITHUB_REPOSITORY, GITHUB_REPOSITORY_OWNER, GITHUB_REF_NAME, GITHUB_REF_TYPE and
# DEFAULT_BRANCH (the repository's, asked of the API when empty).
set -euo pipefail
pull=${PULL:-}
if [ -z "$pull" ] && [ "${GITHUB_REF_TYPE:-}" = branch ]; then
  default=${DEFAULT_BRANCH:-}
  if [ -z "$default" ]; then default=$(gh api "repos/${GITHUB_REPOSITORY}" --jq .default_branch); fi
  if [ "$GITHUB_REF_NAME" != "$default" ]; then
    pull=$(gh api -X GET "repos/${GITHUB_REPOSITORY}/pulls" -f head="${GITHUB_REPOSITORY_OWNER}:${GITHUB_REF_NAME}" -f state=open --jq '.[0].number // empty')
    if [ -n "$pull" ]; then
      echo "A run started by hand on ${GITHUB_REF_NAME}: its open pull request is #${pull}, whose body names the pull requests to read." >&2
    else
      echo "A run started by hand on ${GITHUB_REF_NAME}: no open pull request has it as its head, so the default branches are read." >&2
    fi
  fi
fi
if [ -n "$pull" ]; then gh api "repos/${GITHUB_REPOSITORY}/pulls/${pull}" --jq '.body // ""'; fi
