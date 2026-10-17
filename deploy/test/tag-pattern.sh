#!/usr/bin/env bash
# Each bootstrap accepts only a whole release tag (deploy/lib/pack-release.ts's pattern).
#   bash deploy/test/tag-pattern.sh
set -u
here="$(cd "$(dirname "$0")/.." && pwd)"
bad=0
check() { # script prefix
  eval "$(grep -E '^valid_tag\(\)' "$here/$1")"
  for t in "$2-598b0c5" "$2-598b0c5c1f21ec60769799cfb1f6c5c3f0710ca0"; do
    valid_tag "$t" || { echo "FAIL $1 refuses $t"; bad=1; }
  done
  for t in "$2-598b0c5/../../x" "$2-598b0c5 x" "$2-abc" "$2-598b0c5XYZ" "$2-" "other-598b0c5" "$2-598b0c5c1f21ec60769799cfb1f6c5c3f0710ca0a"; do
    if valid_tag "$t" 2>/dev/null; then echo "FAIL $1 accepts '$t'"; bad=1; fi
  done
  unset -f valid_tag
}
check bootstrap-shlink-dicom.sh server
check bootstrap-sandbox.sh sandbox
[ "$bad" = 0 ] && echo "ok   both bootstraps accept only whole release tags"
exit "$bad"
