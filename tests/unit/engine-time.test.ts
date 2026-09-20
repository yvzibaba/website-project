import { describe, expect, it } from "vitest";
import {
  DAYS_IN_MONTH,
  DAYS_PER_YEAR,
  MONTH_START_DAY,
  STEPS_PER_DAY,
  STEPS_PER_HOUR,
  STEPS_PER_YEAR,
  TIME_STEP_MINUTES,
  meanOf,
  monthStepRange,
  peakOf,
  powerToEnergy,
  stepToDay,
  stepToMonth,
  sumAll,
  sumByMonth,
  weightedAveragePrice,
  zeros,
} from "@app/kernel/engine/time";

describe("V2 统一时间轴", () => {
  it("时间轴常量自洽：15 分钟 × 4 × 24 × 365 = 35,040", () => {
    expect(TIME_STEP_MINUTES).toBe(15);
    expect(STEPS_PER_HOUR).toBe(4);
    expect(STEPS_PER_DAY).toBe(96);
    expect(DAYS_PER_YEAR).toBe(365);
    expect(STEPS_PER_YEAR).toBe(35040);
    expect(STEPS_PER_DAY * DAYS_PER_YEAR).toBe(STEPS_PER_YEAR);
  });

  it("按 365 天建模，不含闰年（可复现性优先于日历精度）", () => {
    expect(DAYS_IN_MONTH.reduce((a, b) => a + b, 0)).toBe(365);
  });

  it("月份步区间首尾相接、恰好覆盖全年且无重叠", () => {
    let cursor = 0;
    for (let m = 0; m < 12; m++) {
      const { start, end } = monthStepRange(m);
      expect(start).toBe(cursor);
      expect(end).toBe(MONTH_START_DAY[m] * STEPS_PER_DAY + DAYS_IN_MONTH[m] * STEPS_PER_DAY);
      cursor = end;
    }
    expect(cursor).toBe(STEPS_PER_YEAR);
  });

  it("stepToDay / stepToMonth 与月份区间一致", () => {
    for (let t = 0; t < STEPS_PER_YEAR; t += 997) {
      const m = stepToMonth(t);
      const { start, end } = monthStepRange(m);
      expect(t).toBeGreaterThanOrEqual(start);
      expect(t).toBeLessThan(end);
      expect(stepToDay(t)).toBe(Math.floor(t / STEPS_PER_DAY));
    }
  });

  it("sumByMonth 的 12 个月之和恒等于 sumAll（不得丢步）", () => {
    const s = zeros().map((_, i) => i % 7);
    const monthly = sumByMonth(s);
    expect(monthly).toHaveLength(12);
    const total = monthly.reduce((a, b) => a + b, 0);
    expect(Math.abs(total - sumAll(s))).toBeLessThan(1e-6);
  });

  it("powerToEnergy 按步长（0.25 h）折算功率到电量", () => {
    const kw = zeros().fill(1000); // 全年 1000 kW
    expect(powerToEnergy(kw)).toBeCloseTo(1000 * 8760, 3);
  });

  it("peakOf / meanOf / weightedAveragePrice 的口径正确", () => {
    const p = zeros().fill(0);
    p[10] = 500;
    p[20] = 200;
    expect(peakOf(p)).toBe(500);
    expect(meanOf(p)).toBeCloseTo(700 / STEPS_PER_YEAR, 9);

    // 加权平均：一半电量在 1 元、一半在 3 元 → 2 元
    const price = zeros().fill(1);
    const energy = zeros().fill(0);
    for (let t = 0; t < STEPS_PER_YEAR / 2; t++) energy[t] = 1;
    for (let t = STEPS_PER_YEAR / 2; t < STEPS_PER_YEAR; t++) {
      energy[t] = 1;
      price[t] = 3;
    }
    expect(weightedAveragePrice(price, energy)).toBeCloseTo(2, 9);
  });

  it("weightedAveragePrice 在零电量时返回 null（不是 0，也不是均价）", () => {
    expect(weightedAveragePrice(zeros().fill(0.5), zeros())).toBeNull();
  });
});
