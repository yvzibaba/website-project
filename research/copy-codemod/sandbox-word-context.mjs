import fs from "node:fs";
import path from "node:path";

const roots = ["src", "kernel/src"];
const out = new Map();

function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*");
}

function scan(f) {
  const lines = fs.readFileSync(f, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!line.includes("沙盘")) return;
    if (isCommentLine(line)) return; // 注释不计（P6 只约束用户可见文案）
    let idx = -1;
    while ((idx = line.indexOf("沙盘", idx + 1)) !== -1) {
      const s = Math.max(0, idx - 5);
      const e = Math.min(line.length, idx + 2 + 6);
      const key = line.slice(s, e).replace(/\s+/g, " ").trim();
      if (!out.has(key)) out.set(key, []);
      out.get(key).push(f + ":" + (i + 1));
    }
  });
}

function walk(d) {
  for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, ent.name);
    if (ent.isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(ent.name)) scan(p);
  }
}

for (const r of roots) walk(r);

const arr = [...out.entries()].sort((a, b) => b[1].length - a[1].length);
console.log("共 " + arr.length + " 种上下文：\n");
for (const [k, v] of arr) {
  console.log("[" + v.length + "] ..." + k + "...   e.g. " + v[0]);
}
let total = 0;
for (const [, v] of arr) total += v.length;
console.log("\n非注释行命中总计: " + total);
