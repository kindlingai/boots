#!/bin/sh
# Packages a compiled ai-bootstrap binary for release:
#   linux   ai-bootstrap-<version>-<target>.tar.gz  holding ai-bootstrap
#   macOS   ai-bootstrap-<version>-<target>.sh      a self-extracting script that
#                                                   writes ai-bootstrap next to itself
#                                                   (a binary written by a script is
#                                                   not quarantined)
#   windows ai-bootstrap-<version>-<target>.zip     holding ai-bootstrap.exe
# The binary inside keeps the plain name.
#
# usage: scripts/package.sh <target> <compiled binary> <output dir>
set -eu
target=$1 bin=$2 out=$3
version=$(sed -n 's/^ *"version": *"\(.*\)",*$/\1/p' "$(dirname "$0")/../deno.json")
name="ai-bootstrap-$version-$target"
mkdir -p "$out"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
case "$target" in
  *linux*)
    cp "$bin" "$stage/ai-bootstrap"
    chmod 755 "$stage/ai-bootstrap"
    tar -czf "$out/$name.tar.gz" -C "$stage" ai-bootstrap
    ;;
  *windows*)
    cp "$bin" "$stage/ai-bootstrap.exe"
    (cd "$stage" && zip -q -9 ai.zip ai-bootstrap.exe)
    mv "$stage/ai.zip" "$out/$name.zip"
    ;;
  *darwin*)
    # The payload starts on the line after __PAYLOAD__.
    {
      cat <<SH
#!/bin/sh
# ai-bootstrap $version ($target). Run: sh \$0
# Writes the ai-bootstrap binary next to this script and prints its path.
set -e
dir=\$(cd "\$(dirname "\$0")" && pwd)
out="\$dir/ai-bootstrap"
line=\$(awk '/^__PAYLOAD__\$/ { print NR + 1; exit }' "\$0")
tail -n +"\$line" "\$0" | gunzip > "\$out.part"
chmod 755 "\$out.part"
xattr -d com.apple.quarantine "\$out.part" 2>/dev/null || true
# Apple silicon runs only signed code; deno signs ad hoc, re-sign if that broke.
if command -v codesign >/dev/null && ! codesign --verify "\$out.part" 2>/dev/null; then
  codesign --force --sign - "\$out.part"
fi
mv -f "\$out.part" "\$out"
echo "Extracted."
echo "\$out"
exit 0
__PAYLOAD__
SH
      gzip -9 -n -c "$bin"
    } > "$out/$name.sh"
    chmod 755 "$out/$name.sh"
    ;;
  *) echo "unknown target $target" >&2; exit 1 ;;
esac
