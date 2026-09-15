import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * V1.1 Phase 3 · 公开界面黑话守卫（de-jargon guard）。
 *
 * 目的：防止内部口径（宪法/总控条款号、流水线角色名、批次编号、枚举直印等）回流到
 * **用户可见文案**。只扫「会渲染给人看的字符串」：
 *   - src/app 与 src/components 下的 .tsx/.ts（服务端 route handler `src/app/api/**` 无 UI 文案，排除）
 *   - 排除管理后台（路径含 admin，工作人员工具保留内部口径——P3 裁决）
 *   - 剥除注释（`//`、`/* *\/`、JSX `{/* *\/}`）后，仅提取：
 *       ① 双引号/单引号字符串字面量
 *       ② 不含 `${` 插值的模板字面量
 *       ③ 顶层 JSX 元素之间的纯文本（`>` 与 `<` 之间，且不含 `{`）
 *
 * 命中 = 该文案里出现禁用 token → 失败并列出文件:行。
 * 白名单（非文案的函数/组件名，P3 记录在案）：
 *   - `sandbox-solution` 模块名（`buildSandboxSolutionDraft` 等函数名不是文案）。
 *
 * 新增内部术语进入用户可见层的正确做法：改文案为人话；确需内部术语展示 → 放管理后台。
 */

const ROOT = path.resolve(__dirname, "../..");

/** 禁用 token（对提取出的用户可见字符串做子串/正则匹配） */
const BANNED: Array<[label: string, re: RegExp]> = [
  ["宪法", /宪法/],
  ["总控", /总控/],
  ["占位假设", /占位假设/],
  ["创始人裁决", /创始人裁决/],
  ["db:seed", /db:seed/],
  ["整链重算", /整链重算/],
  ["发布守卫", /发布守卫/],
  ["Δ_sto", /Δ_sto|Δ sto/],
  ["E1–E8 编号", /E[1-8][-–]E?[1-8]/],
  ["S1/S5/E7 场景编号", /（\s*(S\d|E\d)\s*|[(（][SE]\d[)）]/],
  ["G1/G2 缺口编号", /(^|[^A-Za-z0-9])G[12]([^0-9A-Za-z]|$)/],
  ["V1-A/V1-B", /V1-[AB]\b/],
  ["§ 条款号", /§\s*\d/],
  ["流水线", /流水线/],
  ["n 候选", /\d+\s*候选/],
  ["Bull", /Bull/],
  ["Bear", /Bear/],
  ["Judge", /Judge/],
  ["QA", /(^|[^A-Za-z])QA([^A-Za-z]|$)/],
  ["Research", /Research/],
  ["Solution Package", /Solution Package/],
  ["Solution.body", /Solution\.body/],
  ["requireStaffWrite", /requireStaffWrite/],
  ["?demo=1 指令", /[?&]demo=1\s*(查看|打开|模式)/],
  // 注：evidenceKind/FACT/ASSUMPTION 枚举直印在案例详情页仍有数据层渲染（枚举值属数据不属文案），
  //     待 P3 收尾的「证据等级展示层」专项清洗后再纳入禁用。
];

function walk(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (/node_modules|\.next/.test(p)) continue;
      out.push(...walk(p));
    } else if (/\.(tsx|ts)$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

function stripComments(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => "\n".repeat((m.match(/\n/g) ?? []).length))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => "\n".repeat((m.match(/\n/g) ?? []).length))
    .replace(/^\s*\/\/.*$/gm, "")
    // 行尾 // 注释（避开 URL 的 :// 与字符串内含 // 的常见误伤：要求前面不是冒号）
    .replace(/([^:"'`])\/\/[^\n]*/g, "$1");
}

/** 从（已剥注释的）源码中提取「用户可见文案」候选段，返回 [{line, text}] */
function extractUserFacing(src: string): Array<{ line: number; text: string }> {
  const hits: Array<{ line: number; text: string }> = [];
  const lines = src.split("\n");
  lines.forEach((line, i) => {
    // ① 引号字符串字面量
    const strRe = /"([^"\n]*)"|'([^'\n]*)'/g;
    let m: RegExpExecArray | null;
    while ((m = strRe.exec(line))) {
      hits.push({ line: i + 1, text: m[1] ?? m[2] ?? "" });
    }
    // ② 简单模板字面量（不含插值才提取）
    if (!/\$\{/.test(line)) {
      const tplRe = /`([^`\n]*)`/g;
      while ((m = tplRe.exec(line))) hits.push({ line: i + 1, text: m[1] });
    }
    // ③ 顶层 JSX 文本：> … < 之间、不含 { 的纯文本
    const jsxRe = />([^<>{}]+)</g;
    while ((m = jsxRe.exec(line))) hits.push({ line: i + 1, text: m[1] });
    // ③b 多行 JSX 文本行：整行去掉缩进后不含任何代码符号且含中文 → 视为渲染文本。
    {
      const t = line.trim();
      if (
        /^[^<>{}()=\[\]`"'/*;:-]/.test(t) &&
        /[\u4e00-\u9fff]/.test(t) &&
        !/[=();{}<>`"`]/.test(t)
      ) {
        hits.push({ line: i + 1, text: t });
      }
    }
  });
  return hits;
}

describe("de-jargon guard · 公开界面（src/app + src/components，除 admin/api）不得出现内部黑话", () => {
  const files = [...walk(path.join(ROOT, "src", "app")), ...walk(path.join(ROOT, "src", "components"))]
    .filter((f) => !/[\\/]admin[\\/]/i.test(f))
    .filter((f) => !f.includes(path.join("src", "app", "api")));

  it("参与扫描的公开文件数合理（防止路径过滤失效导致空扫）", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("全部用户可见文案不含禁用 token", () => {
    const violations: string[] = [];
    for (const f of files) {
      const src = stripComments(fs.readFileSync(f, "utf8"));
      const rel = path.relative(ROOT, f);
      for (const { line, text } of extractUserFacing(src)) {
        if (!text.trim()) continue;
        for (const [label, re] of BANNED) {
          if (re.test(text)) {
            violations.push(`${rel}:${line} [${label}] ${text.trim().slice(0, 80)}`);
            break;
          }
        }
      }
    }
    expect(
      violations,
      `发现 ${violations.length} 处内部黑话进入用户可见文案：\n${violations.slice(0, 40).join("\n")}`
    ).toEqual([]);
  });
});
