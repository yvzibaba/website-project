set -uo pipefail
t(){ 
  local label="$1"; shift
  local n
  n=$(curl -sS --max-time 30 -H 'Accept: application/vnd.github+json' \
     "https://api.github.com/search/repositories?q=$1&per_page=3" 2>/dev/null \
     | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log('total='+j.total_count+' | '+(j.items||[]).slice(0,2).map(r=>r.full_name+'('+r.stargazers_count+')').join(', '))}catch(e){console.log('ERR '+s.slice(0,120))}})")
  echo "$label  ->  $n"
  sleep 7
}
t "A 纯关键词"        "battery+storage+dispatch+optimization"
t "B +language"       "battery+storage+optimization+language%3APython"
t "C +stars"          "battery+storage+optimization+stars%3A%3E30"
t "D +排除awesome"    "battery+storage+optimization+-awesome"
t "E 组合"            "battery+storage+optimization+language%3APython+stars%3A%3E30"
