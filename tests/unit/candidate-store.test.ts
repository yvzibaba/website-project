/* eslint-disable @typescript-eslint/no-explicit-any */
// (vitest mock prisma 用 any 承接口是刻意宽松：本测只关心"数据形状对不对"，不重复 Prisma 客户端类型)
import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * R8 · candidate-store 单测（mock prisma，不连库）。
 * 钉死三件事：① 写入即由**纯函数六闸**裁决并落到 status + screeningResult 快照（程序算非 LLM）；
 * ② 快照带 inputs → 可拿 screenCandidate 复现同一 verdict（规则 7 可复算）；
 * ③ P2021（表未迁移）→ 降级为 tableMissing，不假装成功、不崩（迁移应用属创始人域）。
 */

const { mockPrisma } = vi.hoisted(() => ({ mockPrisma: { candidateProject: {} as Record<string, any> } }));
vi.mock("@app/kernel/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@app/kernel/lib/logger", () => ({
  logger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));

import {
  createCandidate,
  listCandidates,
  screenAndSave,
  CANDIDATE_STORE_VERSION,
  type CreateCandidateInput,
} from "@app/kernel/server/candidate-store";
import {
  screenCandidate,
  SCREENING_THRESHOLDS,
} from "@app/kernel/lib/candidate-screening";

const strong = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ claim: `e${i}`, kind: "FACT", confidence: 80 }));

function baseInput(over: Partial<CreateCandidateInput> = {}): CreateCandidateInput {
  return {
    title: "山西大同新能源重卡换电站网络",
    region: "山西大同",
    technology: "换电重卡 + 光储充",
    source: "官网新闻稿",
    sourceType: "MANUAL",
    description: "年运力 500 万吨，规划 12 座站",
    estimatedScale: "12 站 / 200 台车",
    evidence: strong(4),
    ...over,
  };
}

beforeEach(() => {
  mockPrisma.candidateProject = {};
});

describe("createCandidate · 写入即程序裁决 + 落快照", () => {
  it("证据足 / 要素齐 / 有 hint 经济+产业价值 → READY_FOR_PROJECT，status=verdict", async () => {
    let captured: any = null;
    mockPrisma.candidateProject.create = vi.fn(async ({ data }) => {
      captured = data;
      return { id: "cand_ready_0001", ...data, createdAt: new Date(), updatedAt: new Date(), version: 1 };
    });

    const res = await createCandidate(
      baseInput({ screeningHints: { hasEconomics: true, industryValuePresent: true } }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.status).toBe("READY_FOR_PROJECT");
    // 落库列：status 与快照 verdict 一致；industry 默认 NEW_ENERGY；evidence 原样入 JSONB。
    expect(captured.status).toBe("READY_FOR_PROJECT");
    expect(captured.industry).toBe("NEW_ENERGY");
    expect(Array.isArray(captured.evidence)).toBe(true);
    const snap = captured.screeningResult;
    expect(snap.verdict).toBe("READY_FOR_PROJECT");
    expect(snap.gates).toHaveLength(6 + 0); // 六闸（此例要素齐，无补挂发现软闸）
    expect(snap.thresholds).toEqual(SCREENING_THRESHOLDS);
    expect(snap.storeVersion).toBe(CANDIDATE_STORE_VERSION);
  });

  it("高置信证据不足 3 条 → NEED_MORE_EVIDENCE，reasons 指向证据闸", async () => {
    mockPrisma.candidateProject.create = vi.fn(async ({ data }) => ({ id: "cand_ev_0002", ...data }));
    const res = await createCandidate(baseInput({ evidence: strong(2) }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.status).toBe("NEED_MORE_EVIDENCE");
  });

  it("命中一票否决 disqualifiers → REJECT（即便证据足）", async () => {
    mockPrisma.candidateProject.create = vi.fn(async ({ data }) => ({ id: "cand_rej_0003", ...data }));
    const res = await createCandidate(
      baseInput({ screeningHints: { disqualifiers: ["许可证未核实"], hasEconomics: true, industryValuePresent: true } }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // 证据足、要素齐 → 卡在约束闸一票否决
    expect(res.data.status).toBe("REJECT");
  });

  it("快照 inputs 可用 screenCandidate 复现同一 verdict（可复算 · 规则 7）", async () => {
    let captured: any = null;
    mockPrisma.candidateProject.create = vi.fn(async ({ data }) => {
      captured = data;
      return { id: "cand_rep_0004", ...data };
    });
    await createCandidate(baseInput({ screeningHints: { hasEconomics: true } }));
    const snap = captured.screeningResult;
    const replay = screenCandidate(snap.inputs);
    expect(replay.verdict).toBe(snap.verdict);
  });

  it("title 为空 → invalid（写边界 zod 把关，不落库）", async () => {
    const create = vi.fn();
    mockPrisma.candidateProject.create = create;
    const res = await createCandidate(baseInput({ title: "   " }));
    expect(res.ok).toBe(false);
    expect("invalid" in res && res.invalid).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  it("表未迁移（P2021）→ tableMissing，不抛不假装", async () => {
    mockPrisma.candidateProject.create = vi.fn(async () => {
      throw Object.assign(new Error("table missing"), { code: "P2021" });
    });
    const res = await createCandidate(baseInput());
    expect(res.ok).toBe(false);
    expect("tableMissing" in res && res.tableMissing).toBe(true);
  });
});

describe("listCandidates / screenAndSave", () => {
  it("list 默认倒序取回；表未迁移 → tableMissing", async () => {
    mockPrisma.candidateProject.findMany = vi.fn(async () => [{ id: "x1" }, { id: "x2" }]);
    const res = await listCandidates({ limit: 10 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toHaveLength(2);

    mockPrisma.candidateProject.findMany = vi.fn(async () => {
      throw Object.assign(new Error("nope"), { code: "P2021" });
    });
    const miss = await listCandidates();
    expect(miss.ok).toBe(false);
    expect("tableMissing" in miss && miss.tableMissing).toBe(true);
  });

  it("screenAndSave 复用上次快照 inputs 并 version+1", async () => {
    mockPrisma.candidateProject.findUnique = vi.fn(async () => ({
      id: "candrs00000005",
      title: "既有候选",
      region: "山西",
      technology: "换电",
      description: "有描述",
      estimatedScale: null,
      evidence: strong(3),
      screeningResult: {
        verdict: "CANDIDATE",
        inputs: { paramCompleteness: 0.9, disqualifiers: [], hasEconomics: true, industryValuePresent: true },
      },
    }));
    let updated: any = null;
    mockPrisma.candidateProject.update = vi.fn(async ({ data }) => {
      updated = data;
      return { id: "candrs00000005", ...data };
    });
    const res = await screenAndSave("candrs00000005");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(updated.status).toBe("READY_FOR_PROJECT"); // 复用了上次 hasEconomics/industryValue hints
    expect(updated.version).toEqual({ increment: 1 });
  });

  it("screenAndSave 非法 id → notFound，不查库", async () => {
    const findUnique = vi.fn();
    mockPrisma.candidateProject.findUnique = findUnique;
    const res = await screenAndSave("bad id!!");
    expect(res.ok).toBe(false);
    expect("notFound" in res && res.notFound).toBe(true);
    expect(findUnique).not.toHaveBeenCalled();
  });
});
