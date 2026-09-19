set -uo pipefail
OUT="research/github-round2"
for pair in "NatLabRockies/REopt_API:NatLabRockies_REopt_API.json" "NatLabRockies/REopt.jl:NatLabRockies_REopt.jl.json"; do
  full="${pair%%:*}"; base="${pair##*:}"
  code=$(curl -sS --max-time 60 -o "$OUT/tree_${base}" -w '%{http_code}' \
    -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/$full/git/trees/master?recursive=1" 2>/dev/null)
  echo "$code  $full"
  sleep 0.4
done
