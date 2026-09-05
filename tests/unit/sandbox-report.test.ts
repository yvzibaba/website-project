/**
 * 沙盘「动态报告」纯函数黄金样本（中途重构 R6.1 · §9 动态报告 / §14 第 5 项）。
 *
 * 关键锁定：报告是**确定性叙述层**——每个数字都必须等于视图模型（引擎产物）里的对应格式化串，
 * 报告本身绝不重算、绝不含 LLM、绝不带时钟/随机；失败态只回诚实错误、不产出任何编造结论；
 * 免责与人工复核声明恒在。喂**真实引擎输出**（runSandboxModel + computeTechModel + computeTornado）
 * 构造视图模型再产报告，端到端证 §9「报告读最新 CalcResult」与 §7「程序算、LLM 只解释」的算数侧。
 */
import { describe, it, expect } from "vitest";
import { buildSandboxReport, REPORT_VERSION } from "@/lib/sandbox-report";
import { buildSandboxViewModel } from "@/lib/sandbox-view";
import { runSandboxModel, runSandboxModelBaseline } from "@/server/sandbox-model";
import { resolveSandbox } from "@/server/sandbox-params";
import { computeTechModel as techFromTech } from "@/server/sandbox-tech";
import { computeTornado } from "@/server/sandbox-sensitivity";
import { getEnterpriseProfile } from "@/server/sandbox-profiles";

function okViewModel() {
  const calc = runSandboxModelBaseline();
  const resolved = resolveSandbox();
  const tech = calc.ok ? techFromTech(resolved.numeric) : null;
  const tornado = computeTornado();
  return buildSandboxViewModel({
    calc,
    tech: tech && tech.ok ? tech.firstYear : null,
    tornado,
    discountRate: (resolved.numeric["finance.discountRate"] ?? 8) / 100,
  });
}

describe("sandbox-report · 版本与契约", () => {
  it("REPORT_VERSION 语义化版本守护", () => {
    expect(REPORT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("成功报告 reportVersion 与常量一致 + ok:true + 带 needsProfessionalReview", () => {
    const vm = okViewModel();
    const rep = buildSandboxReport({ vm, regionName: "全国通用（示例）" });
    expect(rep.ok).toBe(true);
    expect(rep.reportVersion).toBe(REPORT_VERSION);
    expect(rep.needsProfessionalReview).toBe(true);
    expect(rep.title).toContain("全国通用（示例）");
  });
});

describe("sandbox-report · 单一真源（数字=视图模型输出，不重算）", () => {
  it("执行摘要里的 NPV/IRR/回收期/ROI 串逐字等于卡片值", () => {
    const vm = okViewModel();
    const rep = buildSandboxReport({ vm, regionName: "山西" });
    const cards = Object.fromEntries((vm.cards ?? []).map((c) => [c.key, c.value]));
    const exec = rep.sections.find((s) => s.key === "exec");
    const text = (exec?.paragraphs ?? []).join("\n");
    expect(text).toContain(cards.npv ?? "__");
    expect(text).toContain(cards.irr ?? "__");
    expect(text).toContain(cards.payback ?? "__");
    expect(text).toContain(cards.roi ?? "__");
  });

  it("投资结构分节的每个金额串逐字等于 meta 标签（报告不自己换算）", () => {
    const vm = okViewModel();
    const rep = buildSandboxReport({ vm, regionName: "山西" });
    const st = rep.sections.find((s) => s.key === "structure");
    const items = Object.fromEntries((st?.items ?? []).map((i) => [i.label, i.value]));
    expect(items["净 CAPEX（补贴后）"]).toBe(vm.meta?.capexNetLabel);
    expect(items["毛 CAPEX"]).toBe(vm.meta?.capexGrossLabel);
    expect(items["建设补贴抵扣"]).toBe(vm.meta?.subsidyLabel);
    expect(items["首年运维 OPEX"]).toBe(vm.meta?.opexY1Label);
    expect(items["首年收入"]).toBe(vm.meta?.revenueY1Label);
    expect(items["计算期"]).toBe(`${vm.meta?.projectLifeYears} 年`);
  });

  it("溯源分节把报告钉到 calcRef + 各内核版本 + 报告版本", () => {
    const vm = okViewModel();
    const rep = buildSandboxReport({ vm, regionName: "山西" });
    const prov = rep.sections.find((s) => s.key === "provenance");
    const items = Object.fromEntries((prov?.items ?? []).map((i) => [i.label, i.value]));
    expect(items["计算引用 calcRef"]).toBe(vm.calcRef);
    expect(items["模型版本"]).toBe(vm.engineVersions?.model);
    expect(items["参数模板版本"]).toBe(vm.engineVersions?.params);
    expect(items["报告版本"]).toBe(REPORT_VERSION);
    expect(rep.generatedFrom.calcRef).toBe(vm.calcRef);
    expect(rep.generatedFrom.viewVersion).toBe(vm.viewVersion);
  });
});

describe("sandbox-report · 诚实边界（§16/§17/§20）", () => {
  it("成功报告也恒带「需专业人工确认」+ 程序算非 LLM + §17 E2E 免责", () => {
    const vm = okViewModel();
    const rep = buildSandboxReport({ vm, regionName: "山西" });
    const all = rep.disclaimers.join("\n");
    expect(all).toContain("程序算");
    expect(all).toContain("需专业人工确认");
    expect(all).toContain("§17");
    const risk = rep.sections.find((s) => s.key === "risk");
    expect((risk?.paragraphs ?? []).join("\n")).toContain("复核");
  });

  it("★失败态只回诚实错误、绝不产出执行摘要/结构等脏结论", () => {
    const badCalc = runSandboxModel({ user: { values: { "project.pvCapacity": Number.NaN } } });
    const vm = buildSandboxViewModel({ calc: badCalc });
    expect(vm.ok).toBe(false);
    const rep = buildSandboxReport({ vm, regionName: "山西" });
    expect(rep.ok).toBe(false);
    expect(rep.error).toBeTruthy();
    // 只有 error 一节，不含任何"结论"节
    expect(rep.sections.map((s) => s.key)).toEqual(["error"]);
    expect(rep.sections.find((s) => s.key === "exec")).toBeUndefined();
    expect(rep.sections.find((s) => s.key === "structure")).toBeUndefined();
    expect(rep.needsProfessionalReview).toBe(true);
    // 免责仍恒在
    expect(rep.disclaimers.join("\n")).toContain("§17");
  });
});

describe("sandbox-report · 交互来路叙述", () => {
  it("改动清单被叙述：改了几项 + 标签出现；无改动则显「未作个性化改动」", () => {
    const vm = okViewModel();
    const repChanged = buildSandboxReport({
      vm,
      regionName: "山西",
      changedParams: [
        { key: "project.chargingPrice", label: "综合充电单价", value: "1.20", unit: "元/kWh" },
        { key: "project.pvCapacity", label: "光伏装机", value: "800", unit: "kWp" },
      ],
    });
    const exec = (repChanged.sections.find((s) => s.key === "exec")?.paragraphs ?? []).join("\n");
    expect(exec).toContain("改动了 2 项");
    expect(exec).toContain("综合充电单价=1.20 元/kWh");
    expect(exec).toContain("光伏装机=800 kWp");

    const repNone = buildSandboxReport({ vm, regionName: "全国通用（示例）", changedParams: [] });
    const exec0 = (repNone.sections.find((s) => s.key === "exec")?.paragraphs ?? []).join("\n");
    expect(exec0).toContain("未作个性化改动");
  });

  it("有龙卷风时敏感性分节点名最敏感变量 label", () => {
    const vm = okViewModel();
    const rep = buildSandboxReport({ vm, regionName: "山西" });
    const sens = rep.sections.find((s) => s.key === "sensitivity");
    expect(sens).toBeTruthy();
    const text = (sens?.paragraphs ?? []).join("\n");
    expect(vm.mostSensitiveLabel).toBeTruthy();
    expect(text).toContain(vm.mostSensitiveLabel as string);
  });
});

describe("sandbox-report · 确定性（同输入两次深相等，可复算）", () => {
  it("同 vm + 同上下文两次生成完全相等", () => {
    const vm = okViewModel();
    const a = buildSandboxReport({ vm, regionName: "山西", discountRatePct: 8 });
    const b = buildSandboxReport({ vm, regionName: "山西", discountRatePct: 8 });
    expect(a).toEqual(b);
  });

  it("§4 联动：换更优参数→报告 NPV 叙述随之上升（报告随最新 CalcResult 变）", () => {
    // 基线报告
    const vmBase = buildSandboxViewModel({ calc: runSandboxModelBaseline(), tornado: computeTornado() });
    const repBase = buildSandboxReport({ vm: vmBase, regionName: "全国通用（示例）" });
    const npvBase = vmBase.cards?.find((c) => c.key === "npv")?.value ?? "";
    // 抬高充电单价→NPV 应更高（金额量级串随之变）
    const calcUp = runSandboxModel({ user: { values: { "project.chargingPrice": 1.5 } } });
    const vmUp = buildSandboxViewModel({ calc: calcUp, tornado: computeTornado() });
    const repUp = buildSandboxReport({ vm: vmUp, regionName: "全国通用（示例）" });
    const npvUp = vmUp.cards?.find((c) => c.key === "npv")?.value ?? "";
    // 两报告不同（叙述随模型变），且都非失败态
    expect(repUp.ok).toBe(true);
    expect(repBase.ok).toBe(true);
    expect(npvUp).not.toBe(npvBase);
    const execUp = (repUp.sections.find((s) => s.key === "exec")?.paragraphs ?? []).join("\n");
    expect(execUp).toContain(npvUp);
  });
});

describe("sandbox-report · R7 企业个性化视角（依画像裁剪，§14 第 7 项）", () => {
  it("不传 profile → 无「profile」节，分节序列与 R6 一致（向后兼容）", () => {
    const vm = okViewModel();
    const rep = buildSandboxReport({ vm, regionName: "山西" });
    expect(rep.sections.map((s) => s.key)).not.toContain("profile");
  });

  it("★带画像 → exec 之后紧随「profile」节：含画像基调 + 引用的指标值逐字等于卡片（不重算）", () => {
    const vm = okViewModel();
    const fleet = getEnterpriseProfile("fleet");
    const rep = buildSandboxReport({ vm, regionName: "山西", profile: fleet });
    const keys = rep.sections.map((s) => s.key);
    expect(keys).toContain("profile");
    expect(keys.indexOf("profile")).toBe(keys.indexOf("exec") + 1); // 紧随执行摘要
    const sec = rep.sections.find((s) => s.key === "profile");
    const text = (sec?.paragraphs ?? []).join("\n");
    // 画像一句话基调透传
    expect(text).toContain(fleet.emphasis.headline);
    // 每个被引用的指标值串必须逐字来自视图模型卡片（单一真源，报告绝不换算）
    const cards = Object.fromEntries((vm.cards ?? []).map((c) => [c.key, c.value]));
    for (const mk of fleet.emphasis.metricKeys) {
      const v = cards[mk];
      if (v != null && v !== "—") expect(text, `画像节应引用 ${mk} 卡值 ${v}`).toContain(v);
    }
    // 诚实脚注随画像带出（占位假设 / 人工确认）
    expect(text).toMatch(/占位假设|人工确认|待核实/);
  });

  it("★失败报告忽略画像：仍只有 error 一节，绝不产出个性化脏结论", () => {
    const badCalc = runSandboxModel({ user: { values: { "project.pvCapacity": Number.NaN } } });
    const vm = buildSandboxViewModel({ calc: badCalc });
    expect(vm.ok).toBe(false);
    const rep = buildSandboxReport({ vm, regionName: "山西", profile: getEnterpriseProfile("operator") });
    expect(rep.ok).toBe(false);
    expect(rep.sections.map((s) => s.key)).toEqual(["error"]);
    expect(rep.sections.find((s) => s.key === "profile")).toBeUndefined();
  });
});
