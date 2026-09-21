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
  listCandidatesPage,
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

describe("listCandidatesPage · 单一查询系统的分页视图（mandate §六）", () => {
  it("返回分页信封：page/pageSize/total/pageCount/hasPrev/hasNext 算术正确", async () => {
    mockPrisma.candidateProject.count = vi.fn(async () => 45);
    mockPrisma.candidateProject.findMany = vi.fn(async () => [{ id: "a1" }]);
    const res = await listCandidatesPage({ page: 2, pageSize: 10 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.total).toBe(45);
    expect(res.data.pageCount).toBe(5); // ceil(45/10)
    expect(res.data.page).toBe(2);
    expect(res.data.pageSize).toBe(10);
    expect(res.data.hasPrev).toBe(true);
    expect(res.data.hasNext).toBe(true);
    // skip 算术：第 2 页 × 每页 10 → 跳过 10 条
    const arg = mockPrisma.candidateProject.findMany.mock.calls[0][0];
    expect(arg.skip).toBe(10);
    expect(arg.take).toBe(10);
  });

  it("末页 hasNext=false、首页 hasPrev=false；total=0 → pageCount 兜底为 1", async () => {
    mockPrisma.candidateProject.count = vi.fn(async () => 20);
    mockPrisma.candidateProject.findMany = vi.fn(async () => []);
    const last = await listCandidatesPage({ page: 2, pageSize: 10 });
    expect(last.ok && "hasNext" in last.data && last.data.hasNext).toBe(false);
    expect(last.ok && "hasPrev" in last.data && last.data.hasPrev).toBe(true);

    mockPrisma.candidateProject.count = vi.fn(async () => 0);
    const empty = await listCandidatesPage({ page: 1, pageSize: 10 });
    expect(empty.ok).toBe(true);
    if (empty.ok) {
      expect(empty.data.pageCount).toBe(1);
      expect(empty.data.rows).toEqual([]);
      expect(empty.data.hasPrev).toBe(false);
      expect(empty.data.hasNext).toBe(false);
    }
  });

  it("verdict 是 status 的语义别名；二者同给时 status 优先（同一 where，无第二套逻辑）", async () => {
    mockPrisma.candidateProject.count = vi.fn(async () => 0);
    mockPrisma.candidateProject.findMany = vi.fn(async () => []);
    await listCandidatesPage({ verdict: "CANDIDATE" });
    let where = mockPrisma.candidateProject.findMany.mock.calls[0][0].where;
    expect(where.status).toBe("CANDIDATE");

    await listCandidatesPage({ verdict: "CANDIDATE", status: "REJECT" });
    where = mockPrisma.candidateProject.findMany.mock.calls[1][0].where;
    expect(where.status).toBe("REJECT"); // status 覆盖 verdict
  });

  it("非法 status/verdict/industry 被白名单挡在 where 外（不注入任意值）", async () => {
    mockPrisma.candidateProject.count = vi.fn(async () => 0);
    mockPrisma.candidateProject.findMany = vi.fn(async () => []);
    await listCandidatesPage({ status: "DROP TABLE", industry: "???" });
    const where = mockPrisma.candidateProject.findMany.mock.calls[0][0].where;
    expect(where.status).toBeUndefined();
    expect(where.industry).toBeUndefined();
  });

  it("region 走 insensitive contains；industry 合法值透传", async () => {
    mockPrisma.candidateProject.count = vi.fn(async () => 0);
    mockPrisma.candidateProject.findMany = vi.fn(async () => []);
    await listCandidatesPage({ region: " 山西 ", industry: "NEW_ENERGY" });
    const where = mockPrisma.candidateProject.findMany.mock.calls[0][0].where;
    expect(where.region).toEqual({ contains: "山西", mode: "insensitive" });
    expect(where.industry).toBe("NEW_ENERGY");
  });

  it("排序：createdAt/updatedAt asc|desc 透传；非法字段回落 createdAt desc", async () => {
    mockPrisma.candidateProject.count = vi.fn(async () => 0);
    mockPrisma.candidateProject.findMany = vi.fn(async () => []);
    await listCandidatesPage({ sortBy: "updatedAt", sortDir: "asc" });
    let orderBy = mockPrisma.candidateProject.findMany.mock.calls[0][0].orderBy;
    expect(orderBy).toEqual({ updatedAt: "asc" });

    await listCandidatesPage({ sortBy: "password", sortDir: "asc" });
    orderBy = mockPrisma.candidateProject.findMany.mock.calls[1][0].orderBy;
    expect(orderBy).toEqual({ createdAt: "asc" }); // 非法列回落 createdAt；方向独立白名单仍保留 asc
  });

  it("页码越界（page=999）不报错、返回空 rows + 正确元数据（诚实不 500）", async () => {
    mockPrisma.candidateProject.count = vi.fn(async () => 5);
    mockPrisma.candidateProject.findMany = vi.fn(async () => []);
    const res = await listCandidatesPage({ page: 999, pageSize: 10 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.rows).toEqual([]);
    expect(res.data.pageCount).toBe(1);
    expect(res.data.hasNext).toBe(false);
    // skip 仍按请求页算（大 skip 交 DB 返回空即可，store 不额外钳制 page）
    const arg = mockPrisma.candidateProject.findMany.mock.calls[0][0];
    expect(arg.skip).toBe((999 - 1) * 10);
  });

  it("pageSize 钳制到 [1,100]", async () => {
    mockPrisma.candidateProject.count = vi.fn(async () => 0);
    mockPrisma.candidateProject.findMany = vi.fn(async () => []);
    await listCandidatesPage({ pageSize: 9999 });
    expect(mockPrisma.candidateProject.findMany.mock.calls[0][0].take).toBe(100);
    await listCandidatesPage({ pageSize: -5 });
    expect(mockPrisma.candidateProject.findMany.mock.calls[1][0].take).toBe(1);
  });

  it("表未迁移（P2021）→ tableMissing，不假装空列表", async () => {
    mockPrisma.candidateProject.count = vi.fn(async () => {
      throw Object.assign(new Error("nope"), { code: "P2021" });
    });
    mockPrisma.candidateProject.findMany = vi.fn(async () => []);
    const res = await listCandidatesPage({});
    expect(res.ok).toBe(false);
    expect("tableMissing" in res && res.tableMissing).toBe(true);
  });
});
