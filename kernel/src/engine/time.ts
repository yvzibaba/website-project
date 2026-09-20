/**
 * V2 统一时间轴（15 分钟）—— 全引擎**唯一**的时间粒度定义。
 *
 * ## 为什么必须只有一处
 *
 * 重卡充电负荷、光伏出力、峰谷电价、储能充放必须在**同一条时间轴**上比较，
 * 否则「光伏覆盖了多少充电负荷」这类结论根本无从计算。V1 用「年度总量平衡」
 * 绕过了这个问题，代价是**消纳价值恒为 0**（富余电量与下网电量被当作互斥）。
 * V2 的核心升级就是把它变成逐时段问题——而逐时段问题只有一条轴才不会自相矛盾。
 *
 * 因此：任何模块不得自行定义步长，一律 import 本文件。
 *
 * ## 约定
 *
 * - 一年 = 365 天（**刻意不建闰年**：决策模型不需要闰年精度，建闰年会让
 *   「同一输入跨年重算」产生不同结果，破坏可复算性）。
 * - 步索引 `step ∈ [0, 35040)`，从 1 月 1 日 00:00 起算，步 `t` 覆盖
 *   `[t·15min, (t+1)·15min)`。
 * - 电价/出力取**该时段起点**的瞬时口径，不做区间平均（口径统一即可，避免双重平均）。
 * - 所有聚合（月/年）走本文件提供的索引表，禁止各模块自行累加月天数。
 */

/** 时间轴契约版本（改步长/天数/月份口径 = 破坏性，须升版）。 */
export const TIME_AXIS_VERSION = "1.0.0";

/** 时间步长（分钟）。V2 全引擎唯一粒度。 */
export const TIME_STEP_MINUTES = 15;
/** 每小时步数。 */
export const STEPS_PER_HOUR = 60 / TIME_STEP_MINUTES; // 4
/** 每天步数。 */
export const STEPS_PER_DAY = 24 * STEPS_PER_HOUR; // 96
/** 一年天数（固定 365，见头注）。 */
export const DAYS_PER_YEAR = 365;
/** 一年步数。 */
export const STEPS_PER_YEAR = DAYS_PER_YEAR * STEPS_PER_DAY; // 35040

/** 小时 → 步。 */
export function hoursToSteps(hours: number): number {
  return hours * STEPS_PER_HOUR;
}

/** 步 → 小时（浮点，便于取时段起点）。 */
export function stepToHour(step: number): number {
  return step / STEPS_PER_HOUR;
}

/** 步 → 所在天（0-based）。 */
export function stepToDay(step: number): number {
  return Math.floor(step / STEPS_PER_DAY);
}

/** 步 → 一天内的第几步（0..95）。 */
export function stepInDay(step: number): number {
  return step % STEPS_PER_DAY;
}

/** 步 → 当天小时（0..24 的浮点，时段起点）。 */
export function hourOfDay(step: number): number {
  return stepInDay(step) / STEPS_PER_HOUR;
}

/** 每月的天数（非闰年）。 */
export const DAYS_IN_MONTH: readonly number[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** 每月起始天（0-based，长度 12）。 */
export const MONTH_START_DAY: readonly number[] = (() => {
  const out: number[] = [];
  let acc = 0;
  for (const d of DAYS_IN_MONTH) {
    out.push(acc);
    acc += d;
  }
  return out;
})();

/** 步 → 月份索引（0..11）。 */
export function stepToMonth(step: number): number {
  const day = stepToDay(step);
  // 12 个月，线性扫描足够（每步最多 12 次比较；避免为月份建 35040 长数组）
  for (let m = 11; m >= 0; m--) {
    if (day >= MONTH_START_DAY[m]) return m;
  }
  return 0;
}

/** 月份索引 → 该月步区间 `[start, end)`。 */
export function monthStepRange(month: number): { start: number; end: number } {
  const m = Math.max(0, Math.min(11, Math.floor(month)));
  const start = MONTH_START_DAY[m] * STEPS_PER_DAY;
  const end = (MONTH_START_DAY[m] + DAYS_IN_MONTH[m]) * STEPS_PER_DAY;
  return { start, end };
}

/**
 * 一年中的第几天（0-based）→ 用于季节性建模。
 * 刻意提供**两种**季节口径：
 *   - `dayOfYearPhase`：连续的 [0,1) 相位（正弦季节曲线用）；
 *   - `stepToMonth`：自然月（月度电价/统计用）。
 */
export function dayOfYearPhase(day: number): number {
  return (day % DAYS_PER_YEAR) / DAYS_PER_YEAR;
}

/** 生成 0..STEPS_PER_YEAR-1 的步索引数组（供 `map` 之外的显式遍历）。 */
export function allSteps(): number[] {
  const out = new Array<number>(STEPS_PER_YEAR);
  for (let i = 0; i < STEPS_PER_YEAR; i++) out[i] = i;
  return out;
}

/** 新建一条与时间轴等长的零序列。 */
export function zeros(): number[] {
  return new Array<number>(STEPS_PER_YEAR).fill(0);
}

/**
 * 逐月求和（用月份步区间，不自行累加月天数）。
 * 返回长度 12 的数组（元，或 kWh / kW…由调用方决定）。
 */
export function sumByMonth(series: readonly number[]): number[] {
  const out = new Array<number>(12).fill(0);
  for (let m = 0; m < 12; m++) {
    const { start, end } = monthStepRange(m);
    let s = 0;
    for (let t = start; t < end; t++) s += series[t] ?? 0;
    out[m] = s;
  }
  return out;
}

/** 全年求和。 */
export function sumAll(series: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < series.length; i++) s += series[i];
  return s;
}

/**
 * 序列 × 步长（小时）= 电量（kWh）。
 * 功率序列（kW）→ 电量；已是电量序列时调用方不得再乘（口径显式写出来）。
 */
export function powerToEnergy(series: readonly number[]): number {
  const dt = TIME_STEP_MINUTES / 60;
  let s = 0;
  for (let i = 0; i < series.length; i++) s += series[i] * dt;
  return s;
}

/** 峰值（kW）。空序列 → 0。 */
export function peakOf(series: readonly number[]): number {
  let p = 0;
  for (let i = 0; i < series.length; i++) if (series[i] > p) p = series[i];
  return p;
}

/** 均值（按步数平均，非按小时加权——对等步长序列二者等价）。 */
export function meanOf(series: readonly number[]): number {
  if (series.length === 0) return 0;
  return sumAll(series) / series.length;
}

/**
 * 逐时段电价向量 → 加权平均电价（元/kWh）。
 * 权重用**各步实际下网电量**，而不是简单算术平均——否则低谷大电量会被高估成本。
 * 总电量为 0 → 返回 null（诚实：无从求平均，不返回 0 冒充）。
 */
export function weightedAveragePrice(
  price: readonly number[],
  energy: readonly number[],
): number | null {
  let num = 0;
  let den = 0;
  const n = Math.min(price.length, energy.length);
  for (let i = 0; i < n; i++) {
    num += price[i] * energy[i];
    den += energy[i];
  }
  return den > 0 ? num / den : null;
}
