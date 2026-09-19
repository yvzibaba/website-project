#!/usr/bin/env node
/**
 * 悬空引用普查 —— `npm run kernel:dangling`
 *
 * 用途：**任何批量搬文件之后**，先跑这个，再跑 typecheck。
 *
 * 为什么值得单独有个工具：搬文件时最容易漏的不是「主要目录」的 `@/` 导入，而是
 *   ① **相对路径**导入（`../../src/server/project-model`）—— 别名 codemod 碰不到它们；
 *   ② **边缘目录**（`scripts/`、`prisma/`、根级脚本）—— 它们不在 `src/` 下，最容易被漏。
 * 这两类加起来，实测在本次内核单源化中造成 13 处断链，全部要到 `tsc --noEmit` 才暴露。
 * 本工具把这些缺口**一次列全**，比反复跑 typecheck 试错快得多。
 *
 * 输出分三类：
 *   【A】可在内核中找到落点 → 可直接改写成 `@app/kernel/...`
 *   【B】内核里也没有      → 真删了或路径算错，需人工判定
 *   【C】非 src/ 前缀      → 指向本仓之外的相对路径，通常说明路径算错了
 *
 * 退出码：0 = 无悬空；1 = 有悬空（可接 CI）
 *
 * 用法：
 *   node .kernel-tools/survey_dangling_refs.mjs [repoRoot]
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = process.argv[2] && !process.argv[2].startsWith("--")
  ? process.argv[2]
  : process.cwd();
process.chdir(ROOT);

const SKIP_DIRS = new Set([
  "node_modules", ".next", ".git", ".kernel-tools", "kernel", "dist", "build", "coverage",
]);
const SCAN_DIRS = ["src", "tests", "scripts", "prisma"];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name).replace(/\\/g, "/");
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      walk(p, out);
    } else if (/\.(ts|tsx|mts|js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 与 TypeScript / Vite 一致的候选后缀展开 */
function exists(p) {
  for (const c of [p, p + ".ts", p + ".tsx", p + "/index.ts", p + "/index.tsx", p + ".js", p + ".mjs"]) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/** 把 import 说明符归一成「仓库相对路径」；返回 null 表示这是外部包，不归本工具管 */
function normalize(spec, fromFile) {
  if (spec.startsWith("@/")) return "src/" + spec.slice(2);
  if (spec.startsWith("@app/kernel/")) return "kernel/src/" + spec.slice("@app/kernel/".length);
  if (spec.startsWith(".")) {
    return path.normalize(path.join(path.dirname(fromFile), spec)).replace(/\\/g, "/");
  }
  return null;
}

const RE = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

const files = SCAN_DIRS.flatMap((d) => walk(d));
const A = new Map(); // 可在内核找到
const B = new Map(); // 内核也没有
const C = new Map(); // 非 src/ 前缀
let scanned = 0;

for (const f of files) {
  const text = fs.readFileSync(f, "utf8");
  for (const m of text.matchAll(RE)) {
    const spec = m[1];
    const asPath = normalize(spec, f);
    if (!asPath) continue;
    scanned++;
    if (exists(asPath)) continue;

    const bucket = asPath.startsWith("kernel/src/")
      ? A
      : asPath.startsWith("src/")
        ? (exists("kernel/" + asPath) ? A : B)
        : C;
    if (!bucket.has(spec)) bucket.set(spec, []);
    bucket.get(spec).push(f);
  }
}

const emit = (title, map, hint) => {
  console.log("");
  console.log(`${title}: ${map.size} 种`);
  if (hint && map.size) console.log(`  ${hint}`);
  for (const [s, w] of [...map.entries()].sort()) {
    console.log(`  ${String(w.length).padStart(3)}x  ${s}    e.g. ${w[0]}`);
  }
};

console.log(`扫描 ${files.length} 个文件（${SCAN_DIRS.join(" / ")}），本地引用 ${scanned} 处`);
emit("【A】可从内核落点修复", A, "→ 可改写为 @app/kernel/<模块>");
emit("【B】内核中也没有（真断链）", B);
emit("【C】路径不在 src//kernel 下（路径算错？）", C);

const bad = A.size + B.size + C.size;
console.log("");
if (bad) {
  console.log(`✗ 共 ${bad} 种悬空引用。修完再跑 tsc --noEmit。`);
  process.exit(1);
}
console.log("✓ 无悬空引用。");
process.exit(0);
