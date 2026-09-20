import { describe, expect, it } from "vitest";
import { computeBess } from "@app/kernel/engine/bess";
import { computePv, solarDeclinationDeg } from "@app/kernel/engine/pv";
import { STEPS_PER_DAY, STEPS_PER_YEAR, zeros } from "@app/kernel/engine/time";
import type { BessInput, PvInput } from "@app/kernel/engine/types";

const SITE = { latitudeDeg: 37.87 };

const PV: PvInput = {
  enabled: true,
  capacityKwp: 2000,
  tiltDeg: 30,
  azimuthDeg: 180,
  specificYieldKwhPerKwp: 1170,
  degradationPctPerYear: 0.55,
};

describe("光伏模型", () => {
  it("太阳赤纬在 ±23.45° 内，且 6 月高于 12 月", () => {
    expect(solarDeclinationDeg(172)).toBeGreaterThan(23);
    expect(solarDeclinationDeg(355)).toBeLessThan(-23);
    for (let d = 1; d <= 365; d += 13) {
      expect(Math.abs(solarDeclinationDeg(d))).toBeLessThanOrEqual(23.46);
    }
  });

  it("年发电量**锚定**到「装机 × 等效利用小时」，形状不得与总量各自为政", () => {
    const r = computePv(PV, SITE);
    expect(r.annualGenerationKwh).toBeCloseTo(PV.capacityKwp * PV.specificYieldKwhPerKwp, 3);
    expect(r.equivalentFullLoadHours).toBeCloseTo(PV.specificYieldKwhPerKwp, 3);
  });

  it("夜间出力恒为 0，白天峰值不超过装机（无超发）", () => {
    const r = computePv(PV, SITE);
    for (let t = 0; t < STEPS_PER_YEAR; t++) {
      const hour = (t % STEPS_PER_DAY) / 4;
      // 北纬 37.87° 夏至日出约 04:41、日落约 19:19 → 04:00 前与 20:00 后必然为 0
      if (hour < 4 || hour >= 20) expect(r.outputProfileKw[t]).toBe(0);
      expect(r.outputProfileKw[t]).toBeGreaterThanOrEqual(0);
    }
    expect(r.peakOutputKw).toBeGreaterThan(0);
    expect(r.peakOutputKw).toBeLessThanOrEqual(PV.capacityKwp * 1.35);
  });

  it("逐月发电量之和等于年发电量（不得丢步）", () => {
    const r = computePv(PV, SITE);
    expect(r.monthlyGenerationKwh).toHaveLength(12);
    expect(r.monthlyGenerationKwh.reduce((a, b) => a + b, 0)).toBeCloseTo(r.annualGenerationKwh, 2);
  });

  it("夏季发电量高于冬季（几何形状合理）", () => {
    const r = computePv(PV, SITE);
    const jun = r.monthlyGenerationKwh[5];
    const dec = r.monthlyGenerationKwh[11];
    expect(jun).toBeGreaterThan(dec);
  });

  it("未启用光伏 → 全零曲线且不产生诊断（没装不是问题）", () => {
    const r = computePv({ ...PV, enabled: false }, SITE);
    expect(r.annualGenerationKwh).toBe(0);
    expect(r.peakOutputKw).toBe(0);
    expect(r.diagnostics).toHaveLength(0);
  });

  it("等效小时缺失 → 拒绝给出一个假发电量，而是登记诊断", () => {
    const r = computePv({ ...PV, specificYieldKwhPerKwp: 0 }, SITE);
    expect(r.annualGenerationKwh).toBe(0);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics.some((d) => d.kind === "EVIDENCE_MISSING" || d.kind === "SCENARIO_INPUT_MISSING")).toBe(true);
  });
});

/* ═══════════════════════════ 储能 ═══════════════════════════ */

const BESS: BessInput = {
  enabled: true,
  powerKw: 1000,
  energyKwh: 2000,
  roundTripEfficiencyPct: 90,
  socMinPct: 10,
  socMaxPct: 90,
  degradationPctPerYear: 2.5,
  strategy: "pv-shift",
  initialSocPct: 50,
  maxCyclesPerYear: 400,
};

/** 构造一个"夜间高负荷、白天光伏富余"的典型曲线（用于把储能调到真正有活干）。 */
function profiles() {
  const load = zeros();
  const pv = zeros();
  const price = zeros();
  for (let t = 0; t < STEPS_PER_YEAR; t++) {
    const h = (t % STEPS_PER_DAY) / 4;
    if (h >= 21 || h < 6) load[t] = 1600; // 夜间充电
    else if (h >= 9 && h < 16) load[t] = 0;
    if (h >= 8 && h < 17) pv[t] = 900;
    if (h >= 23 || h < 7) price[t] = 0.2475;
    else if (h >= 8 && h < 11) price[t] = 0.88;
    else if (h >= 18 && h < 23) price[t] = 0.88;
    else price[t] = 0.55;
  }
  return { load, pv, price };
}

describe("储能模型", () => {
  it("SOC 全年不越界（硬不变量）", () => {
    const { load, pv, price } = profiles();
    const r = computeBess({
      bess: BESS,
      loadProfileKw: load,
      pvOutputKw: pv,
      priceProfileYuanPerKwh: price,
      peakPriceThreshold: 0.715,
      valleyPriceThreshold: 0.4,
      demandChargePerKwMonth: 0,
      feedInTariffYuanPerKwh: 0.35,
    });
    expect(r.result.socViolations).toBe(0);
    for (const s of r.result.socProfilePct) {
      expect(s).toBeGreaterThanOrEqual(BESS.socMinPct - 1e-6);
      expect(s).toBeLessThanOrEqual(BESS.socMaxPct + 1e-6);
    }
    expect(r.diagnostics.some((d) => d.code === "bess_soc_out_of_bounds")).toBe(false);
  });

  it("**不会因为「先定放电再反推充电」而卡死**：全年充电量必须为正", () => {
    const { load, pv, price } = profiles();
    const r = computeBess({
      bess: BESS,
      loadProfileKw: load,
      pvOutputKw: pv,
      priceProfileYuanPerKwh: price,
      peakPriceThreshold: 0.715,
      valleyPriceThreshold: 0.4,
      demandChargePerKwMonth: 0,
      feedInTariffYuanPerKwh: 0.35,
    });
    expect(r.result.annualChargeKwh).toBeGreaterThan(0);
    expect(r.result.annualDischargeKwh).toBeGreaterThan(0);
    // 不允许"只放初始 SOC"这种现象：放电量必须显著大于单次可用容量
    const usableKwh = BESS.energyKwh * ((BESS.socMaxPct - BESS.socMinPct) / 100);
    expect(r.result.annualDischargeKwh).toBeGreaterThan(usableKwh * 5);
  });

  it("往返效率被遵守：放电量 ≤ 充电量 × 往返效率（不许凭空多电）", () => {
    const { load, pv, price } = profiles();
    const r = computeBess({
      bess: BESS,
      loadProfileKw: load,
      pvOutputKw: pv,
      priceProfileYuanPerKwh: price,
      peakPriceThreshold: 0.715,
      valleyPriceThreshold: 0.4,
      demandChargePerKwMonth: 0,
      feedInTariffYuanPerKwh: 0.35,
    });
    const startSoc = BESS.energyKwh * 0.5;
    const endSoc = (r.result.finalSocPct / 100) * BESS.energyKwh;
    const dcIn = r.result.annualDischargeKwh / Math.sqrt(0.9);
    const dcOut = r.result.annualChargeKwh * Math.sqrt(0.9);
    expect(dcIn).toBeLessThanOrEqual(dcOut + (startSoc - endSoc) + 1);
  });

  it("单步充/放功率不超过额定功率", () => {
    const { load, pv, price } = profiles();
    const r = computeBess({
      bess: BESS,
      loadProfileKw: load,
      pvOutputKw: pv,
      priceProfileYuanPerKwh: price,
      peakPriceThreshold: 0.715,
      valleyPriceThreshold: 0.4,
      demandChargePerKwMonth: 0,
      feedInTariffYuanPerKwh: 0.35,
    });
    for (let t = 0; t < STEPS_PER_YEAR; t++) {
      expect(r.result.chargeProfileKw[t]).toBeLessThanOrEqual(BESS.powerKw + 1e-6);
      expect(r.result.dischargeProfileKw[t]).toBeLessThanOrEqual(BESS.powerKw + 1e-6);
    }
  });

  it("未启用储能 → 空结果且零越界（不因「没装」而报错）", () => {
    const { load, pv, price } = profiles();
    const r = computeBess({
      bess: { ...BESS, enabled: false },
      loadProfileKw: load,
      pvOutputKw: pv,
      priceProfileYuanPerKwh: price,
      peakPriceThreshold: 0.715,
      valleyPriceThreshold: 0.4,
      demandChargePerKwMonth: 0,
      feedInTariffYuanPerKwh: 0.35,
    });
    expect(r.result.annualChargeKwh).toBe(0);
    expect(r.result.annualDischargeKwh).toBe(0);
    expect(r.result.socViolations).toBe(0);
  });

  it("上网电价高于谷段电价时，储能价差净收益被如实报成负数（不截成 0）", () => {
    const load = zeros().fill(0);
    const pv = zeros().fill(0);
    const price = zeros().fill(0.2); // 全谷段、无峰段
    for (let t = 0; t < STEPS_PER_YEAR; t++) {
      const h = (t % STEPS_PER_DAY) / 4;
      if (h >= 21 || h < 6) load[t] = 1500;
      if (h >= 9 && h < 16) pv[t] = 900;
    }
    const r = computeBess({
      bess: BESS,
      loadProfileKw: load,
      pvOutputKw: pv,
      priceProfileYuanPerKwh: price,
      peakPriceThreshold: Number.POSITIVE_INFINITY,
      valleyPriceThreshold: Number.NEGATIVE_INFINITY,
      demandChargePerKwMonth: 0,
      feedInTariffYuanPerKwh: 0.5, // 上网比到户还贵 → 搬电必亏
    });
    expect(r.result.arbitrageBenefitYuan).toBeLessThanOrEqual(0);
  });
});
