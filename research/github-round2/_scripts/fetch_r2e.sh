#!/usr/bin/env bash
# 第二轮检索：排除 awesome 清单污染，加语言/星级限定
set -uo pipefail
OUT="research/github-round2"

# q 编号 -> query（预编码）
declare -a Q=(
  "battery+storage+dispatch+optimization+language%3APython+stars%3A%3E30+-awesome+-book"
  "energy+management+system+EMS+language%3ATypeScript+stars%3A%3E5"
  "OCPP+charging+station+management+system+stars%3A%3E30+-awesome"
  "heavy+duty+truck+charging+depot+stars%3A%3E2+-awesome"
  "site+energy+optimization+PV+storage+EV+charging+stars%3A%3E8+-awesome"
  "project+finance+model+energy+cash+flow+stars%3A%3E5+-awesome"
  "microgrid+techno-economic+optimization+stars%3A%3E15+-awesome"
  "load+profile+time+series+energy+language%3ATypeScript+stars%3A%3E3"
  "solar+PV+simulation+language%3ATypeScript+stars%3A%3E5+-awesome"
  "fleet+electrification+charging+infrastructure+planning+stars%3A%3E2+-awesome"
)
i=0
for q in "${Q[@]}"; do
  i=$((i+1))
  curl -sS --max-time 40 -o "$OUT/s2_q${i}.json" -w "%{http_code}  s2_q${i}\n" \
    -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=10" 2>/dev/null
  sleep 7
done
echo "--- 完成 ---"
