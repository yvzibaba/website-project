#!/usr/bin/env bash
# 补齐：① 跟随 301 重定向重取 ② 搜索正确 slug
set -uo pipefail
OUT="research/github-round2"
mkdir -p "$OUT"

echo "=== A. 跟随重定向重取（-L） ==="
REDIR=(
  "NREL/ssc" "NREL/pysam" "NREL/sam" "NREL/reV"
  "NREL/REopt_API" "NREL/REopt.jl" "NREL-Sienna/Sienna"
  "GenXProject/GenX" "calcom/cal.com" "NREL/EnergyPlus"
)
for full in "${REDIR[@]}"; do
  slug="${full//\//_}"
  f="$OUT/meta_${slug}.json"
  final=$(curl -sSL --max-time 30 -o "$f" -w '%{http_code}|%{url_effective}' \
    -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/$full" 2>/dev/null)
  echo "$final"
  sleep 0.4
done

echo
echo "=== B. 搜索正确 slug ==="
for q in "citrineos" "storagevet"; do
  curl -sS --max-time 30 -o "$OUT/search_r2_${q}.json" -w "%{http_code}  $q\n" \
    -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/search/repositories?q=${q}&sort=stars&per_page=8" 2>/dev/null
  sleep 2
done

echo "--- 完成 ---"
