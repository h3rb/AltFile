#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
manifest="$root/src-tauri/Cargo.toml"
target_dir="${CARGO_TARGET_DIR:-$root/src-tauri/target}"
bin="$target_dir/release/altfileexplorer"

version="$(sed -n 's/^version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest" | head -n1)"
if [[ -z "${version:-}" ]]; then
  echo "Could not read the version from $manifest" >&2
  exit 1
fi

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  echo "Building release executable..."
  cargo build --release --manifest-path "$manifest"
fi

if [[ ! -x "$bin" ]]; then
  echo "Executable not found at $bin" >&2
  exit 1
fi

arch="$(uname -m)"
name="AltFileExplorer-${version}-linux-${arch}"
out="$root/dist/$name"
tarball="$root/dist/$name.tar.gz"

rm -rf "$out"
mkdir -p "$out"

install -m 755 "$bin" "$out/altfileexplorer"
cp "$root/README.md" "$out/README.md"
cp "$root/LICENSE" "$out/LICENSE"
cat > "$out/portable.txt" <<'EOF'
Alt File Explorer portable build
Keep portable.txt next to the altfileexplorer binary to store settings,
session and thumbnails in the "data" folder beside the executable.
Requires WebKitGTK and GTK 3 runtime libraries. ffmpeg and pdftoppm enable
video and PDF thumbnails when installed.
EOF

rm -f "$tarball"
tar -C "$root/dist" -czf "$tarball" "$name"

echo
echo "Portable build ready:"
echo "  Folder: $out"
echo "  Tarball: $tarball"
