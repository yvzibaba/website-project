import fs from "node:fs";
import path from "node:path";

/**
 * P6 文案收口 codemod：把用户可见/代码字符串里的「沙盘」替换为决策平台语义。
 *
 * 安全设计（沿用本项目 P-1 的实测教训）：
 *   1. 规则按「模式长度降序」自动排序 → 保证最长匹配优先，避免
 *      「决策沙盘」把「可视化决策沙盘报告」吃掉这类静默折叠。
 *   2. 只改非纯注释行（P6 约束的是产品文案，注释不在约束内）。
 *   3. 不触碰任何英文标识符与持久化字面量（沙盘是中文，天然不冲突）。
 *   4. **验收靠计数对账**，不靠"跑通了"：输出改前/改后非注释命中数与逐条变更。
 *   5. --dry 只报告不写盘。
 */

const WORD = "沙盘";

const RULES = [
  // 产品名
  ["光储充投资决策沙盘", "光储充项目投资决策平台"],
  ["光储充重卡沙盘", "光储充重卡决策平台"],
  // 报告标题
  ["产业项目可视化决策沙盘报告", "产业项目可视化决策报告"],
  ["产业项目沙盘报告", "产业项目决策报告"],
  ["可视化决策沙盘报告", "可视化决策报告"],
  // 复合「决策沙盘」
  ["产业项目决策沙盘", "产业项目决策平台"],
  ["新能源决策沙盘", "新能源决策平台"],
  ["可视化决策沙盘", "可视化决策平台"],
  ["决策沙盘", "决策平台"],
  // 「沙盘X」名词短语
  ["确定性沙盘模型", "确定性决策模型"],
  ["沙盘产业项目方案", "决策产业项目方案"],
  ["沙盘决策模型", "项目决策模型"],
  ["现金流沙盘", "现金流决策模型"],
  ["沙盘结果页", "决策结果页"],
  ["沙盘工作台", "决策工作台"],
  ["沙盘主流程", "决策主流程"],
  ["沙盘主情景", "决策主情景"],
  ["沙盘推演生成", "平台推演生成"],
  ["沙盘默认占位假设", "平台默认占位假设"],
  ["沙盘全局默认参数", "平台全局默认参数"],
  ["沙盘的真实输出", "平台的真实输出"],
  ["沙盘基础 UI", "平台基础 UI"],
  ["沙盘方案", "决策方案"],
  ["沙盘项目", "决策项目"],
  ["沙盘情景", "决策情景"],
  ["沙盘报告", "决策报告"],
  ["沙盘结论", "决策结论"],
  ["沙盘版本", "决策版本"],
  ["沙盘引擎", "决策引擎"],
  ["沙盘模型", "决策模型"],
  ["沙盘模式", "决策模式"],
  ["沙盘参数", "决策参数"],
  ["沙盘超限", "决策超限"],
  ["沙盘入参", "决策入参"],
  ["沙盘预设", "平台预设"],
  ["沙盘当前", "平台当前"],
  ["沙盘左侧", "平台左侧"],
  ["沙盘页", "决策页"],
  ["沙盘侧", "平台侧"],
  // 方位 / 介词短语
  ["进沙盘", "进平台"],
  ["回沙盘", "回平台"],
  ["沙盘内", "平台内"],
  ["沙盘里", "平台里"],
  ["沙盘中", "平台中"],
  ["本沙盘", "本平台"],
  // 兜底
  [WORD, "决策平台"],
];

/** 最长模式优先，保证不出现「短模式先吃掉长模式」的静默折叠。 */
const ORDERED = [...RULES].sort((a, b) => b[0].length - a[0].length);

function isPureComment(line) {
  const t = line.trim();
  return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*");
}

function countNonComment(content) {
  let n = 0;
  for (const line of content.split(/\r?\n/)) {
    if (!line.includes(WORD)) continue;
    if (isPureComment(line)) continue;
    let i = -1;
    while ((i = line.indexOf(WORD, i + 1)) !== -1) n++;
  }
  return n;
}

const dry = process.argv.includes("--dry");
const roots = ["src", "kernel/src"];
const files = [];

function walk(d) {
  for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, ent.name);
    if (ent.isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(ent.name)) files.push(p);
  }
}
for (const r of roots) walk(r);

let beforeTotal = 0;
let afterTotal = 0;
let touched = 0;
const changeLog = new Map();

for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const before = countNonComment(src);
  if (before === 0) continue;
  beforeTotal += before;

  const outLines = [];
  for (const line of src.split(/\r?\n/)) {
    if (!line.includes(WORD) || isPureComment(line)) {
      outLines.push(line);
      continue;
    }
    let next = line;
    let hits = 0;
    for (const [pat, rep] of ORDERED) {
      if (!next.includes(pat)) continue;
      const parts = next.split(pat);
      hits += parts.length - 1;
      next = parts.join(rep);
    }
    if (hits > 0) {
      const key = line.trim().slice(0, 90) + "  ⇒  " + next.trim().slice(0, 90);
      changeLog.set(key, (changeLog.get(key) || 0) + 1);
    }
    outLines.push(next);
  }
  const nextContent = outLines.join("\n");
  const after = countNonComment(nextContent);
  afterTotal += after;
  touched++;
  if (after !== 0) console.log("⚠ 残留非注释命中 " + after + " 处 → " + f);
  if (!dry) fs.writeFileSync(f, nextContent);
}

console.log("=== 变更样例（去重后） ===");
let shown = 0;
for (const [k, n] of changeLog) {
  if (shown++ >= 200) break;
  console.log("  (" + n + ") " + k);
}
console.log("\n去重后变更种类: " + changeLog.size);
console.log("涉及文件: " + touched);
console.log("非注释命中  改前: " + beforeTotal + "  改后: " + afterTotal + (dry ? "   [DRY RUN，未写盘]" : ""));
