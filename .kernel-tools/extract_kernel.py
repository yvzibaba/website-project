#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
⚠ 已废弃（R9.1，2026-09-18）—— 请改用 `.kernel-tools/verify_kernel.mjs`（`npm run kernel:verify`）。

【为什么废弃】
本脚本的模型是「从 `src/` 做传递闭包，把文件**复制**进 `kernel/`」——
那是一次性引导工具，适用于「内核的副本还躺在 src/ 里」的阶段。

R9.1 之后主从关系反转：`kernel/` 成为**单一真源**，`src/` 下的 39 份副本已删除。
此时本脚本会从 `src/` 找不到任何种子文件，于是**正常退出并打印「[1] 内核种子文件: 0」**——
它不报错、不返回非零码。如果谁把它接进 CI，就会得到一个**绿色的假通过**：
校验什么都没查，却显示一切正常。这比没有守卫更危险。

【替代品的能力更强】
`verify_kernel.mjs` 从 `kernel/src/` 出发做**反向校验**：框架依赖 / 反向宿主依赖 /
悬空引用 / 白名单外依赖，违规时 exit 1。它还剥离注释后再扫描，避免把「头注里引用的
反例 import 字面量」误报为违规（本仓已实测踩中此坑）。

本文件保留不改，作为「引导期工具」的历史记录。请勿再执行 `--apply`：
它会用 src/ 的旧内容**覆盖** kernel/ 中已解耦的新版本。

────────────────────────────────────────────────────────────
以下为原始说明：

把领域内核从现有项目中抽离成一个自包含、框架无关的包。

策略：从 34 个内核文件出发，对 '@/...' 内部引用做**传递闭包**，
把所有必需文件按原路径复制到 kernel/src/ 下。
由于原路径结构（src/server、src/lib）被保留，只要把 tsconfig 的
'@/*' 别名重新指向 kernel/src/*，所有 import 就无需改动一行。

用法：
    python extract_kernel.py <repo_root> [--apply]
不带 --apply 时只打印计划（dry-run）。
"""

import os
import re
import shutil
import sys

KERNEL_KEYWORDS = (
    "sandbox", "parameter-engine", "scoring", "case-scores", "research-pipeline",
    "scout", "model-router", "deepseek-provider", "solution-generation", "solution-body",
)

IMP_RE = re.compile(r"""from\s+['"]([^'"]+)['"]""")

# 只允许这些包作为外部依赖（框架无关的白名单）
ALLOWED_EXTERNAL = {"zod", "@prisma/client", "node:crypto", "node:util", "crypto", "util"}


def find_kernel_seeds(files):
    out = []
    for f in files:
        base = os.path.basename(f)
        if not f.endswith((".ts", ".tsx")):
            continue
        if not f.startswith("src/"):
            continue
        if any(k in base for k in KERNEL_KEYWORDS):
            out.append(f)
    return sorted(out)


def resolve_local(imp, from_file):
    """把 '@/x' 或相对路径解析成仓库内路径（不含扩展名候选）。返回候选列表。"""
    if imp.startswith("@/"):
        return ["src/" + imp[2:]]
    if imp.startswith("."):
        base = os.path.normpath(os.path.join(os.path.dirname(from_file), imp))
        return [base]
    return []


def try_extensions(cand, allset):
    for ext in ("", ".ts", ".tsx", ".mjs", ".js", "/index.ts", "/index.tsx"):
        p = cand + ext
        if p in allset:
            return p
    return None


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    root = sys.argv[1]
    apply_ = "--apply" in sys.argv
    os.chdir(root)

    files = []
    for dirpath, dirnames, filenames in os.walk("src"):
        dirnames[:] = [d for d in dirnames if d != "node_modules"]
        for fn in filenames:
            files.append(os.path.join(dirpath, fn).replace(os.sep, "/"))
    allset = set(files)

    seeds = find_kernel_seeds(files)
    print(f"[1] 内核种子文件: {len(seeds)}")

    # ---------- 传递闭包 ----------
    needed, queue = set(seeds), list(seeds)
    external = {}
    while queue:
        cur = queue.pop()
        try:
            src = open(cur, encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        for m in IMP_RE.finditer(src):
            imp = m.group(1)
            cands = resolve_local(imp, cur)
            if cands:
                hit = None
                for c in cands:
                    hit = try_extensions(c, allset)
                    if hit:
                        break
                if hit and hit not in needed:
                    needed.add(hit)
                    queue.append(hit)
                elif not hit:
                    print(f"    ⚠ 未解析: {imp}  (来自 {cur})")
            else:
                external[imp] = external.get(imp, 0) + 1

    # ---------- 写出 ----------
    print(f"[2] 依赖闭包总计: {len(needed)} 个文件")
    print(f"[3] 仍然依赖的外部包:")
    bad = []
    for k, v in sorted(external.items(), key=lambda x: -x[1]):
        flag = "" if k in ALLOWED_EXTERNAL else "   ⚠ 不在白名单"
        if flag:
            bad.append(k)
        print(f"      {v:3d}x  {k}{flag}")

    extra = sorted(needed - set(seeds))
    print(f"[4] 闭包额外带入的支撑文件: {len(extra)}")
    for e in extra:
        print(f"      {e}")

    if bad:
        print(f"\n⚠ 存在 {len(bad)} 个白名单外的外部依赖: {bad}")
        print("  这些需要在新底座里提供，或改写掉。")

    if not apply_:
        print("\n(dry-run，未写入任何文件；加 --apply 执行)")
        return 0

    dest_root = "kernel"
    for f in sorted(needed):
        dst = os.path.join(dest_root, f)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(f, dst)
    print(f"\n[5] 已复制 {len(needed)} 个文件 → {dest_root}/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
