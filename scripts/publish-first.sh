#!/usr/bin/env bash
# First-time publish for all @husk-ai packages.
#
# Run locally (not in CI) because npm requires an OTP for accounts with
# two-factor auth enabled. After this initial publish, configure Trusted
# Publishing (OIDC) on each package so future releases go through CI
# without a token.
#
# Usage:
#   npm run build:packages
#   npm run preflight
#   bash scripts/publish-first.sh <otp-code>

set -euo pipefail

otp="${1:?Usage: bash scripts/publish-first.sh <otp-code>}"

pkgs=(core runtime models browser sessions agent adapters mcp server sdk cli)

echo "Publishing ${#pkgs[@]} packages with OTP..."
echo ""

for pkg in "${pkgs[@]}"; do
  echo "→ @husk-ai/$pkg"
  npm publish --workspace="@husk-ai/$pkg" --access public --otp="$otp"
done

echo ""
echo "All ${#pkgs[@]} packages published."
echo ""
echo "Next: configure Trusted Publishing on each package at npmjs.com so"
echo "future releases publish via CI without a token."
