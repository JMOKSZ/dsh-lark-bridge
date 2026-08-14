#!/usr/bin/env bash
# setup-lark-profile.sh — create (or refresh) the `lark` DSH profile and
# install the @dsh/lark-bridge plugin from this repository into it.
#
#   DSH_HOME=/path/to/home ./scripts/setup-lark-profile.sh
#
# DSH_HOME defaults to ~/.dsh. The script:
#   1. initializes $DSH_HOME/profiles/lark via `dsh plugin`,
#   2. installs the local lark-bridge package (its dsh.bundle declaration
#      makes `dsh plugin` add it to the profile's bundle layer),
#   3. installs the profile patch layer (persona + bridge config).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${DSH_HOME:=$HOME/.dsh}"
PROFILE="lark"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PLUGIN_DIR="$REPO_ROOT/lark-bridge"
PATCH_SRC="$REPO_ROOT/lark/cordis.patch.yml"

command -v dsh >/dev/null 2>&1 || { echo "error: dsh not found on PATH" >&2; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "error: pnpm not found on PATH" >&2; exit 1; }

echo "==> DSH_HOME:   $DSH_HOME"
echo "==> profile:    $PROFILE_DIR"
echo "==> plugin:     $PLUGIN_DIR"

# 1+2. Initialize the profile and install the plugin.
# `dsh plugin` forwards the remaining arguments to pnpm inside the profile
# directory and reconciles dsh.profile.bundles afterwards; because lark-bridge
# declares dsh.bundle, it joins the bundle layer automatically. The plugin is
# installed with the `file:` protocol (copied into the profile tree) so its
# runtime imports resolve to the same in-box @deepseek-ai/* packages the
# profile itself uses. A previous installation is removed first so re-running
# this script always refreshes the plugin copy.
if [ -f "$PROFILE_DIR/package.json" ] && grep -q '"@dsh/lark-bridge"' "$PROFILE_DIR/package.json"; then
  echo "==> refreshing existing @dsh/lark-bridge installation"
  DSH_HOME="$DSH_HOME" dsh plugin --profile "$PROFILE" remove @dsh/lark-bridge
fi
# --ignore-scripts: the lark SDK's protobufjs postinstall is unnecessary (the
# SDK ships prebuilt protobuf bundles) and pnpm v11 exits nonzero on ignored
# builds, which would abort the script. Run `pnpm approve-builds` inside the
# profile directory if you prefer to allow it.
DSH_HOME="$DSH_HOME" dsh plugin --profile "$PROFILE" add "file:$PLUGIN_DIR" --ignore-scripts

# 3. Install the profile patch layer.
cp "$PATCH_SRC" "$PROFILE_DIR/cordis.patch.yml"
echo "==> wrote $PROFILE_DIR/cordis.patch.yml"

echo
echo "==> done. Configure your Feishu app (see the repo README), then run:"
echo "    LARK_APP_ID=cli_xxx LARK_APP_SECRET=xxx dsh --profile $PROFILE"
echo "    (set LARK_WORKSPACE to the directory the agent should work in;"
echo "     it defaults to the launching directory)"
