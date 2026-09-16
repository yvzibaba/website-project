#!/usr/bin/env node
// scripts/ops-metrics.mjs
// 最小运营指标快照（V1.1 上线运营 · 配套 docs/LAUNCH_OPS_PLAN_V1_1.md §五 / docs/V1_METRICS.md）
//
// 严格【只读】：只做 count / groupBy 查询，绝不写库、绝不改 schema、绝不建 BI。
// 页面级“访问/曝光”类指标数据库拿不到精确值（本仓无埋点，是刻意选择），仍按 V1_METRICS 人工计数；
// 这里只把【数据库能精确回答】的运营事实一次拉全，供创始人每天/每批测试后看真实进展。
//
// 用法：
//   node --env-file=.env scripts/ops-metrics.mjs            # 汇总 + 最近 7 天
//   node --env-file=.env scripts/ops-metrics.mjs --days=30  # 自定义回看窗口
//   npm run ops:metrics                                      # 等价（读 .env）

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const require = createRequire(path.join(ROOT, "package.json"));
const { PrismaClient } = require("@prisma/client");

const daysArg = process.argv.find((a) => a.startsWith("--days="));
const DAYS = daysArg ? Math.max(1, Number(daysArg.split("=")[1]) || 7) : 7;
const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);

const prisma = new PrismaClient();

function head(t) {
  console.log(`\n${"─".repeat(56)}\n${t}\n${"─".repeat(56)}`);
}
function kv(label, val) {
  console.log(`  ${label.padEnd(22)} ${val}`);
}
async function safe(fn, fallback = "n/a") {
  try {
    return await fn();
  } catch (e) {
    return `${fallback}（${e?.code || e?.name || "err"}）`;
  }
}
async function groupCount(model, field) {
  const g = await prisma[model].groupBy({ by: [field], _count: { _all: true } });
  return g.map((x) => `${x[field] ?? "(null)"}=${x._count._all}`).join("  ") || "（空）";
}

console.log(`\n=== 运营指标快照 · 回看窗口 最近 ${DAYS} 天（自 ${since.toISOString().slice(0, 10)}）===`);
console.log(`生成时间：${new Date().toISOString()}   模式：只读（不写库 / 不建 BI）`);

try {
  // 1. 注册
  head("① 注册用户");
  const users = await safe(() => prisma.user.count());
  const usersNew = await safe(() => prisma.user.count({ where: { createdAt: { gte: since } } }));
  const usersByRole = await safe(() => groupCount("user", "role"), "(role 分组失败)");
  kv("累计", users);
  kv(`最近 ${DAYS} 天新增`, usersNew);
  kv("角色分布", usersByRole);

  // 2. 保存项目
  head("② 沙盘保存项目（登录用户核心动作）");
  const projects = await safe(() => prisma.project.count());
  const projNew = await safe(() => prisma.project.count({ where: { createdAt: { gte: since } } }));
  const projOwned = await safe(() => prisma.project.count({ where: { ownerId: { not: null } } }));
  const projOwners = await safe(() => prisma.project.groupBy({ by: ["ownerId"], where: { ownerId: { not: null } }, _count: { _all: true } }).then((r) => r.length));
  kv("累计项目数", projects);
  kv(`最近 ${DAYS} 天新建`, projNew);
  kv("已归属用户的项目", projOwned);
  kv("保存过项目的去重用户", projOwners);

  // 3. 导出方案（买家闭环产物，默认 DRAFT）
  head("③ 导出产业方案 Solution");
  const sols = await safe(() => prisma.solution.count());
  const solNew = await safe(() => prisma.solution.count({ where: { createdAt: { gte: since } } }));
  const solByStatus = await safe(() => groupCount("solution", "status"));
  const solByCreator = await safe(() => prisma.solution.count({ where: { creatorId: { not: null } } }));
  kv("累计方案数", sols);
  kv(`最近 ${DAYS} 天新建`, solNew);
  kv("按状态", solByStatus);
  kv("买家自助导出(有 creatorId)", solByCreator);

  // 4. Lead 留资（真实商业意向，F 判据的 DB 侧反查）
  head("④ 询价留资 Lead");
  const leads = await safe(() => prisma.lead.count());
  const leadNew = await safe(() => prisma.lead.count({ where: { createdAt: { gte: since } } }));
  const leadByStatus = await safe(() => groupCount("lead", "status"));
  const leadBySource = await safe(() => groupCount("lead", "source"));
  const leadGuest = await safe(() => prisma.lead.count({ where: { userId: null } }));
  const leadUser = await safe(() => prisma.lead.count({ where: { userId: { not: null } } }));
  const leadOpen = await safe(() => prisma.lead.count({ where: { status: "NEW" } }));
  kv("累计 Lead", leads);
  kv(`最近 ${DAYS} 天新增`, leadNew);
  kv("按状态", leadByStatus);
  kv("按来源落位", leadBySource);
  kv("游客 / 登录归因", `${leadGuest} / ${leadUser}`);
  kv("待处理(NEW·需跟进)", leadOpen);

  // 5. Lead 画像分布（一手市场信号）
  head("⑤ 留资画像分布（needType · fleetSize · projectStage）");
  kv("需求类型", await safe(() => groupCount("lead", "needType"), "(字段缺失)"));
  kv("车辆规模档", await safe(() => groupCount("lead", "fleetSize"), "(字段缺失)"));
  kv("项目阶段", await safe(() => groupCount("lead", "projectStage"), "(字段缺失)"));
  kv("项目地区(Top)", await safe(() => groupCount("lead", "projectRegion"), "(字段缺失)"));

  // 6. 案例橱窗
  head("⑥ 公开案例橱窗 Case");
  kv("案例累计", await safe(() => prisma.case.count()));
  kv("按阶段", await safe(() => groupCount("case", "stage"), "(stage 分组失败)"));

  // 7. 订单（当前 V1.1 走人工报价，Order 多为空；仍精确查）
  head("⑦ 订单 / 付款（V1.1 刻意走人工，预期为 0）");
  kv("订单累计", await safe(() => prisma.order.count(), "(无 Order 表)"));
  kv("按状态", await safe(() => groupCount("order", "status"), "(无 Order 表)"));

  // 8. 数据健康：孤儿一致性（Solution.caseId 必须指向真实 Case）
  head("⑧ 数据健康自检（一致性·只读）");
  const orphan = await safe(async () => {
    const solsAll = await prisma.solution.findMany({ select: { id: true, caseId: true } });
    let bad = 0;
    for (const s of solsAll) {
      const c = await prisma.case.findUnique({ where: { id: s.caseId }, select: { id: true } });
      if (!c) bad++;
    }
    return `${bad} 条方案 caseId 悬空`;
  }, "(跳过)");
  kv("悬空方案(Solution→Case)", orphan);
  kv("DRAFT 未发布方案", await safe(() => prisma.solution.count({ where: { status: "DRAFT" } })));
} catch (e) {
  console.error(`\n[只读快照出错] ${e?.message || e}\n多为 DATABASE_URL 未设或 Neon 冷启动超时，重试即可。`);
} finally {
  await prisma.$disconnect();
}

console.log(`\n说明：访问/曝光类漏斗指标本仓无埋点（刻意），仍按 docs/V1_METRICS.md 由观察者人工计数；`);
console.log(`      F 判据“真实 Lead”请以上面 ④ 的 DB 计数为准，与 tally 脚本的 CSV 记录交叉核对。\n`);
