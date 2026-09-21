/**
 * R7-D · 企业项目工作流漏斗派生纯函数（`deriveLeadPipeline`）单测。
 *
 * 锁 mandate §R7-D 的七段判定的**每一个边界**：每段只认确证记录、最深段随最深 reached 推进、
 * nextActions 指针对第一个未到达段、脏数据（负数/非有限/非数组）被 safeCount/兜底吃成 0 不误判。
 * 零 DB / 零时间，字面量即可精确复现。
 */
import { describe, it, expect } from "vitest";
import {
  deriveLeadPipeline,
  pipelineRowFields,
  csvCell,
  toCsv,
  LEAD_CSV_COLUMNS,
  PIPELINE_STAGE_ORDER,
  type PipelineEvidence,
  type LeadPipelineRow,
} from "@/server/lead-pipeline-model";

function ev(over: Partial<PipelineEvidence> = {}): PipelineEvidence {
  return {
    hasLead: true,
    projectCount: 0,
    computedScenarioCount: 0,
    solutionCount: 0,
    solutionStatuses: [],
    orderStatuses: [],
    ...over,
  };
}

function reachedKeys(p: ReturnType<typeof deriveLeadPipeline>): Set<string> {
  return new Set(p.stages.filter((s) => s.reached).map((s) => s.key));
}

describe("R7-D · deriveLeadPipeline 段序与标签", () => {
  it("输出恒为有序 7 段，键序与 PIPELINE_STAGE_ORDER 一致", () => {
    const p = deriveLeadPipeline(ev());
    expect(p.stages.map((s) => s.key)).toEqual(PIPELINE_STAGE_ORDER.map((s) => s.key));
    expect(p.stages.length).toBe(7);
  });
});

describe("R7-D · 逐段确证判定", () => {
  it("仅留资：只到 LEAD，furthest=LEAD，下一步=立项", () => {
    const p = deriveLeadPipeline(ev());
    expect([...reachedKeys(p)]).toEqual(["LEAD"]);
    expect(p.furthest).toBe("LEAD");
    expect(p.nextActions[0]).toContain("立项");
  });

  it("有项目但未算通出报告：到 PROJECT，未到 ASSESSMENT", () => {
    const p = deriveLeadPipeline(ev({ projectCount: 2, computedScenarioCount: 0 }));
    const r = reachedKeys(p);
    expect(r.has("PROJECT")).toBe(true);
    expect(r.has("ASSESSMENT")).toBe(false);
    expect(p.furthest).toBe("PROJECT");
    expect(p.nextActions[0]).toContain("算通");
  });

  it("有算通出报告的情景：到 ASSESSMENT", () => {
    const p = deriveLeadPipeline(ev({ projectCount: 1, computedScenarioCount: 1 }));
    expect(reachedKeys(p).has("ASSESSMENT")).toBe(true);
    expect(p.furthest).toBe("ASSESSMENT");
    expect(p.nextActions[0]).toContain("方案");
  });

  it("有方案（全草稿）：到 SOLUTION，未 REVIEW（草稿不算过审）", () => {
    const p = deriveLeadPipeline(
      ev({ projectCount: 1, computedScenarioCount: 1, solutionCount: 1, solutionStatuses: ["DRAFT"] }),
    );
    const r = reachedKeys(p);
    expect(r.has("SOLUTION")).toBe(true);
    expect(r.has("REVIEW")).toBe(false);
    expect(p.furthest).toBe("SOLUTION");
    expect(p.nextActions[0]).toContain("人工审核");
  });

  it("有 UNDER_HUMAN_REVIEW 方案：到 REVIEW，未到 PUBLISHED", () => {
    const p = deriveLeadPipeline(
      ev({
        projectCount: 1,
        computedScenarioCount: 1,
        solutionCount: 1,
        solutionStatuses: ["UNDER_HUMAN_REVIEW"],
      }),
    );
    const r = reachedKeys(p);
    expect(r.has("REVIEW")).toBe(true);
    expect(r.has("PUBLISHED")).toBe(false);
    expect(p.furthest).toBe("REVIEW");
    expect(p.nextActions[0]).toContain("复核通过");
  });

  it("有 PUBLISHED 方案：REVIEW 与 PUBLISHED 同时到达（发布蕴含已过审门）", () => {
    const p = deriveLeadPipeline(
      ev({
        projectCount: 1,
        computedScenarioCount: 1,
        solutionCount: 1,
        solutionStatuses: ["PUBLISHED"],
      }),
    );
    const r = reachedKeys(p);
    expect(r.has("REVIEW")).toBe(true);
    expect(r.has("PUBLISHED")).toBe(true);
    expect(p.furthest).toBe("PUBLISHED");
    expect(p.nextActions[0]).toContain("下单");
  });

  it("有 PAID 订单：到达 DELIVERY，nextActions 为空（闭环完成）", () => {
    const p = deriveLeadPipeline(
      ev({
        projectCount: 1,
        computedScenarioCount: 1,
        solutionCount: 1,
        solutionStatuses: ["PUBLISHED"],
        orderStatuses: ["PAID"],
      }),
    );
    expect(p.furthest).toBe("DELIVERY");
    expect(p.nextActions).toEqual([]);
  });

  it("仅有 PENDING 订单：未到 DELIVERY，提示确认收款（后台标 PAID）", () => {
    const p = deriveLeadPipeline(
      ev({
        projectCount: 1,
        computedScenarioCount: 1,
        solutionCount: 1,
        solutionStatuses: ["PUBLISHED"],
        orderStatuses: ["PENDING"],
      }),
    );
    expect(reachedKeys(p).has("DELIVERY")).toBe(false);
    expect(p.furthest).toBe("PUBLISHED");
    expect(p.nextActions[0]).toContain("确认收款");
  });
});

describe("R7-D · 脏数据兜底（不误判到达）", () => {
  it("负数 / 非有限计数一律当 0", () => {
    const p = deriveLeadPipeline(ev({ projectCount: -5, computedScenarioCount: NaN, solutionCount: Infinity }));
    const r = reachedKeys(p);
    expect(r.has("PROJECT")).toBe(false);
    expect(r.has("ASSESSMENT")).toBe(false);
    expect(r.has("SOLUTION")).toBe(false);
  });

  it("solutionStatuses / orderStatuses 非数组 → 视为空", () => {
    const p = deriveLeadPipeline({
      ...ev({ projectCount: 1, computedScenarioCount: 1 }),
      solutionStatuses: undefined as unknown as PipelineEvidence["solutionStatuses"],
      orderStatuses: null as unknown as PipelineEvidence["orderStatuses"],
    });
    expect(reachedKeys(p).has("REVIEW")).toBe(false);
    expect(reachedKeys(p).has("PUBLISHED")).toBe(false);
  });

  it("hasLead=false（脏调用）→ LEAD 都不到达，furthest 回落 LEAD", () => {
    const p = deriveLeadPipeline(ev({ hasLead: false }));
    expect(p.stages.find((s) => s.key === "LEAD")?.reached).toBe(false);
    expect(p.furthest).toBe("LEAD");
  });
});

describe("R7-D · 多重集统计如实反映在 detail", () => {
  it("混合方案状态：detail 精确到各态计数", () => {
    const p = deriveLeadPipeline(
      ev({
        projectCount: 1,
        computedScenarioCount: 3,
        solutionCount: 4,
        solutionStatuses: ["DRAFT", "UNDER_HUMAN_REVIEW", "PUBLISHED", "PUBLISHED"],
        orderStatuses: ["PAID", "PENDING"],
      }),
    );
    const sol = p.stages.find((s) => s.key === "SOLUTION")!;
    expect(sol.detail).toContain("草稿 1");
    expect(sol.detail).toContain("审核中 1");
    expect(sol.detail).toContain("已发布 2");
    const del = p.stages.find((s) => s.key === "DELIVERY")!;
    expect(del.detail).toContain("已支付订单 1");
    expect(del.detail).toContain("待支付 1");
    expect(p.furthest).toBe("DELIVERY");
  });
});

/* ═══════════════ mandate §五 · 批量漏斗行 + CSV 序列化（纯函数） ═══════════════ */

describe("pipelineRowFields · 漏斗 → CSV 文本字段", () => {
  it("仅留资：currentStage=留资、下一步=立项建议、缺口含其余六段", () => {
    const p = deriveLeadPipeline(ev());
    const f = pipelineRowFields(p);
    expect(f.currentStage).toBe("留资");
    expect(f.nextAction).toContain("项目");
    // 缺口 = 除 LEAD 外全部 6 段（"评估 / 决策" 标签本身含分隔符，故按子串断言而非 split 计数）。
    expect(f.blockers).toContain("立项");
    expect(f.blockers).toContain("评估 / 决策");
    expect(f.blockers).toContain("成交交付");
    expect(f.blockers).not.toContain("留资"); // 已到达段不进缺口
  });

  it("到底（全到达）：缺口空、下一步空、currentStage=成交交付", () => {
    const p = deriveLeadPipeline(
      ev({
        projectCount: 1,
        computedScenarioCount: 1,
        solutionCount: 1,
        solutionStatuses: ["PUBLISHED"],
        orderStatuses: ["PAID"],
      }),
    );
    const f = pipelineRowFields(p);
    expect(f.currentStage).toBe("成交交付");
    expect(f.blockers).toBe("");
    expect(f.nextAction).toBe("");
  });
});

describe("csvCell · 公式注入防护 + RFC4180 转义", () => {
  it("普通文本恒加引号包裹", () => {
    expect(csvCell("山西大同")).toBe('"山西大同"');
  });

  it("内部双引号翻倍", () => {
    expect(csvCell('a"b')).toBe('"a""b"');
  });

  it("以 = + - @ 开头 → 前缀单引号防公式执行", () => {
    expect(csvCell("=HYPERLINK(...)")).toBe('"\'=HYPERLINK(...)"');
    expect(csvCell("+1")).toBe('"\'+1"');
    expect(csvCell("-1")).toBe('"\'-1"');
    expect(csvCell("@id")).toBe('"\'@id"');
  });

  it("制表符 / 回车开头同样被前缀保护（OWASP）", () => {
    expect(csvCell("\ttab")).toBe('"\'\ttab"');
    expect(csvCell("\rcr")).toBe('"\'' + "\rcr" + '"');
  });

  it("减号在中间不误伤（仅开头才转义）", () => {
    expect(csvCell("A-B")).toBe('"A-B"');
  });
});

describe("toCsv · 表头 + 行序列化", () => {
  const row = (over: Partial<LeadPipelineRow> = {}): LeadPipelineRow => ({
    leadId: "lead000001",
    identityResolved: true,
    company: "某公司",
    project: "换电网络",
    currentStage: "方案成卡",
    createdAt: new Date("2026-01-02T03:04:05.000Z"),
    updatedAt: new Date("2026-02-03T00:00:00.000Z"),
    ownerReviewer: "owner@x.com",
    nextAction: "提交审核",
    blockers: "人工审核 / 上架可售 / 成交交付",
    ...over,
  });

  it("首行 = 指定列顺序表头；行数 = 1 表头 + n 数据；CRLF 分隔", () => {
    const csv = toCsv([row(), row({ leadId: "lead000002" })]);
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(3);
    const header = lines[0].split(",").map((s) => s.replace(/^"|"$/g, ""));
    expect(header).toEqual([...LEAD_CSV_COLUMNS]);
  });

  it("Date → ISO、boolean → true/false、空字段 → 引号包裹空串", () => {
    const csv = toCsv([row({ identityResolved: false, project: "", ownerReviewer: "" })]);
    const lines = csv.split("\r\n");
    expect(lines[1]).toContain('"2026-01-02T03:04:05.000Z"');
    expect(lines[1]).toContain("false"); // identityResolved
    expect(lines[1]).toContain('""'); // 空 project / ownerReviewer
  });

  it("含逗号 / 引号 / 换行的字段被安全包裹（不破坏列结构）", () => {
    const csv = toCsv([row({ company: '甲,乙"丙\n丁' })]);
    // 数据行整体因内含换行会跨物理行，但逻辑上仍是 2 个字段组（表头 + 1 数据）——
    // 断言该危险串被引号包裹且内部引号翻倍、前缀未被误加公式保护（非 =+-@ 开头）。
    expect(csv).toContain('"甲,乙""丙\n丁"');
  });
});

