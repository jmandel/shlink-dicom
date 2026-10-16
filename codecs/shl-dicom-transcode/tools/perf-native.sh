#!/usr/bin/env bash
# Native throughput of every transcode stage, single-core (taskset) and threaded.
#   tools/perf-native.sh PERF_BINARY DIR [REPEATS] > results.jsonl
# Each line: the perf example's JSON plus "cores" and the load average at the start.
set -euo pipefail
bin=$1 dir=$2 n=${3:-5}
for ts in 1.2.840.10008.1.2.4.70 1.2.840.10008.1.2.4.90; do
  for mode in encode decode transcode; do
    for cores in 1 all; do
      load=$(cut -d' ' -f1 /proc/loadavg)
      if [ "$cores" = 1 ]; then out=$(taskset -c 5 "$bin" "$dir" "$ts" "$mode" "$n"); else out=$("$bin" "$dir" "$ts" "$mode" "$n"); fi
      echo "${out%\}},\"cores\":\"$cores\",\"load\":$load}"
    done
  done
done
