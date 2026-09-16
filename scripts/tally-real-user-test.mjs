#!/usr/bin/env node
// scripts/tally-real-user-test.mjs
// 真实用户测试·计分器（配套 docs/REAL_USER_VALIDATION_V1_1.md §6 A–F 门槛 + §10 决策矩阵）
//
// 这个脚本只做一件事：把「主持人逐人手填的观察表 CSV」按验证设计里的门槛聚合成通过率与红线判定。
// 它【不联网、不碰数据库、不生成任何用户数据】——所有数字都来自你在 CSV 里如实记录的真实观察。
//
// 反伪造护栏（刻意设计，宁拒不假）：
//   1) 样本 < 8 → 拒绝（§2 要求 8–12 人，样本不足不下结论）
//   2) 模板示例行（recorder=EXAMPLE_DO_NOT_TALLY 或 user_id 以 EXAMPLE 开头）→ 自动剔除；若剔除后无真实行 → 拒绝
//   3) 任一必填判定位空/非法值 → 拒绝（不允许用空白蒙混过关）
//   4) ≥2 行「判定位完全逐字段相同」→ 判定疑似复制/伪造 → 拒绝
//   5) 全体判定位完全一致（零方差）→ 打「高度可疑·请核对是否真逐人记录」硬警告
//   6) 标 real_lead=yes 却无 lead_ref 凭证 → 拒绝（F 判据要能被后台 /admin/leads 反查）
//   7) 未加 --confirm-real 确认「数据来自真实当场产生」→ 只算不裁：不输出结论建议，只出过程量
//
// 铁律：本脚本【绝不自行宣布商业成功】。它输出的是「证据汇总 + §10 矩阵映射的建议分支」，
//       最终是否通过、下一步做什么，一律交创始人裁决（见项目宪法）。
//
// 用法：
//   node scripts/tally-real-user-test.mjs <观察表.csv> [--confirm-real]
//   npm run test:tally -- docs/real_user_test/filled-YYYYMMDD.csv --confirm-real

import fs from "node:fs";
import path from "node:path";

const MIN_SAMPLE = 8;
const GATE_STRONG = 0.75; // A/B/D
const GATE_MID = 0.6; //   C/E

const argv = process.argv.slice(2);
const flagConfirm = argv.includes("--confirm-real");
const file = argv.find((a) => !a.startsWith("--"));

function die(msg) {
  console.error(`\n[拒绝统计] ${msg}\n`);
  process.exit(2);
}
function warn(msg) {
  console.warn(`  ! ${msg}`);
}

if (!file) die("缺少观察表 CSV 路径。用法：node scripts/tally-real-user-test.mjs <观察表.csv> [--confirm-real]");
const abs = path.resolve(process.cwd(), file);
if (!fs.existsSync(abs)) die(`找不到文件：${abs}`);

// ---- 极简 RFC4180 CSV 解析（支持带引号、内含逗号/换行的字段）----
function parseCSV(text) {
  const rows = [];
  let field = "", row = [], inQ = false;
  // 去 BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* skip */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

const raw = fs.readFileSync(abs, "utf8");
const table = parseCSV(raw);
if (table.length < 2) die("CSV 只有表头或为空，没有任何数据行。");

const header = table[0].map((h) => h.trim());
const need = [
  "user_id","persona","device","q1_understood","five_min_done","core_results_understood_count",
  "independent_params_changed","next_step_found","real_lead","lead_ref","q5_distrust_metric",
  "q8_honesty_reaction","storage_notfound_redflag","truckcount_misread_redflag","recorder",
];
const missing = need.filter((c) => !header.includes(c));
if (missing.length) die(`表头缺少必要列：${missing.join(", ")}（请从 OBSERVATION_TEMPLATE.csv 复制表头，勿改列名）`);
const idx = Object.fromEntries(header.map((h, i) => [h, i]));
const cell = (r, c) => (idx[c] != null ? String(r[idx[c]] ?? "").trim() : "");

const PASSED = new Set(["pass", "yes", "是"]);
const FAILED = new Set(["fail", "no", "否"]);
const yn = (v) => (PASSED.has(v.toLowerCase()) ? true : FAILED.has(v.toLowerCase()) ? false : null);

const allRows = table.slice(1);
const isExample = (r) => {
  const rid = cell(r, "user_id").toUpperCase();
  const rec = cell(r, "recorder");
  return rid.startsWith("EXAMPLE") || /EXAMPLE_DO_NOT_TALLY/.test(rec);
};

const exampleCount = allRows.filter(isExample).length;
const rows = allRows.filter((r) => !isExample(r));

console.log(`\n=== 真实用户测试计分器 ===`);
console.log(`文件：${path.relative(process.cwd(), abs) || abs}`);
console.log(`数据行：${allRows.length}（剔除模板示例行 ${exampleCount} 行）→ 真实记录 ${rows.length} 行`);

if (rows.length === 0) die("剔除示例行后没有任何真实记录，拒绝下结论。");
if (rows.length < MIN_SAMPLE) die(`真实记录仅 ${rows.length} 人 < 最低样本 ${MIN_SAMPLE} 人（§2 要求 8–12）。样本不足，不做通过与否判定。`);

// ---- 逐行判定 A–F + 红线 + 必填校验 ----
const scored = rows.map((r) => {
  const uid = cell(r, "user_id") || "(无名)";
  const A = yn(cell(r, "q1_understood"));
  const B = yn(cell(r, "five_min_done"));
  const cc = cell(r, "core_results_understood_count");
  const Ccount = Number(cc);
  const C = Number.isInteger(Ccount) && Ccount >= 0 && Ccount <= 5 ? Ccount >= 3 : null;
  const dc = cell(r, "independent_params_changed");
  const Dcount = Number(dc);
  const D = Number.isInteger(Dcount) && Dcount >= 0 ? Dcount >= 2 : null;
  const E = yn(cell(r, "next_step_found"));
  const lead = yn(cell(r, "real_lead"));
  const q5 = cell(r, "q5_distrust_metric");
  const q8 = cell(r, "q8_honesty_reaction").toLowerCase();
  const stNF = yn(cell(r, "storage_notfound_redflag"));
  const tkMS = yn(cell(r, "truckcount_misread_redflag"));
  const persona = cell(r, "persona");
  const leadRef = cell(r, "lead_ref");

  const problems = [];
  if (A === null) problems.push(`q1_understood 非 pass/fail：“${cell(r, "q1_understood")}”`);
  if (B === null) problems.push(`five_min_done 非 pass/fail：“${cell(r, "five_min_done")}”`);
  if (C === null) problems.push(`core_results_understood_count 非 0–5 整数：“${cc}”`);
  if (D === null) problems.push(`independent_params_changed 非整数：“${dc}”`);
  if (E === null) problems.push(`next_step_found 非 pass/fail：“${cell(r, "next_step_found")}”`);
  if (lead === null) problems.push(`real_lead 非 yes/no：“${cell(r, "real_lead")}”`);
  if (!q5) problems.push(`q5_distrust_metric 未记录（§6 要求逐人有记录，无质疑也要写“无”）`);
  if (!["a", "b", "c"].includes(q8)) problems.push(`q8_honesty_reaction 须为 a/b/c：“${cell(r, "q8_honesty_reaction")}”`);
  if (stNF === null) problems.push(`storage_notfound_redflag 非 yes/no`);
  if (tkMS === null) problems.push(`truckcount_misread_redflag 非 yes/no`);
  if (lead === true && !leadRef) problems.push(`标 real_lead=yes 但 lead_ref 为空——F 判据须能被后台反查，拒绝无凭证的 Lead`);

  return { uid, persona, A, B, C, D, E, lead, stNF, tkMS, q8, q5, Ccount, Dcount, problems };
});

const bad = scored.filter((s) => s.problems.length);
if (bad.length) {
  console.error(`\n[拒绝统计] ${bad.length} 行存在空白/非法/无凭证记录，逐条列出不带病统计：`);
  for (const s of bad) console.error(`  · ${s.uid}：${s.problems.join("；")}`);
  console.error(`\n请补全/更正真实观察后重跑。不允许用缺项或占位值蒙混门槛。\n`);
  process.exit(2);
}

// ---- 反伪造：逐字段判定位复制检测 ----
const vec = (s) => [s.A, s.B, s.C, s.D, s.E, s.lead, s.stNF, s.tkMS, s.q8, s.Ccount, s.Dcount].join("|");
const seen = new Map();
for (const s of scored) {
  const k = vec(s);
  seen.set(k, (seen.get(k) ?? []).concat(s.uid));
}
const dupGroups = [...seen.values()].filter((ids) => ids.length >= 2);
if (dupGroups.length) {
  console.error(`\n[拒绝统计] 检出 ${dupGroups.length} 组「判定位逐字段完全相同」的行，疑似复制/伪造真实记录：`);
  for (const ids of dupGroups) console.error(`  · 完全相同：${ids.join(", ")}`);
  console.error(`\n真实用户几乎不可能所有判定完全一致。若确有雷同请人工复核后差异化再录。拒绝输出结论。\n`);
  process.exit(2);
}
const uniq = new Set(scored.map(vec));
if (scored.length >= 5 && uniq.size === 1) {
  warn("全体判定零方差（所有人一模一样）——高度可疑，请核对是否真·逐人记录。");
}

// ---- 聚合 ----
const n = scored.length;
const rate = (key) => {
  const pass = scored.filter((s) => s[key] === true).length;
  return { pass, pct: pass / n };
};
const R = { A: rate("A"), B: rate("B"), C: rate("C"), D: rate("D"), E: rate("E") };
const realLeads = scored.filter((s) => s.lead === true).length;

const q8dist = scored.reduce((m, s) => ((m[s.q8] = (m[s.q8] ?? 0) + 1), m), {});
const storageMiss = scored.filter((s) => s.stNF === true && ["P-1", "P-2"].includes(s.persona)).length;
const truckMiss = scored.filter((s) => s.tkMS === true).length;

const strongOK = (k) => R[k].pct >= GATE_STRONG;
const midOK = (k) => R[k].pct >= GATE_MID;

console.log(`\n--- 判据通过率（门槛：A/B/D ≥${GATE_STRONG * 100}% · C/E ≥${GATE_MID * 100}% · F ≥1 条真实 Lead）---`);
for (const k of ["A", "B", "C", "D", "E"]) {
  const gate = k === "C" || k === "E" ? GATE_MID : GATE_STRONG;
  const ok = R[k].pct >= gate;
  console.log(`  ${k}: ${R[k].pass}/${n} = ${(R[k].pct * 100).toFixed(1)}%  ${ok ? "达标" : "未达标"}（门槛 ${(gate * 100) | 0}%）`);
}
console.log(`  F（真实 Lead 合计）: ${realLeads} 条  ${realLeads >= 1 ? "达标" : "未达标（绝对要求 ≥1）"}`);
console.log(`     （F 必须用 npm run ops:metrics 与后台 /admin/leads 的真实 Lead 数交叉核对，本脚本不接触数据库）`);

const redlines = [];
if (storageMiss >= 2) redlines.push(`≥2 名 P-1/P-2 完全找不到储能参数（${storageMiss} 人）`);
if (truckMiss >= 2) redlines.push(`≥2 名把“日均服务重卡数”误读成自有车数（${truckMiss} 人）`);
if (R.E.pass === 0) redlines.push(`没有任何用户找到下一步联系/询价路径（E 全线失守）`);
if (realLeads === 0) redlines.push(`整轮 0 条真实 Lead（F 失守）`);

console.log(`\n--- §9 疑点证据强度 ---`);
console.log(`  疑点3 储能细化可发现性：P-1/P-2 找不到 ${storageMiss} 人`);
console.log(`  疑点2 车辆数误读：${truckMiss} 人`);
console.log(`  Q8 诚实声明反应分布：(a)更信=${q8dist.a ?? 0} (b)无感=${q8dist.b ?? 0} (c)更不敢信=${q8dist.c ?? 0}`);

console.log(`\n--- 红线信号 ---`);
if (redlines.length === 0) console.log("  无");
else redlines.forEach((r) => console.log(`  ✗ ${r}`));

const gatesPass = strongOK("A") && strongOK("B") && strongOK("D") && midOK("C") && midOK("E") && realLeads >= 1 && redlines.length === 0;

console.log(`\n--- §10 决策矩阵·建议分支（仅建议，非结论）---`);
if (!flagConfirm) {
  console.log("  [未确认] 未加 --confirm-real：只输出过程量，拒绝给出通过/不通过建议。");
  console.log("  请先人工确认本表全部数据来自“当场、真实、未经培训诱导”的用户，再追加 --confirm-real 重跑。");
  console.log(`\n=== 计分完成（未裁定）：${n} 人样本，过程量已出，等待真实性确认 ===\n`);
  process.exit(0);
}

let reco;
if (gatesPass) {
  reco = "验证【看起来通过】：A/B/D≥75% 且 C/E≥60% 且 ≥1 条可反查真实 Lead 且无红线。→ 建议：可申请邀请更大样本；是否进 P5 由创始人单列评估，不自动进。";
} else if (R.A.pct < 0.5) {
  reco = "A（30 秒认知）大面积不过 → 属定位/首页价值传达问题，先修文案信息层级，不碰模型、不碰 P5。";
} else if ((q8dist.c ?? 0) > (q8dist.a ?? 0) && redlines.some((r) => r.includes("储能")) ) {
  reco = "可信度 + 可发现性双重问题 → 优先处理 Q8c 口径呈现与储能细化路径（P0/P1 级），数据真实化须创始人先裁。";
} else if ((q8dist.c ?? 0) > (q8dist.a ?? 0)) {
  reco = "Q8 多数“更不敢用”+ Q5 集中质疑模型 → 可信度/数据问题优先；把示例变真数据属暂缓项，交创始人裁决口径，不得临时改模型/编 FACT。";
} else if (realLeads === 0) {
  reco = "体验尚可但 F=0 → 商业闭环未验证。先排查 E（留资路径可见性）与价值兑现，修 P0/P1 后再测；不得据“没报错”就宣布可收费。";
} else {
  reco = "理解/价值部分成立但有判据或红线未达标 → 不进入下一功能阶段；把暴露的 P0/P1 按工程闭环修复加回归，再测一轮。";
}
console.log("  " + reco);
console.log(`\n=== 计分完成：${n} 人 · 门槛${gatesPass ? "全达" : "未全达"} · 红线 ${redlines.length} 项 ===`);
console.log("提示：本脚本不宣布商业成功。请连同 ops-metrics 的 DB 真实 Lead/项目/方案数一起交创始人裁决。\n");
process.exit(0);
