import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mutateJson, fieldHints } from "@/components/admin/mutate";

/**
 * mutate.ts 薄封装单测（Phase 13 M7）——锁「fetch + 归一 api-guard 判别联合」这一被后台 6 个 client
 * 组件共用的唯一口径（宪法第 16 条）。重点守护本次新增的 **`data` 透出契约**：成功时把服务端派生
 * 元数据（如 AI 生成的 generation.wroteSections / cost）原样交给调用方，失败/网络错误时 `data` 缺席，
 * 避免各组件为读这些字段再抄一遍 fetch（漂移之源）。全程 `vi.stubGlobal("fetch", …)`，无网络无 DB。
 */

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mutateJson", () => {
  it("成功（ok:true）：返回 ok、status，并把剔除 ok 后的响应体挂到 data", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({ ok: true, solutionId: "s1", generation: { wroteSections: 5, cost: { totalCostUsd: 0.0042 } } }, 200),
    );
    const res = await mutateJson("/api/admin/solutions/s1/generate", "POST", { question: "x" });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.data).toEqual({
      solutionId: "s1",
      generation: { wroteSections: 5, cost: { totalCostUsd: 0.0042 } },
    });
    // ok 标志本身不重复塞进 data
    expect(res.data?.ok).toBeUndefined();
    // 带 body → 设 content-type
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ question: "x" }));
  });

  it("守卫/校验失败（非 2xx + error）：ok:false、message、fields，且 data 缺席", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse(
        { error: { code: "CONFLICT", message: "操作被守卫拒绝", details: { fields: { status: ["方案已发布，不自动改写"] } } } },
        409,
      ),
    );
    const res = await mutateJson("/api/admin/solutions/s1/generate", "POST", {});
    expect(res.ok).toBe(false);
    expect(res.status).toBe(409);
    expect(res.message).toBe("操作被守卫拒绝");
    expect(res.fields).toEqual({ status: ["方案已发布，不自动改写"] });
    expect(res.data).toBeUndefined();
  });

  it("2xx 但响应体 ok 非真：按失败处理、回落到 HTTP 码 message、data 缺席", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse({ ok: false }, 200));
    const res = await mutateJson("/api/admin/solutions/s1", "PATCH", { title: "t" });
    expect(res.ok).toBe(false);
    expect(res.message).toBe("请求失败（HTTP 200）");
    expect(res.data).toBeUndefined();
  });

  it("非法/空响应体（json 解析抛错）：不崩、归一失败", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Response);
    const res = await mutateJson("/api/admin/solutions/s1", "PATCH", {});
    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
    expect(res.message).toBe("请求失败（HTTP 500）");
  });

  it("网络错误（fetch reject）：ok:false、status 0、友好 message、data 缺席", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    const res = await mutateJson("/api/admin/solutions/s1", "DELETE");
    expect(res).toEqual({ ok: false, status: 0, message: "网络错误，请稍后重试" });
    expect(res.data).toBeUndefined();
  });

  it("body=undefined（如 DELETE）：不设 content-type、不发请求体", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse({ ok: true }, 200));
    await mutateJson("/api/admin/solutions/s1", "DELETE");
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers).toEqual({});
    expect(init.body).toBeUndefined();
  });
});

describe("fieldHints", () => {
  it("把按字段归类的原因摊平成非空字符串数组", () => {
    expect(fieldHints({ a: ["x", "y"], b: [""], c: ["z"] })).toEqual(["x", "y", "z"]);
  });
  it("无 fields → 空数组", () => {
    expect(fieldHints(undefined)).toEqual([]);
  });
});
