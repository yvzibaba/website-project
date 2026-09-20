/**
 * 光伏系统模型（PV）—— 逐 15 分钟出力曲线 + 年发电量。
 *
 * ## 一个刻意的建模取舍：**形状来自物理，总量来自基准**
 *
 * 要做逐时能量平衡，就必须有逐时出力形状；但拿不到当地实测辐照数据时，如果凭空写一个
 * "日照系数"，形状就是编的。本模块的做法把这两件事**分开**、各自诚实：
 *
 *   - **形状**由太阳几何算出（赤纬、时角、倾角、方位角、太阳高度角），
 *     这是物理确定的量，不依赖任何数据源；日出前/日落后严格为 0，季节变化自然出现；
 *   - **总量**锚定到基准层的「年等效利用小时」——一个可以被人核实/替换的行业参数。
 *
 * 于是：`出力(t) = 几何形状(t) × 缩放系数`，缩放系数由「年总量 = 装机 × 等效小时」反解。
 * 好处是**总量永远等于把参数写死时的值**（可对账），而形状永远物理自洽（不会出现夜间发电）。
 * 代价是：形状里不含当地云量/阴雨的季节差异——这一点在报告的假设清单里明确写出，不假装有。
 *
 * ## 为什么不引第三方库
 *
 * 完整辐照模型（如 pvlib）需要气象数据源、气溶胶、云量等输入，本项目当前没有这些数据的
 * 可核实来源。与其引入一个跑不出正确结果的依赖，不如用一个透明、可逐行核对的几何模型，
 * 并把"缺的是什么"写清楚。
 */

import {
  STEPS_PER_YEAR,
  STEPS_PER_DAY,
  STEPS_PER_HOUR,
  DAYS_PER_YEAR,
  TIME_STEP_MINUTES,
  zeros,
  sumByMonth,
  stepToDay,
  hourOfDay,
} from "@app/kernel/engine/time";
import type { Diagnostic, PvInput, TimeSeries } from "@app/kernel/engine/types";

/** 光伏模型版本。 */
export const PV_MODEL_VERSION = "1.0.0";
export function pvModelCalcRef(): string {
  return `pv@${PV_MODEL_VERSION}`;
}

const DT_HOURS = TIME_STEP_MINUTES / 60;
const DEG = Math.PI / 180;
/** 太阳常数（W/m²）。 */
export const SOLAR_CONSTANT_W_PER_M2 = 1367;

/** 太阳赤纬（度）——Cooper 近似，输入一年中的第几天（1..365）。 */
export function solarDeclinationDeg(dayOfYear1: number): number {
  return 23.45 * Math.sin(((360 * (284 + dayOfYear1)) / 365) * DEG);
}

/**
 * 倾斜面上的入射角余弦（含太阳高度角为正的判断）。
 * 约定：方位角以**正南为 0**，向西为正（−90 = 正东，+90 = 正西）。
 * 太阳在地平线下 → 返回 0（而不是负数），保证出力永不为负。
 */
export function cosIncidence(
  latitudeDeg: number,
  declinationDeg: number,
  hourAngleDeg: number,
  tiltDeg: number,
  azimuthDeg: number,
): number {
  const phi = latitudeDeg * DEG;
  const dec = declinationDeg * DEG;
  const omega = hourAngleDeg * DEG;
  const beta = tiltDeg * DEG;
  const gamma = azimuthDeg * DEG;
  const cosTheta =
    Math.sin(dec) * Math.sin(phi) * Math.cos(beta) -
    Math.sin(dec) * Math.cos(phi) * Math.sin(beta) * Math.cos(gamma) +
    Math.cos(dec) * Math.cos(phi) * Math.cos(beta) * Math.cos(omega) +
    Math.cos(dec) * Math.sin(phi) * Math.sin(beta) * Math.cos(gamma) * Math.cos(omega) +
    Math.cos(dec) * Math.sin(beta) * Math.sin(gamma) * Math.sin(omega);
  // 太阳高度角：sin(alpha) = sin(phi)sin(dec) + cos(phi)cos(dec)cos(omega)
  const sinAltitude = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(omega);
  if (sinAltitude <= 0) return 0;
  return Math.max(0, cosTheta);
}

/** 大气透过率（透明简化常数，用于形状归一，不影响年总量）。 */
const ATMOSPHERIC_TRANSMITTANCE = 0.75;

/** 归一化几何形状（无量纲，只决定出力在时间上的分布）。 */
export function solarShape(
  latitudeDeg: number,
  tiltDeg: number,
  azimuthDeg: number,
  step: number,
): number {
  const day = stepToDay(step);
  const dayOfYear1 = day + 1;
  const hour = hourOfDay(step);
  // 真太阳时用当地钟点近似（不做时差方程与经度修正——本模型不需要分钟级精度）
  const hourAngle = 15 * (hour - 12);
  const dec = solarDeclinationDeg(dayOfYear1);
  const cosT = cosIncidence(latitudeDeg, dec, hourAngle, tiltDeg, azimuthDeg);
  if (cosT <= 0) return 0;
  const g0 = SOLAR_CONSTANT_W_PER_M2 * (1 + 0.033 * Math.cos(((360 * dayOfYear1) / 365) * DEG));
  const sinAltitude =
    Math.sin(latitudeDeg * DEG) * Math.sin(dec * DEG) +
    Math.cos(latitudeDeg * DEG) * Math.cos(dec * DEG) * Math.cos(hourAngle * DEG);
  if (sinAltitude <= 0) return 0;
  return cosT * g0 * sinAltitude * ATMOSPHERIC_TRANSMITTANCE;
}

export interface PvComputation {
  /** 逐 15 分钟出力（kW，交流侧）。 */
  outputProfileKw: TimeSeries;
  /** 年发电量（kWh）。 */
  annualGenerationKwh: number;
  /** 逐月发电量（kWh，长度 12）。 */
  monthlyGenerationKwh: number[];
  /** 形状 → 出力 的缩放系数（kW 每单位形状；供审计"总量是否等于装机×等效小时"）。 */
  shapeScale: number;
  /** 年峰出力（kW），用于并网容量校核。 */
  peakOutputKw: number;
  /** 等效满发小时（核验值，应等于输入的年等效利用小时）。 */
  equivalentFullLoadHours: number;
  diagnostics: Diagnostic[];
}

/**
 * 主计算：光伏系统 → 逐 15 分钟出力曲线。
 *
 * 未启用光伏 → 全零曲线且不产生诊断（"没装"不是问题）。
 */
export function computePv(pv: PvInput, site: { latitudeDeg: number }): PvComputation {
  const diagnostics: Diagnostic[] = [];
  const output = zeros();

  if (!pv.enabled || pv.capacityKwp <= 0) {
    return {
      outputProfileKw: output,
      annualGenerationKwh: 0,
      monthlyGenerationKwh: new Array(12).fill(0),
      shapeScale: 0,
      peakOutputKw: 0,
      equivalentFullLoadHours: 0,
      diagnostics,
    };
  }

  if (!(pv.specificYieldKwhPerKwp > 0)) {
    diagnostics.push({
      kind: "EVIDENCE_MISSING",
      code: "pv_specific_yield_missing",
      message: "缺少光伏年等效利用小时（基准参数），无法确定年发电量。",
      field: "pv.specificYieldKwhPerKwp",
      impact: "光伏收益与自用率无法计算；本情景的光伏出力按 0 计，结论会低估光伏价值。",
      suggestion: "补充当地光伏年等效利用小时（可由当地同类电站实际发电量除以装机得到）。",
    });
    return {
      outputProfileKw: output,
      annualGenerationKwh: 0,
      monthlyGenerationKwh: new Array(12).fill(0),
      shapeScale: 0,
      peakOutputKw: 0,
      equivalentFullLoadHours: 0,
      diagnostics,
    };
  }

  /* ── 1) 形状（几何） ── */
  const shape = zeros();
  let shapeSum = 0;
  for (let t = 0; t < STEPS_PER_YEAR; t++) {
    const s = solarShape(site.latitudeDeg, pv.tiltDeg, pv.azimuthDeg, t);
    shape[t] = s;
    shapeSum += s;
  }
  if (shapeSum <= 0) {
    diagnostics.push({
      kind: "CALCULATION_ERROR",
      code: "pv_zero_shape",
      message: "光伏几何形状计算结果全为 0（倾角/方位角/纬度的组合使电池板全年无有效入射）。",
      impact: "无法计算光伏出力，本情景不可用。",
      suggestion: "请检查纬度、倾角与方位角设置；方位角以正南为 0，西为正。",
    });
    return {
      outputProfileKw: output,
      annualGenerationKwh: 0,
      monthlyGenerationKwh: new Array(12).fill(0),
      shapeScale: 0,
      peakOutputKw: 0,
      equivalentFullLoadHours: 0,
      diagnostics,
    };
  }

  /* ── 2) 缩放：令 Σ(出力×Δt) = 装机 × 等效小时 ── */
  const targetKwh = pv.capacityKwp * pv.specificYieldKwhPerKwp;
  const shapeEnergy = shapeSum * DT_HOURS; // 形状的"等效小时"总量
  const scale = targetKwh / shapeEnergy; // kW / 形状单位

  let annual = 0;
  let peak = 0;
  for (let t = 0; t < STEPS_PER_YEAR; t++) {
    const kw = shape[t] * scale;
    output[t] = kw;
    annual += kw * DT_HOURS;
    if (kw > peak) peak = kw;
  }

  const monthly = sumByMonth(output.map((v) => v * DT_HOURS));

  if (pv.tiltDeg < 0 || pv.tiltDeg > 90) {
    diagnostics.push({
      kind: "SCENARIO_INPUT_MISSING",
      code: "pv_tilt_out_of_range",
      message: "光伏倾角超出 0–90 度的合理范围。",
      field: "pv.tiltDeg",
      suggestion: "请按实际支架倾角填写（固定式通常 20–40 度）。",
    });
  }

  return {
    outputProfileKw: output,
    annualGenerationKwh: round2(annual),
    monthlyGenerationKwh: monthly.map(round2),
    shapeScale: scale,
    peakOutputKw: round2(peak),
    equivalentFullLoadHours: round2(pv.capacityKwp > 0 ? annual / pv.capacityKwp : 0),
    diagnostics,
  };
}

/** 典型日出力曲线（kW），供 UI 与报告画图。 */
export function typicalDayPvKw(outputProfileKw: TimeSeries, day: number): { hours: number[]; valuesKw: number[] } {
  const hours: number[] = [];
  const valuesKw: number[] = [];
  const base = Math.max(0, Math.min(DAYS_PER_YEAR - 1, day)) * STEPS_PER_DAY;
  for (let s = 0; s < STEPS_PER_DAY; s++) {
    hours.push(s / STEPS_PER_HOUR);
    valuesKw.push(round2(outputProfileKw[base + s] ?? 0));
  }
  return { hours, valuesKw };
}

function round2(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100) / 100;
}
