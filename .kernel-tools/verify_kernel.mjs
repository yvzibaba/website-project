#!/usr/bin/env node
/**
 * 内核守卫（kernel guard）—— `npm run kernel:verify`
 *
 * ## 它守的是什么
 *
 * 内核的唯一价值主张是「**换底座不动内核**」。这句话只有在一条硬约束被持续守住时才成立：
 *
 *   > 内核**不得**依赖任何框架（next / react / next-auth / UI / Route Handler），
 *   > 也**不得**反向 import 宿主（`@/...`）。
 *
 * 一旦有人在内核里写下一行 `import { auth } from "@/auth"`，整个主张当场作废——
 * 而且是**静默作废**：typecheck 不会报错，测试全部照常通过，只有到了换底座那天才炸。
 * 本脚本就是为这条「静默失效」而设的守卫。
 *
 * ## 为什么替换掉原来的 extract_kernel.py
 *
 * 原脚本的职责是「从 `src/` 做传递闭包，把文件**复制**进 kernel/」——那是**一次性引导工具**。
 * R9.1 之后主从关系反转：kernel 成为单一真源、`src/` 的副本已删除。
 * 此时原脚本的模型已失效（它会从 src/ 找不到任何种子，静默报「0 个文件」，造成
 * 「校验通过」的假象——这正是最危险的一类守卫）。故改为**反向校验器**。
 *
 * ## 退出码
 * 0 = 通过；1 = 发现违规（可接 CI）
 *
 * 用法：
 *   node .kernel-tools/verify_kernel.mjs [repoRoot] [--verbose]
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = process.argv[2] && !process.argv[2].startsWith("--")
  ? process.argv[2]
  : process.cwd();
process.chdir(ROOT);

const VERBOSE = process.argv.includes("--verbose");

/** 内核允许的外部依赖白名单。新增条目必须同时说明理由并写入 docs/ai-rules/03-KERNEL.md。 */
const ALLOWED_EXTERNAL = new Set([
  "zod",
  "@prisma/client",
  "node:crypto",
  "node:util",
  "node:path",
  "node:fs",
  "node:url",
]);

/** 一旦在 kernel 中出现即为违规（哪怕只是类型引用）。 */
const FORBIDDEN = /^(next|next\/|react|react-dom|next-auth|\@\/)/;

const KROOT = "kernel/src";

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name).replace(/\\/g, "/");
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts)$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * 剥离注释后再扫描。
 * 为什么必须做：内核头注里为了讲清「为什么不能这么写」而**引用了反例 import 的字面量**，
 * 不做剥离会把注释当代码报出假违规（已实测踩中，见 docs/ai-rules/05-TESTING.md 陷阱清单）。
 */
function stripComments(src) {
  let s = src.replace(/\/\*[\s\S]*?\*\//g, "");
  s = s
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");
  return s;
}

const RE_SPEC = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
const RE_RELATIVE = /^\.\.?(\/|$)/;

function resolveInKernel(spec, fromFile) {
  let base;
  if (spec.startsWith("@app/kernel/")) {
    base = path.join(KROOT, spec.slice("@app/kernel/".length));
  } else if (RE_RELATIVE.test(spec)) {
    base = path.normalize(path.join(path.dirname(fromFile), spec)).replace(/\\/g, "/");
  } else {
    return null;
  }
  for (const c of [base, base + ".ts", base + ".tsx", base + "/index.ts", base + "/index.tsx"]) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

const files = walk(KROOT).sort();
const violations = [];
const externals = new Map();
let totalSpecs = 0;

for (const f of files) {
  const raw = fs.readFileSync(f, "utf8");
  const code = stripComments(raw);
  for (const m of code.matchAll(RE_SPEC)) {
    const spec = m[1];
    totalSpecs++;

    if (spec.startsWith("@app/kernel")) {
      if (!resolveInKernel(spec, f)) {
        violations.push({ f, spec, kind: "内核内引用无法解析（悬空）" });
      }
      continue;
    }
    if (RE_RELATIVE.test(spec)) {
      if (!resolveInKernel(spec, f)) {
        violations.push({ f, spec, kind: "相对引用无法解析（悬空）" });
      }
      continue;
    }
    if (FORBIDDEN.test(spec)) {
      violations.push({ f, spec, kind: "框架/宿主反向依赖（严禁）" });
      continue;
    }
    externals.set(spec, (externals.get(spec) || 0) + 1);
    if (!ALLOWED_EXTERNAL.has(spec)) {
      violations.push({ f, spec, kind: "白名单外的外部依赖" });
    }
  }
}

/* ── 报告 ── */
console.log("内核守卫 · 框架无关性校验");
console.log("─".repeat(58));
console.log(`内核文件数      : ${files.length}`);
console.log(`导入语句数      : ${totalSpecs}`);
console.log("");
console.log("外部依赖：");
const sorted = [...externals.entries()].sort((a, b) => b[1] - a[1]);
if (!sorted.length) console.log("  （无）");
for (const [k, v] of sorted) {
  const ok = ALLOWED_EXTERNAL.has(k);
  console.log(`  ${ok ? "✓" : "✗"} ${String(v).padStart(3)}x  ${k}`);
}
console.log("");
if (VERBOSE) {
  console.log("内核文件清单：");
  for (const f of files) console.log("  " + f);
  console.log("");
}

if (violations.length) {
  console.log(`✗ 发现 ${violations.length} 处违规：`);
  for (const v of violations) {
    console.log(`  [${v.kind}] ${v.f}  →  "${v.spec}"`);
  }
  console.log("");
  console.log("这些违规意味着「换底座不动内核」的主张已失效。修法见 docs/ai-rules/03-KERNEL.md。");
  process.exit(1);
}

console.log("✓ 通过：内核零框架依赖，未反向引用宿主，白名单外依赖 0 个。");
process.exit(0);
