#!/usr/bin/env bash
# ① 抓关键仓库完整文件树 ② 8 组主动检索 ③ 把搜索结果里的完整仓库对象落盘
set -uo pipefail
OUT="research/github-round2"
mkdir -p "$OUT"

echo "=== ① 文件树 ==="
TREE=(
  "boxyhq/saas-starter-kit"
  "ixartz/SaaS-Boilerplate"
  "citrineos/citrineos-core"
  "NatLabRockies/REopt.jl"
  "NatLabRockies/REopt_API"
  "pvlib/pvlib-python"
  "EVerest/EVerest"
  "mobilityhouse/ocpp"
)
for full in "${TREE[@]}"; do
  slug="${full//\//_}"
  meta="$OUT/meta_${slug}.json"
  br="main"
  if [ -f "$meta" ]; then
    b=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$meta','utf8')).default_branch||'main')}catch(e){console.log('main')}")
    [ -n "$b" ] && br="$b"
  fi
  code=$(curl -sS --max-time 60 -o "$OUT/tree_${slug}.json" -w '%{http_code}' \
    -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/$full/git/trees/${br}?recursive=1" 2>/dev/null)
  echo "$code  $full  (branch=$br)"
  sleep 0.4
done

echo
echo "=== ② 主动检索（搜索配额独立） ==="
QS=(
  "energy+management+system+open+source+in:name,description,readme"
  "battery+energy+storage+optimization+in:name,description,readme"
  "electric+vehicle+charging+station+management+in:name,description,readme"
  "techno-economic+analysis+renewable+energy+project+in:name,description,readme"
  "heavy+duty+truck+charging+in:name,description,readme"
  "megawatt+charging+system+in:name,description,readme"
  "pv+storage+ev+charging+site+optimization+in:name,description,readme"
  "energy+project+finance+cashflow+model+in:name,description,readme"
)
i=0
for q in "${QS[@]}"; do
  i=$((i+1))
  curl -sS --max-time 40 -o "$OUT/search_r2_q${i}.json" -w "%{http_code}  q${i}\n" \
    -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=12" 2>/dev/null
  # 搜索配额 10/min（未认证），留足间隔
  sleep 7
done

echo "--- 完成 ---"
ls "$OUT" | wc -l
