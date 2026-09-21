/**
 * R8 · CandidateProject 筛选纯函数单测（`screenCandidate` / `toScreeningInput` / `assessCandidate`）。
 *
 * 锁 mandate §九：① 六闸**有序**、裁决取第一个未过闸的绑定值、全过 = READY_FOR_PROJECT；
 * ② 四态输出不多不少；③ 硬约束一票否决 = REJECT；④ 经济性/产业价值缺失只留池（CANDIDATE）不误拒；
 * ⑤ 脏 JSON / 缺字段保守降级（倾向 NEED_MORE_EVIDENCE / 不误放行）；⑥ 阈值快照可复算。
 * 零 DB / 零时间，字面量精确复现。
 */
import { describe, it, expect } from "vitest";
import {
  screenCandidate,
  toScreeningInput,
  assessCandidate,
  SCREENING_THRESHOLDS,
  type CandidateScreeningInput,
} from "@app/kernel/lib/candidate-screening";

const T = SCREENING_THRESHOLDS;
function strong(n: number) {
  return Array.from({ length: n }, () => ({ kind: "FACT", confidence: 80 }));
}
function base(over: Partial<CandidateScreeningInput> = {}): CandidateScreeningInput {
  return {
    titlePresent: true,
    regionPresent: true,
    technologyPresent: true,
    evidence: strong(T.MIN_EVIDENCE_ITEMS),
    paramCompleteness: 1,
    disqualifiers: [],
    hasEconomics: true,
    industryValuePresent: true,
    ...over,
  };
}

describe("R8 · 全过 → READY_FOR_PROJECT", () => {
  it("六闸全通过，verdict=READY_FOR_PROJECT，reasons 为空", () => {
    const o = screenCandidate(base());
    expect(o.verdict).toBe("READY_FOR_PROJECT");
    expect(o.reasons).toEqual([]);
    expect(o.gates.every((g) => g.passed)).toBe(true);
    // 阈值快照随结果返回（可追溯）
    expect(o.thresholds).toBe(SCREENING_THRESHOLDS);
  });
});

describe("R8 · 逐闸裁决与顺序", () => {
  it("缺标题 → REJECT（发现底线）", () => {
    expect(screenCandidate(base({ titlePresent: false })).verdict).toBe("REJECT");
  });

  it("有标题但缺地区 → NEED_MORE_EVIDENCE（发现不完整）", () => {
    const o = screenCandidate(base({ regionPresent: false }));
    expect(o.verdict).toBe("NEED_MORE_EVIDENCE");
  });

  it("证据不足 → NEED_MORE_EVIDENCE，且是第一个未过闸（发现已过）", () => {
    const o = screenCandidate(base({ evidence: strong(T.MIN_EVIDENCE_ITEMS - 1) }));
    expect(o.verdict).toBe("NEED_MORE_EVIDENCE");
    const evGate = o.gates.find((g) => g.key === "EVIDENCE" && !g.passed)!;
    expect(evGate).toBeTruthy();
  });

  it("参数完整度不足 → NEED_MORE_EVIDENCE", () => {
    expect(screenCandidate(base({ paramCompleteness: 0.3 })).verdict).toBe("NEED_MORE_EVIDENCE");
  });

  it("命中硬约束 → REJECT（一票否决，优先级高于经济/产业价值缺失）", () => {
    const o = screenCandidate(base({ disqualifiers: ["许可证高风险未核"], hasEconomics: false }));
    expect(o.verdict).toBe("REJECT");
    const c = o.gates.find((g) => g.key === "CONSTRAINTS")!;
    expect(c.passed).toBe(false);
    expect(c.reason).toContain("许可证高风险未核");
  });

  it("证据已足但经济性缺 → CANDIDATE（留池不误拒、不直接 ready）", () => {
    const o = screenCandidate(base({ hasEconomics: false }));
    expect(o.verdict).toBe("CANDIDATE");
    expect(o.reasons.some((r) => r.includes("经济性"))).toBe(true);
  });

  it("经济性有但产业价值缺 → CANDIDATE", () => {
    expect(screenCandidate(base({ industryValuePresent: false })).verdict).toBe("CANDIDATE");
  });

  it("裁决取**第一个**未过闸：证据不足优先于经济缺失（应 NEED_MORE_EVIDENCE）", () => {
    const o = screenCandidate(base({ evidence: [], hasEconomics: false }));
    expect(o.verdict).toBe("NEED_MORE_EVIDENCE");
  });
});

describe("R8 · 置信度计数口径", () => {
  it("只计 confidence>=下限的证据；低置信再多也不足", () => {
    const weak = Array.from({ length: T.MIN_EVIDENCE_ITEMS + 5 }, () => ({ kind: "ASSUMPTION", confidence: 20 }));
    const o = screenCandidate(base({ evidence: weak }));
    expect(o.verdict).toBe("NEED_MORE_EVIDENCE");
  });
  it("边界：恰好达最低条数即通过证据闸", () => {
    expect(screenCandidate(base({ evidence: strong(T.MIN_EVIDENCE_ITEMS) })).gates.some((g) => g.key === "EVIDENCE" && g.passed)).toBe(true);
  });
});

describe("R8 · 脏输入保守降级", () => {
  it("paramCompleteness 非有限 / 越界 → clamp，缺字段一律按未满足", () => {
    expect(screenCandidate(base({ paramCompleteness: NaN })).verdict).toBe("NEED_MORE_EVIDENCE");
    expect(screenCandidate({ ...base(), paramCompleteness: 99 }).gates.find((g) => g.key === "PARAMS")!.passed).toBe(true);
    expect(screenCandidate({ ...base(), paramCompleteness: -1 }).verdict).toBe("NEED_MORE_EVIDENCE");
  });
  it("evidence / disqualifiers 非数组 → 视为空，不崩", () => {
    const o = screenCandidate({ ...base(), evidence: null as unknown as [], disqualifiers: "x" as unknown as [] });
    // evidence 空 → NEED_MORE_EVIDENCE
    expect(o.verdict).toBe("NEED_MORE_EVIDENCE");
  });
});

describe("R8 · toScreeningInput / assessCandidate 归一", () => {
  it("字符串空/空白降级为未满足；JSONB 脏值降级不崩", () => {
    const inp = toScreeningInput({
      title: "  ", // 空白 → 不算有标题
      region: "山西",
      technology: "换电重卡",
      evidence: "not-an-array" as unknown as [],
      paramCompleteness: 0.8,
      disqualifiers: null,
      hasEconomics: true,
      industryValuePresent: true,
    });
    expect(inp.titlePresent).toBe(false);
    expect(inp.evidence).toEqual([]);
    expect(inp.disqualifiers).toEqual([]);
  });
  it("assessCandidate 一步出裁决：完整草料 → READY_FOR_PROJECT", () => {
    const o = assessCandidate({
      title: "某高速充换电走廊",
      region: "山西",
      technology: "光储充换一体",
      evidence: strong(T.MIN_EVIDENCE_ITEMS),
      paramCompleteness: 1,
      disqualifiers: [],
      hasEconomics: true,
      industryValuePresent: true,
    });
    expect(o.verdict).toBe("READY_FOR_PROJECT");
  });
  it("assessCandidate：仅草草一条线索 → NEED_MORE_EVIDENCE（诚实）", () => {
    const o = assessCandidate({ title: "某个想法", region: null, technology: null });
    expect(o.verdict).toBe("NEED_MORE_EVIDENCE");
  });
});
