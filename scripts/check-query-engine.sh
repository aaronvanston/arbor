#!/usr/bin/env bash
# Checks the DuckDB release that crates/session-tables is pinned to, on this machine: downloads its command-line
# program for this system from DuckDB's GitHub releases, holds it to the SHA-256 and size in src/store.rs, runs it,
# then runs the tests that write and read Parquet with it, the crate's and the archive's (they check nothing without
# a program, since a test never fetches one). On a Mac it also says whether macOS would stop the program: it has to be signed, and a
# file fetched this way, as Arbor fetches it, must carry no quarantine mark. Run it after changing the pinned release
# (`mac-build engine-check` runs it on the Mac). Everything stays in a scratch folder that is removed at the end.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
store_rs="$repo_dir/crates/session-tables/src/store.rs"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/query-engine-check.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) target="macos-aarch64" ;;
  Darwin-x86_64) target="macos-x86_64" ;;
  Linux-x86_64) target="linux-x86_64" ;;
  Linux-aarch64) target="linux-aarch64" ;;
  *) echo "No DuckDB program is pinned for $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

version="$(sed -n 's/^pub const DUCKDB_VERSION: &str = "\(.*\)";$/\1/p' "$store_rs")"
pinned="$(grep -F "(\"$target\"," "$store_rs" | tr -d ' "()_' )"
IFS=, read -r _ asset sha256 size _ <<<"$pinned"
# tr took the underscores out of the size only: an archive's name has none.
if [[ -z "$version" || -z "$asset" || ! "$sha256" =~ ^[0-9a-f]{64}$ || ! "$size" =~ ^[0-9]+$ ]]; then
  echo "Couldn't read the pinned release for $target from $store_rs" >&2
  exit 1
fi

echo "Downloading DuckDB $version ($asset)"
curl --fail --silent --show-error --location --max-filesize $((size + 1)) \
  --output "$work_dir/$asset" "https://github.com/duckdb/duckdb/releases/download/v$version/$asset"
got_size="$(wc -c < "$work_dir/$asset" | tr -d ' ')"
if command -v sha256sum >/dev/null; then got_sha="$(sha256sum "$work_dir/$asset" | cut -d' ' -f1)"; else got_sha="$(shasum -a 256 "$work_dir/$asset" | cut -d' ' -f1)"; fi
if [[ "$got_size" != "$size" || "$got_sha" != "$sha256" ]]; then
  echo "The download isn't the pinned one: $got_size bytes, SHA-256 $got_sha" >&2
  exit 1
fi
mkdir "$work_dir/engine"
tar -xzf "$work_dir/$asset" -C "$work_dir/engine" duckdb
engine="$work_dir/engine/duckdb"

if [[ "$(uname -s)" == "Darwin" ]]; then
  if xattr -p com.apple.quarantine "$engine" >/dev/null 2>&1; then
    echo "The program carries a quarantine mark, so macOS would ask before running it" >&2
    exit 1
  fi
  codesign --verify --strict "$engine"
  echo "Signed by: $(codesign -dvv "$engine" 2>&1 | sed -n 's/^Authority=//p' | head -n 1)"
  # Says whether the program is notarized as well; a program with no quarantine mark runs either way.
  echo "Gatekeeper: $(spctl --assess --type execute --verbose "$engine" 2>&1 | tr '\n' ' ' || true)"
fi

answer="$("$engine" -no-agent -no-init -bail -json -c "SELECT version() AS version, 6 * 7 AS answer")"
echo "It runs: $answer"
[[ "$answer" == *"v$version"* && "$answer" == *'"answer":42'* ]] || { echo "That isn't DuckDB $version" >&2; exit 1; }

cd "$repo_dir"
SESSION_TABLES_DUCKDB="$engine" cargo test --locked --manifest-path crates/session-tables/Cargo.toml store
# The archive's own test with the engine. Tauri needs the web UI's folder to exist, so it gets an empty stand-in.
mkdir -p dist
[[ -f dist/index.html ]] || touch dist/index.html
SESSION_TABLES_DUCKDB="$engine" cargo test --locked --manifest-path src-tauri/Cargo.toml archive::analytics
echo "DuckDB $version writes and reads the tables on $target"
