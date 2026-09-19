#!/usr/bin/env bash
# 第三轮检索：不使用 -awesome（会清零），改为客户端过滤
set -uo pipefail
OUT="research/github-round2"
declare -a Q=(
  "battery+storage+dispatch+optimization+language%3APython+stars%3A%3E30"
  "energy+management+system+language%3ATypeScript+stars%3A%3E5"
  "OCPP+charging+station+management+stars%3A%3E30"
  "heavy+duty+truck+charging+depot"
  "site+energy+optimization+PV+storage+EV+charging+stars%3A%3E5"
  "project+finance+model+energy+cash+flow"
  "microgrid+techno-economic+optimization+stars%3A%3E15"
  "load+profile+time+series+energy+language%3ATypeScript+stars%3A%3E3"
  "solar+PV+simulation+language%3ATypeScript+stars%3A%3E5"
  "fleet+electrification+charging+infrastructure+planning"
)
i=0
for q in "${Q[@]}"; do
  i=$((i+1))
  curl -sS --max-time 40 -o "$OUT/s3_q${i}.json" -w "%{http_code}  s3_q${i}\n" \
    -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=10" 2>/dev/null
  sleep 7
done
echo "--- 完成 ---"
