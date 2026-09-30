#!/usr/bin/env bash
# Checks the arbor-models core plugin against a real core in a scratch folder: turning plugins on in a running core
# loads it, even one that arrived after the core started, an extra model is listed, reaches a Claude account instead of "unknown provider", can't override a
# built-in model, and follows config edits without a restart. A second copy serves Codex the way Arbor installs one per
# provider, and each copy has to keep its own models. It uses the core release in core-version.txt (the archive in bundled-core/ if the release script left one,
# otherwise a download checked against the release's checksums), fake Claude and Codex accounts, and a proxy on a closed local
# port, so no request leaves the machine with a credential. It never touches the app's data folder.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/arbor-models-check.XXXXXX")"
core_pid=""
cleanup() {
  if [[ -n "$core_pid" ]]; then kill "$core_pid" 2>/dev/null || true; wait "$core_pid" 2>/dev/null || true; fi
  rm -rf "$work_dir"
}
trap cleanup EXIT

case "$(uname -m)" in
  arm64) arch="aarch64" ;;
  x86_64) arch="amd64" ;;
  *) echo "Unsupported Mac architecture: $(uname -m)" >&2; exit 1 ;;
esac

cd "$repo_dir"
core_version="$(tr -d '[:space:]' < core-version.txt)"
core_version="${core_version#v}"
core_asset="CLIProxyAPI_${core_version}_darwin_${arch}.tar.gz"

echo "Building the plugin"
cargo build --quiet --release --locked --manifest-path core-plugins/arbor-models/Cargo.toml
plugin_lib="core-plugins/arbor-models/target/release/libarbor_models.dylib"
# A library named by an absolute path would put the build machine's folders in the release, and could make the loader
# treat the per-provider copies as one.
install_name="$(otool -D "$plugin_lib" | tail -n 1)"

core_dir="$work_dir/core"
mkdir -p "$core_dir/plugins" "$work_dir/auths"
if [[ -f "bundled-core/$core_asset" ]]; then
  tar -xzf "bundled-core/$core_asset" -C "$core_dir"
else
  echo "Downloading core $core_version"
  release_url="https://github.com/router-for-me/CLIProxyAPI/releases/download/v${core_version}"
  curl -fsSL --retry 3 -o "$work_dir/$core_asset" "$release_url/$core_asset"
  curl -fsSL --retry 3 -o "$work_dir/checksums.txt" "$release_url/checksums.txt"
  expected="$(awk -v name="$core_asset" '{ file = $2; sub(/^\*/, "", file); if (file == name) { print tolower($1); exit } }' "$work_dir/checksums.txt")"
  actual="$(shasum -a 256 "$work_dir/$core_asset" | awk '{ print tolower($1) }')"
  if [[ -z "$expected" || "$expected" != "$actual" ]]; then
    echo "The core download doesn't match its checksum." >&2
    exit 1
  fi
  tar -xzf "$work_dir/$core_asset" -C "$core_dir"
fi

port="$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
dead_port="$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
client_key="arbor-check-client"
management_key="arbor-check-management"

cat > "$work_dir/auths/claude-check.json" <<'JSON'
{"type":"claude","email":"check@example.invalid","access_token":"not-a-real-token","refresh_token":"not-a-real-token","expired":"2099-01-01T00:00:00Z","last_refresh":"2026-01-01T00:00:00Z"}
JSON
cat > "$work_dir/auths/codex-check.json" <<'JSON'
{"type":"codex","email":"check@example.invalid","access_token":"not-a-real-token","refresh_token":"not-a-real-token","account_id":"not-a-real-account","expired":"2099-01-01T00:00:00Z","last_refresh":"2026-01-01T00:00:00Z"}
JSON

write_base_config() {
  cat > "$core_dir/config.yaml" <<YAML
config-version: 8
server:
  host: 127.0.0.1
  port: $port
management:
  allow-remote: false
  secret-key: "$management_key"
access:
  api-keys:
    - "$client_key"
requests:
  proxy-url: "http://127.0.0.1:$dead_port"
oauth:
  auth-dir: $work_dir/auths
plugins:
$1
YAML
}
# Claude's models, then Codex's for the second copy.
write_config() {
  write_base_config "  enabled: true
  configs:
    arbor-models:
      enabled: true
      priority: 1
      provider: claude
      models:
$1
    arbor-models-codex:
      enabled: true
      priority: 1
      provider: codex
      models:
$2"
}

# As a first run leaves it: plugins off. The plugin file only arrives once the core is running, as it does when an
# Arbor update finds the core already up.
write_base_config "  enabled: false"

failures=0
check() {
  if [[ "$2" == "yes" ]]; then echo "ok    $1"; else echo "FAIL  $1"; failures=$((failures + 1)); fi
}
models_json() {
  curl -s -m 10 -H "x-api-key: $client_key" -H "anthropic-version: 2023-06-01" "http://127.0.0.1:$port/v1/models"
}
# The OpenAI-style list, which has every provider's models; the Anthropic-style one above has only Claude's.
all_models_json() {
  curl -s -m 10 -H "Authorization: Bearer $client_key" "http://127.0.0.1:$port/v1/models"
}
has_model() {
  all_models_json | python3 -c 'import json, sys; ids = [m.get("id") for m in json.load(sys.stdin).get("data", [])]; print("yes" if sys.argv[1] in ids else "no")' "$1"
}
owned_by() {
  all_models_json | python3 -c 'import json, sys; print(next((m.get("owned_by", "") for m in json.load(sys.stdin).get("data", []) if m.get("id") == sys.argv[1]), ""))' "$1"
}
# Whether one account's own list has a model: what that account can be sent.
account_has_model() {
  curl -s -m 10 -H "Authorization: Bearer $management_key" "http://127.0.0.1:$port/v0/management/auth-files/models?name=$1" \
    | python3 -c 'import json, sys; ids = [m.get("id") for m in json.load(sys.stdin).get("models", [])]; print("yes" if sys.argv[1] in ids else "no")' "$2"
}
display_name() {
  models_json | python3 -c 'import json, sys; print(next((m.get("display_name", "") for m in json.load(sys.stdin).get("data", []) if m.get("id") == sys.argv[1]), ""))' "$1"
}
message_error() {
  curl -s -m 30 -X POST "http://127.0.0.1:$port/v1/messages" -H "x-api-key: $client_key" \
    -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
    -d "{\"model\":\"$1\",\"max_tokens\":5,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
}
chat_error() {
  curl -s -m 30 -X POST "http://127.0.0.1:$port/v1/chat/completions" -H "Authorization: Bearer $client_key" \
    -H "content-type: application/json" -d "{\"model\":\"$1\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
}
wait_for_model() {
  for _ in $(seq 1 30); do
    [[ "$(has_model "$1")" == "$2" ]] && return 0
    sleep 0.5
  done
  return 0
}

(cd "$core_dir" && exec ./cli-proxy-api -config "$core_dir/config.yaml" > "$work_dir/core.log" 2>&1) &
core_pid=$!
for _ in $(seq 1 60); do
  curl -s -o /dev/null -m 1 "http://127.0.0.1:$port/" && break
  sleep 0.5
done
check "with plugins off, the model isn't there" "$([[ "$(has_model claude-sonnet-5-5)" == "no" ]] && echo yes || echo no)"
check "the plugin's library isn't named by a path on this Mac" "$([[ "$install_name" == @rpath/* ]] && echo yes || echo no)"

# Copies, not links: the core skips links, and a link would be the same library.
cp "$plugin_lib" "$core_dir/plugins/arbor-models.dylib"
cp "$plugin_lib" "$core_dir/plugins/arbor-models-codex.dylib"

write_config "        - id: claude-sonnet-5-5
          display-name: Claude Sonnet 5.5
          context-length: 1000000
          thinking:
            levels: [low, medium, high]
            dynamic-allowed: true
        - id: claude-sonnet-5
          display-name: Arbor check override" "        - id: gpt-arbor-check
          display-name: GPT Arbor Check
          context-length: 272000
          thinking:
            levels: [low, medium, high, xhigh]"
wait_for_model claude-sonnet-5-5 yes
wait_for_model gpt-arbor-check yes
check "the plugin loads when plugins are turned on" "$(grep -q 'plugin registered plugin_id=arbor-models' "$work_dir/core.log" && echo yes || echo no)"
check "the management API lists the plugin" "$(curl -s -m 10 -H "Authorization: Bearer $management_key" "http://127.0.0.1:$port/v0/management/plugins" | grep -q '"arbor-models"' && echo yes || echo no)"
check "an extra model is listed" "$(has_model claude-sonnet-5-5)"
check "an extra model reaches the Claude account" "$(message_error claude-sonnet-5-5 | grep -q 'unknown provider' && echo no || echo yes)"
check "an unlisted model is still unknown" "$(message_error claude-sonnet-9-9 | grep -q 'unknown provider' && echo yes || echo no)"
check "a built-in model keeps its own details" "$([[ "$(display_name claude-sonnet-5)" != "Arbor check override" ]] && echo yes || echo no)"
check "the Codex copy loads as its own plugin" "$(grep -q 'plugin registered plugin_id=arbor-models-codex' "$work_dir/core.log" && echo yes || echo no)"
check "a Codex extra model is listed as OpenAI's" "$([[ "$(owned_by gpt-arbor-check)" == "openai" ]] && echo yes || echo no)"
check "a Claude extra model is still Anthropic's" "$([[ "$(owned_by claude-sonnet-5-5)" == "anthropic" ]] && echo yes || echo no)"
check "each copy keeps its own models: Claude's account" "$([[ "$(account_has_model claude-check.json claude-sonnet-5-5)" == "yes" && "$(account_has_model claude-check.json gpt-arbor-check)" == "no" ]] && echo yes || echo no)"
check "each copy keeps its own models: Codex's account" "$([[ "$(account_has_model codex-check.json gpt-arbor-check)" == "yes" && "$(account_has_model codex-check.json claude-sonnet-5-5)" == "no" ]] && echo yes || echo no)"
check "a Codex extra model reaches the Codex account" "$(chat_error gpt-arbor-check | grep -q 'unknown provider' && echo no || echo yes)"
check "an unlisted Codex model is still unknown" "$(chat_error gpt-arbor-unlisted | grep -q 'unknown provider' && echo yes || echo no)"

write_config "        - id: claude-opus-6
          display-name: Claude Opus 6" "        - id: gpt-arbor-check-2"
wait_for_model claude-opus-6 yes
wait_for_model gpt-arbor-check-2 yes
check "an added model appears without a restart" "$(has_model claude-opus-6)"
wait_for_model claude-sonnet-5-5 no
check "a removed model goes away without a restart" "$([[ "$(has_model claude-sonnet-5-5)" == "no" ]] && echo yes || echo no)"
check "built-in models stay" "$(has_model claude-sonnet-5)"
wait_for_model gpt-arbor-check no
check "each copy follows its own edits" "$([[ "$(has_model gpt-arbor-check-2)" == "yes" && "$(has_model gpt-arbor-check)" == "no" ]] && echo yes || echo no)"

if (( failures > 0 )); then
  echo "$failures check(s) failed. The core's log:" >&2
  grep -E 'pluginhost|arbor-models|reload' "$work_dir/core.log" >&2 || true
  exit 1
fi
echo "All checks passed against core $core_version."
