#!/usr/bin/env node
// 汇总 research/github-round2/tree_*.json 的规模构成（blob 数 / 测试文件数 / CI 数 / 顶层目录）
// 用法：node summarize_trees.mjs [repoRoot]   默认 repoRoot = 仓库根
import fs from "node:fs";
import path from "node:path";
const root = process.argv[2] ?? ".";
const dir = path.join(root, "research/github-round2");
for (const f of fs.readdirSync(dir).filter(x => x.startsWith("tree_") && x.endsWith(".json"))) {
  const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  const t = j.tree ?? [];
  const blobs = t.filter(x => x.type === "blob");
  const ext = {};
  for (const b of blobs) { const e = (b.path.split(".").pop() || "?").toLowerCase(); ext[e] = (ext[e] || 0) + 1; }
  const top = Object.entries(ext).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}:${v}`).join(" ");
  const testf = t.filter(x => /(^|\/)(test|tests|__tests__)\//i.test(x.path)).length;
  const ci = t.filter(x => x.path.startsWith(".github/workflows/")).length;
  console.log(f.replace("tree_", "").replace(".json", "").padEnd(38),
    `blobs=${blobs.length}`, `testdir=${testf}`, `ci=${ci}`, "|", top);
}
