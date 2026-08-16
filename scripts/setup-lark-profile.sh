#!/usr/bin/env bash
# setup-lark-profile.sh — create (or refresh) the `lark` DSH profile and
# install the @jmoksz/lark-bridge plugin (this repository root) into it.
#
#   DSH_HOME=/path/to/home ./scripts/setup-lark-profile.sh
#
# DSH_HOME defaults to ~/.dsh. The plugin bundle is self-contained (persona +
# bridge row live in its own cordis.patch.yml), so no separate patch layer is
# needed — this script only installs the plugin.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${DSH_HOME:=$HOME/.dsh}"
PROFILE="lark"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PLUGIN_DIR="$REPO_ROOT"

command -v dsh >/dev/null 2>&1 || { echo "error: dsh not found on PATH" >&2; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "error: pnpm not found on PATH" >&2; exit 1; }

echo "==> DSH_HOME:   $DSH_HOME"
echo "==> profile:    $PROFILE_DIR"
echo "==> plugin:     $PLUGIN_DIR"

# Install the plugin with the `file:` protocol (copied into the profile tree).
# `dsh plugin` initializes the profile on first use, forwards to pnpm, and
# adds @jmoksz/lark-bridge to dsh.profile.bundles because it declares dsh.bundle.
# A previous installation is removed first so re-running refreshes the copy.
if [ -f "$PROFILE_DIR/package.json" ] && grep -q '"@jmoksz/lark-bridge"' "$PROFILE_DIR/package.json"; then
  echo "==> refreshing existing @jmoksz/lark-bridge installation"
  DSH_HOME="$DSH_HOME" dsh plugin --profile "$PROFILE" remove @jmoksz/lark-bridge
fi
# --ignore-scripts: the lark SDK's protobufjs postinstall is unnecessary (the
# SDK ships prebuilt protobuf bundles) and pnpm v11 exits nonzero on ignored
# builds, which would abort the script. Run `pnpm approve-builds` inside the
# profile directory if you prefer to allow it.
DSH_HOME="$DSH_HOME" dsh plugin --profile "$PROFILE" add "file:$PLUGIN_DIR" --ignore-scripts

echo
echo "==> done. Configure your Feishu app (see the repo README), then run:"
echo "    LARK_APP_ID=cli_xxx LARK_APP_SECRET=xxx dsh --profile $PROFILE"
echo "    (set LARK_WORKSPACE to the directory the agent should work in;"
echo "     it defaults to the launching directory)"
echo
echo "==> 同事一键安装（无需本仓库）:"
echo "    dsh plugin --profile lark add github:JMOKSZ/dsh-lark-bridge --ignore-scripts"
