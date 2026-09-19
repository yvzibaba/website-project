import fs from 'node:fs';
const dir='research/github-round2';
const rows=[];
for(const f of fs.readdirSync(dir).filter(x=>x.startsWith('meta_'))){
  let j; try{ j=JSON.parse(fs.readFileSync(dir+'/'+f,'utf8')); }catch{ rows.push({f,err:'parse'}); continue; }
  if(j.message&&!j.full_name){ rows.push({f,err:j.message}); continue; }
  rows.push({
    repo:j.full_name,
    stars:j.stargazers_count, forks:j.forks_count,
    lic:j.license?(j.license.spdx_id||j.license.key):'NONE',
    lang:j.language||'-',
    pushed:(j.pushed_at||'').slice(0,10),
    created:(j.created_at||'').slice(0,10),
    arch:j.archived?'ARCHIVED':'-',
    size:j.size, issues:j.open_issues_count,
    topics:(j.topics||[]).slice(0,6).join(','),
    desc:(j.description||'').slice(0,90),
  });
}
rows.sort((a,b)=>(b.stars||0)-(a.stars||0));
const pad=(s,n)=>String(s??'').padEnd(n).slice(0,n);
console.log(pad('REPO',40)+pad('STARS',8)+pad('FORKS',7)+pad('LICENSE',14)+pad('LANG',12)+pad('PUSHED',12)+pad('SIZE',8)+'ARCH');
console.log('-'.repeat(115));
for(const r of rows){
  if(r.err){ console.log(pad(r.f,40)+'  ERROR: '+r.err); continue; }
  console.log(pad(r.repo,40)+pad(r.stars,8)+pad(r.forks,7)+pad(r.lic,14)+pad(r.lang,12)+pad(r.pushed,12)+pad(r.size,8)+r.arch);
}
console.log('\n=== 描述 ===');
for(const r of rows){ if(!r.err) console.log(`- ${r.repo}: ${r.desc}`); }
