set -uo pipefail
OUT="research/github-round2"
# 元数据 + 文件树（2 次 API）
curl -sS --max-time 30 -o "$OUT/meta_NatLabRockies_hdev.json" -w 'meta %{http_code}\n' \
  -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/NatLabRockies/hdev-depot-charging-2021" 2>/dev/null
sleep 0.5
curl -sS --max-time 40 -o "$OUT/tree_NatLabRockies_hdev.json" -w 'tree %{http_code}\n' \
  -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/NatLabRockies/hdev-depot-charging-2021/git/trees/main?recursive=1" 2>/dev/null
# README（raw，不计配额）
for b in main master; do
  code=$(curl -sS --max-time 25 -o "$OUT/readme_hdev.md" -w '%{http_code}' "https://raw.githubusercontent.com/NatLabRockies/hdev-depot-charging-2021/$b/README.md" 2>/dev/null)
  if [ "$code" = "200" ]; then echo "readme($b) 200"; break; fi
done
