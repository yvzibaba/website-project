import { PrismaClient, Industry, CaseStage, EvidenceType, Maturity } from "@prisma/client";
import { DEMO_SOURCE_TYPE, DEMO_TITLE_PREFIX } from "../src/server/demo";

/**
 * DEMO 种子脚本（仅案例，不种子方案 —— 创始人 2026-09-05 裁决）。
 *
 * 目的：开发期验证 /cases 列表、/cases/[id] 详情、分页与行业筛选的渲染路径。
 * 诚实约束（宪法第 20 条）：
 *   - 所有种子行明确标注为 DEMO（sourceType=DEMO_FIXTURE、标题前缀【DEMO】、正文写明"非真实案例"）；
 *   - 公开查询默认排除 DEMO，仅 ?demo=1 时纳入且页面打角标（见 src/server/demo.ts）；
 *   - **不种子任何 Solution**：方案涉及定价与购买闭环，必须由真实多角色流水线产出，禁止伪造可售商品；
 *   - NODE_ENV=production 直接拒绝运行，生产库永不出现 DEMO 行。
 *
 * 幂等：引用数据用固定 `demo_` 前缀 id + upsert；案例先按 sourceType 删除（级联清理
 * Evidence / CaseCapability / Localization）再重建，重复运行结果一致。
 *
 * 运行：npm run db:seed  （= node --env-file=.env --import tsx prisma/seed.ts）
 */

const prisma = new PrismaClient({ log: ["error", "warn"] });

const DEMO_ID = "demo_"; // 所有种子行 id 前缀，便于清理

interface SeedCase {
  id: string;
  title: string;
  industry: Industry;
  regionId: string;
  businessModelId?: string;
  summary: string;
  sourceUrl?: string;
  opportunityScore: number;
  evidenceConfidence: number;
  capabilities: Array<{ id: string; relevance: number; note: string }>;
  evidences: Array<{ type: EvidenceType; statement: string; confidence?: number }>;
}

const REGIONS = [
  { id: `${DEMO_ID}region_cn_shanxi`, name: "山西省（示例）", nameEn: "Shanxi (DEMO)", code: "DEMO-CN-SX", country: "CN" },
  { id: `${DEMO_ID}region_cn_guangdong`, name: "广东省（示例）", nameEn: "Guangdong (DEMO)", code: "DEMO-CN-GD", country: "CN" },
  { id: `${DEMO_ID}region_cn_shandong`, name: "山东省（示例）", nameEn: "Shandong (DEMO)", code: "DEMO-CN-SD", country: "CN" },
] as const;

const BUSINESS_MODELS = [
  { id: `${DEMO_ID}bm_waste_fee`, name: "处理费 + 副产品销售（示例）", description: "【DEMO】以粪污/废弃物处理服务费为主，沼气发电与有机肥为副收入。", revenueStreams: ["处理服务费", "沼气发电上网", "有机肥销售"], costStructure: ["设备折旧", "运维人工", "原料收储"] },
  { id: `${DEMO_ID}bm_saas`, name: "工业 SaaS 订阅（示例）", description: "【DEMO】按产线/按年订阅的质检软件服务。", revenueStreams: ["年度订阅费", "实施集成费"], costStructure: ["研发", "云资源", "售后"] },
  { id: `${DEMO_ID}bm_ppa`, name: "合同能源管理 / 峰谷套利（示例）", description: "【DEMO】储能通过峰谷价差套利，与业主分成。", revenueStreams: ["峰谷价差", "需量管理", "辅助服务"], costStructure: ["电池系统", "PCS", "运维"] },
] as const;

const CAPABILITIES = [
  { id: `${DEMO_ID}cap_biogas`, name: "沼气厌氧发酵（示例）", nameEn: "Biogas Anaerobic Digestion (DEMO)", category: "生物能源", maturity: Maturity.MATURE, description: "【DEMO】畜禽粪污/秸秆厌氧发酵产沼气。" },
  { id: `${DEMO_ID}cap_ai_vision`, name: "AI 视觉质检（示例）", nameEn: "AI Vision Inspection (DEMO)", category: "工业 AI", maturity: Maturity.DEVELOPING, description: "【DEMO】基于深度学习的表面缺陷检测。" },
  { id: `${DEMO_ID}cap_predictive_maint`, name: "预测性维护（示例）", nameEn: "Predictive Maintenance (DEMO)", category: "工业 AI", maturity: Maturity.DEVELOPING, description: "【DEMO】设备振动/温度时序异常预测。" },
  { id: `${DEMO_ID}cap_bess`, name: "电池储能系统（示例）", nameEn: "Battery Energy Storage (DEMO)", category: "储能", maturity: Maturity.DEVELOPING, description: "【DEMO】磷酸铁锂储能 + EMS 调度。" },
  { id: `${DEMO_ID}cap_cold_chain`, name: "冷链溯源（示例）", nameEn: "Cold Chain Traceability (DEMO)", category: "农业数字化", maturity: Maturity.MATURE, description: "【DEMO】温湿度 IoT + 区块链溯源。" },
  { id: `${DEMO_ID}cap_prefab_energy`, name: "装配式建筑能耗优化（示例）", nameEn: "Prefabricated Building Energy Optimization (DEMO)", category: "绿色建筑", maturity: Maturity.EMERGING, description: "【DEMO】装配式构件 + 能耗模拟优化。" },
  { id: `${DEMO_ID}cap_ai_tutor`, name: "AI 实训助教（示例）", nameEn: "AI Training Tutor (DEMO)", category: "教育 AI", maturity: Maturity.DEVELOPING, description: "【DEMO】职业技能实训的个性化 AI 助教。" },
] as const;

const DEMO_NOTE = "（演示数据，非真实案例研究；由每日流水线产出的真实案例将替换本行）";

const CASES: SeedCase[] = [
  {
    id: `${DEMO_ID}case_biogas`,
    title: `${DEMO_TITLE_PREFIX}某农业大县畜禽粪污沼气工程示例${DEMO_NOTE}`,
    industry: Industry.AGRICULTURE_FORESTRY_FISHERY,
    regionId: `${DEMO_ID}region_cn_shanxi`,
    businessModelId: `${DEMO_ID}bm_waste_fee`,
    summary: `【DEMO】示例：一个县域级畜禽粪污集中处理 + 沼气发电 + 有机肥还田的工程设想，用于演示案例详情页的证据分层与技术能力关联。${DEMO_NOTE}`,
    sourceUrl: "https://example.com/demo/biogas",
    opportunityScore: 62,
    evidenceConfidence: 38,
    capabilities: [{ id: `${DEMO_ID}cap_biogas`, relevance: 90, note: "【DEMO】核心产气能力" }],
    evidences: [
      { type: EvidenceType.FACT, statement: "【DEMO】示例事实：该类工程在国内已有多个县建成运行（占位，未引用真实来源）。", confidence: 50 },
      { type: EvidenceType.ASSUMPTION, statement: "【DEMO】示例假设：粪污收储半径 30km 内、含固率 20% 左右。", confidence: 30 },
      { type: EvidenceType.INFERENCE, statement: "【DEMO】示例推断：在处理费 + 上网电价叠加下项目可能勉强盈亏平衡。", confidence: 35 },
      { type: EvidenceType.PREDICTION, statement: "【DEMO】示例预测：若碳资产价格上行，IRR 有改善空间（不确定性高）。", confidence: 20 },
    ],
  },
  {
    id: `${DEMO_ID}case_ai_vision`,
    title: `${DEMO_TITLE_PREFIX}某机械厂 AI 视觉质检改造示例${DEMO_NOTE}`,
    industry: Industry.INDUSTRIAL_MANUFACTURING,
    regionId: `${DEMO_ID}region_cn_guangdong`,
    businessModelId: `${DEMO_ID}bm_saas`,
    summary: `【DEMO】示例：一条机加工产线引入 AI 视觉质检替代人工目检的改造设想，演示技术能力拆解（视觉 + 预测性维护）。${DEMO_NOTE}`,
    sourceUrl: "https://example.com/demo/ai-vision",
    opportunityScore: 71,
    evidenceConfidence: 45,
    capabilities: [
      { id: `${DEMO_ID}cap_ai_vision`, relevance: 95, note: "【DEMO】主能力" },
      { id: `${DEMO_ID}cap_predictive_maint`, relevance: 55, note: "【DEMO】可叠加" },
    ],
    evidences: [
      { type: EvidenceType.FACT, statement: "【DEMO】示例事实：AI 视觉质检在 3C/汽车零部件已有成熟落地（占位）。", confidence: 55 },
      { type: EvidenceType.ASSUMPTION, statement: "【DEMO】示例假设：单产线年质检人力成本约若干万元（占位数字，非实测）。", confidence: 30 },
      { type: EvidenceType.INFERENCE, statement: "【DEMO】示例推断：漏检率下降可带来返工成本节约。", confidence: 40 },
    ],
  },
  {
    id: `${DEMO_ID}case_bess`,
    title: `${DEMO_TITLE_PREFIX}某工业园区工商业储能峰谷套利示例${DEMO_NOTE}`,
    industry: Industry.NEW_ENERGY,
    regionId: `${DEMO_ID}region_cn_guangdong`,
    businessModelId: `${DEMO_ID}bm_ppa`,
    summary: `【DEMO】示例：园区侧工商业储能通过峰谷价差 + 需量管理获利的设想，演示新能源行业案例与财务不确定性标注。${DEMO_NOTE}`,
    sourceUrl: "https://example.com/demo/bess",
    opportunityScore: 66,
    evidenceConfidence: 42,
    capabilities: [{ id: `${DEMO_ID}cap_bess`, relevance: 92, note: "【DEMO】储能系统" }],
    evidences: [
      { type: EvidenceType.FACT, statement: "【DEMO】示例事实：多地已实施工商业分时电价（占位）。", confidence: 50 },
      { type: EvidenceType.ASSUMPTION, statement: "【DEMO】示例假设：日均两充两放、峰谷价差达到某阈值（占位）。", confidence: 28 },
      { type: EvidenceType.PREDICTION, statement: "【DEMO】示例预测：电价政策变动会显著影响回收期（高不确定性）。", confidence: 18 },
    ],
  },
  {
    id: `${DEMO_ID}case_cold_chain`,
    title: `${DEMO_TITLE_PREFIX}某生鲜冷链溯源数字化示例${DEMO_NOTE}`,
    industry: Industry.AGRICULTURE_FORESTRY_FISHERY,
    regionId: `${DEMO_ID}region_cn_shandong`,
    summary: `【DEMO】示例：生鲜农产品冷链温湿度监控 + 溯源数字化设想。${DEMO_NOTE}`,
    sourceUrl: "https://example.com/demo/cold-chain",
    opportunityScore: 58,
    evidenceConfidence: 36,
    capabilities: [{ id: `${DEMO_ID}cap_cold_chain`, relevance: 88, note: "【DEMO】冷链溯源" }],
    evidences: [
      { type: EvidenceType.FACT, statement: "【DEMO】示例事实：冷链断链导致损耗是行业痛点（占位）。", confidence: 48 },
      { type: EvidenceType.INFERENCE, statement: "【DEMO】示例推断：溯源可提升溢价与准入合规。", confidence: 33 },
    ],
  },
  {
    id: `${DEMO_ID}case_prefab`,
    title: `${DEMO_TITLE_PREFIX}某装配式建筑能耗优化示例${DEMO_NOTE}`,
    industry: Industry.REAL_ESTATE_CONSTRUCTION,
    regionId: `${DEMO_ID}region_cn_shandong`,
    summary: `【DEMO】示例：装配式建筑结合能耗模拟优化围护结构的设想。${DEMO_NOTE}`,
    sourceUrl: "https://example.com/demo/prefab",
    opportunityScore: 54,
    evidenceConfidence: 30,
    capabilities: [{ id: `${DEMO_ID}cap_prefab_energy`, relevance: 85, note: "【DEMO】装配式 + 能耗模拟" }],
    evidences: [
      { type: EvidenceType.ASSUMPTION, statement: "【DEMO】示例假设：项目位于寒冷地区、执行某节能标准（占位）。", confidence: 25 },
      { type: EvidenceType.PREDICTION, statement: "【DEMO】示例预测：运行能耗较基准下降一定比例（不确定）。", confidence: 20 },
    ],
  },
  {
    id: `${DEMO_ID}case_ai_tutor`,
    title: `${DEMO_TITLE_PREFIX}某职业院校 AI 实训助教示例${DEMO_NOTE}`,
    industry: Industry.EDUCATION_TRAINING,
    regionId: `${DEMO_ID}region_cn_shanxi`,
    summary: `【DEMO】示例：职业技能实训引入个性化 AI 助教的设想。${DEMO_NOTE}`,
    sourceUrl: "https://example.com/demo/ai-tutor",
    opportunityScore: 60,
    evidenceConfidence: 34,
    capabilities: [{ id: `${DEMO_ID}cap_ai_tutor`, relevance: 90, note: "【DEMO】AI 助教" }],
    evidences: [
      { type: EvidenceType.FACT, statement: "【DEMO】示例事实：职业教育数字化是政策鼓励方向（占位）。", confidence: 45 },
      { type: EvidenceType.INFERENCE, statement: "【DEMO】示例推断：个性化训练可提升取证通过率。", confidence: 30 },
    ],
  },
];

async function main() {
  if (process.env.NODE_ENV === "production") {
    console.error("[seed] 拒绝在 NODE_ENV=production 运行 DEMO 种子（宪法第 20 条）。");
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("[seed] 缺少 DATABASE_URL。用 npm run db:seed（会加载 .env）。");
    process.exit(1);
  }

  console.log("[seed] 清理旧 DEMO 数据（级联 Evidence / CaseCapability / Localization）…");
  // 先删案例（级联清理其从属行），再删被引用的 demo 引用数据
  await prisma.case.deleteMany({ where: { sourceType: DEMO_SOURCE_TYPE } });
  await prisma.case.deleteMany({ where: { id: { startsWith: DEMO_ID } } });
  await prisma.capabilityProject.deleteMany({ where: { capabilityId: { startsWith: DEMO_ID } } });
  await prisma.localization.deleteMany({ where: { id: { startsWith: DEMO_ID } } });
  await prisma.caseCapability.deleteMany({ where: { capabilityId: { startsWith: DEMO_ID } } });
  await prisma.techCapability.deleteMany({ where: { id: { startsWith: DEMO_ID } } });
  await prisma.businessModel.deleteMany({ where: { id: { startsWith: DEMO_ID } } });
  await prisma.region.deleteMany({ where: { id: { startsWith: DEMO_ID } } });

  console.log(`[seed] 写入 ${REGIONS.length} 地区 / ${BUSINESS_MODELS.length} 商业模式 / ${CAPABILITIES.length} 技术能力…`);
  for (const r of REGIONS) await prisma.region.create({ data: r });
  for (const b of BUSINESS_MODELS) {
    await prisma.businessModel.create({
      data: { ...b, revenueStreams: [...b.revenueStreams], costStructure: [...b.costStructure] },
    });
  }
  for (const c of CAPABILITIES) await prisma.techCapability.create({ data: c });

  console.log(`[seed] 写入 ${CASES.length} 个 DEMO 案例（stage=DEEP_CASE，sourceType=${DEMO_SOURCE_TYPE}）…`);
  let evTotal = 0;
  let capTotal = 0;
  for (const c of CASES) {
    await prisma.case.create({
      data: {
        id: c.id,
        title: c.title,
        industry: c.industry,
        regionId: c.regionId,
        businessModelId: c.businessModelId,
        sourceUrl: c.sourceUrl,
        sourceType: DEMO_SOURCE_TYPE,
        summary: c.summary,
        stage: CaseStage.DEEP_CASE,
        opportunityScore: c.opportunityScore,
        evidenceConfidence: c.evidenceConfidence,
      },
    });
    for (const cap of c.capabilities) {
      await prisma.caseCapability.create({
        data: { caseId: c.id, capabilityId: cap.id, relevance: cap.relevance, note: cap.note },
      });
      capTotal++;
    }
    for (const ev of c.evidences) {
      await prisma.evidence.create({
        data: {
          caseId: c.id,
          type: ev.type,
          statement: ev.statement,
          sourceUrl: c.sourceUrl,
          sourceType: DEMO_SOURCE_TYPE,
          confidence: ev.confidence,
        },
      });
      evTotal++;
    }
  }

  const caseCount = await prisma.case.count({ where: { sourceType: DEMO_SOURCE_TYPE } });
  console.log(`[seed] 完成：DEMO 案例 ${caseCount}，证据 ${evTotal}，案例-能力关联 ${capTotal}。`);
  console.log("[seed] 提示：公开页默认排除 DEMO；加 ?demo=1 可见（页面会打 DEMO 角标）。");
}

main()
  .catch((err) => {
    console.error("[seed] 失败：", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
