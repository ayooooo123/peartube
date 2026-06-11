#!/usr/bin/env bash
# Resolves the release tag and artifact version for release workflows.
#
# Inputs (environment): REQUESTED_TAG (optional workflow_dispatch input),
# GITHUB_REF, GITHUB_REF_NAME, GITHUB_SHA.
#
# Prints RELEASE_TAG=... and VERSION=... shell assignments on stdout, for:
#   eval "$("$GITHUB_WORKSPACE/scripts/ci/resolve-release-version.sh")"
set -euo pipefail

RELEASE_TAG="${REQUESTED_TAG:-}"
if [ -z "$RELEASE_TAG" ] && [[ "${GITHUB_REF:-}" == refs/tags/v* ]]; then
  RELEASE_TAG="$GITHUB_REF_NAME"
fi

if [ -n "$RELEASE_TAG" ]; then
  VERSION="${RELEASE_TAG#v}"
else
  VERSION="dev-${GITHUB_SHA::7}"
fi

printf 'RELEASE_TAG=%q\n' "$RELEASE_TAG"
printf 'VERSION=%q\n' "$VERSION"
