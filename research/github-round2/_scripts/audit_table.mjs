import fs from 'fs';
import path from 'path';
const dir = 'C:/Users/宇子/WorkBuddy/2026-09-18-20-46-44/research/github-round2';
const files = fs.readdirSync(dir).filter(f=>f.startsWith('meta_')&&f.endsWith('.json'));
const rows=[];
for(const f of files){
  let j; try{ j=JSON.parse(fs.readFileSync(path.join(dir,f),'utf8')); }catch(e){ rows.push({file:f,err:e.message}); continue; }
  rows.push({
    file:f, full:j.full_name, stars:j.stargazers_count, forks:j.forks_count,
    lang:j.language, lic:(j.license&&j.license.spdx_id)||'NONE',
    pushed:(j.pushed_at||'').slice(0,10), created:(j.created_at||'').slice(0,10),
    issues:j.open_issues_count, size:j.size, archived:j.archived,
    desc:(j.description||'').slice(0,90)
  });
}
rows.sort((a,b)=>(b.stars||0)-(a.stars||0));
for(const r of rows){
  console.log([r.full,r.stars,r.forks,r.lang,r.lic,r.pushed,r.archived?'ARCHIVED':'',r.desc].join(' | '));
}
console.log('TOTAL',rows.length);
