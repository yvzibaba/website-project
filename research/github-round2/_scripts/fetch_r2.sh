#!/usr/bin/env bash
# V2 第二轮 GitHub 底座审计 · 批量元数据抓取（28 个候选）
# 用法： bash ~/.workbuddy/skills/github-via-ghelper/scripts/ghproxy.sh bash _tools/fetch_r2.sh
set -uo pipefail

OUT="research/github-round2"
mkdir -p "$OUT"

REPOS=(
  # A. EMS / 充电基础设施
  "openems/openems"
  "EVerest/EVerest"
  "thoughtworks/CitrineOS"
  "mobilityhouse/ocpp"
  "steve-community/steve"
  # B. PV / 储能 / 仿真
  "pvlib/pvlib-python"
  "NREL/ssc"
  "NREL/pysam"
  "NREL/sam"
  "epri-dev/StorageVET"
  "NREL/reV"
  # C. 优化 / 能源系统建模
  "NREL/REopt_API"
  "NREL/REopt.jl"
  "PyPSA/PyPSA"
  "oemof/oemof-solph"
  "calliope-project/calliope"
  "NREL-Sienna/Sienna"
  "GenXProject/GenX"
  # D. SaaS / 产品底座
  "boxyhq/saas-starter-kit"
  "ixartz/SaaS-Boilerplate"
  "vercel/nextjs-subscription-payments"
  "makeplane/plane"
  "twentyhq/twenty"
  "nocodb/nocodb"
  "calcom/cal.com"
  "t3-oss/create-t3-app"
  # E. 其他
  "NREL/EnergyPlus"
)

for full in "${REPOS[@]}"; do
  slug="${full//\//_}"
  f="$OUT/meta_${slug}.json"
  code=$(curl -sS --max-time 25 -o "$f" -w '%{http_code}' \
    -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/$full" 2>/dev/null)
  echo "$code  $full"
  sleep 0.4
done

echo "--- 抓取完成 ---"
ls "$OUT" | wc -l
