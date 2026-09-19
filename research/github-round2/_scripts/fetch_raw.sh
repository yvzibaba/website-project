set -uo pipefail
OUT="research/github-round2"
F=(
  "NatLabRockies/REopt_API/master/LICENSE|lic_REopt_API.txt"
  "NatLabRockies/REopt.jl/master/LICENSE|lic_REopt.jl.txt"
  "boxyhq/saas-starter-kit/main/package.json|mf_boxyhq_package.json"
  "boxyhq/saas-starter-kit/main/prisma/schema.prisma|mf_boxyhq_schema.prisma"
  "ixartz/SaaS-Boilerplate/main/package.json|mf_ixartz_package.json"
  "citrineos/citrineos-core/main/package.json|mf_citrineos_package.json"
  "NatLabRockies/REopt.jl/master/Project.toml|mf_reoptjl_Project.toml"
  "pvlib/pvlib-python/main/pyproject.toml|mf_pvlib_pyproject.toml"
)
for pair in "${F[@]}"; do
  p="${pair%%|*}"; o="${pair##*|}"
  code=$(curl -sS --max-time 30 -o "$OUT/$o" -w '%{http_code}' "https://raw.githubusercontent.com/$p" 2>/dev/null)
  echo "$code  $o"
done
