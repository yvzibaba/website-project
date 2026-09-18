/**
 * 财务评价原语（中途重构 R2.2）——《项目中途重构总控》§7「关键经济指标必须由程序计算，LLM 只解释」
 * 所要求的 CAPEX/OPEX/**现金流/NPV/IRR/ROI/回收期** 里的**评价数学内核**。
 *
 * 设计原则：
 *   ① **纯函数、确定性、无时钟/随机/IO**——同入必同出，可离线用黄金样本测死（宪法第 7 条：程序算 > 口算）。
 *   ② **诚实优先（第 20 条）**——IRR 无解（现金流无符号变化 / 二分不收敛）时返回 `ok:false` + 原因，
 *      **绝不返回一个编造的比率**；回收期超出分析期返回 null，不假设"迟早会回本"。
 *   ③ **单位口径**——现金流入参一律「元」（人民币），`flows[t]` 为第 t 年的**净现金流**（负=支出，t=0 通常是 −CAPEX）；
 *      比率以**小数**表示（0.1 = 10%），对外展示层再乘 100。
 *   ④ **数值稳健**——浮点结果统一按定点四舍五入去尾噪；对除零、非有限输入、rate≤−1 等一律早退到诚实分支。
 *      ⚠️ 本层产出是**决策沙盘的模型估算值**（且入参多来自 R1.2 的占位假设），不是会计台账；
 *      真正落库的货币精确算术在 R3 持久层用 Prisma `Decimal` 承接。沙盘的每个结论都属"高风险领域"，
 *      须走 §16「需要专业人工确认」——`runSandboxModel`（R2.4）会据此打 `needsProfessionalReview` 标记。
 *
 * 现金流约定（贯穿全模块）：`flows[0]` = 期初投资（一般为负 CAPEX），`flows[t]` = 第 t 年净现金流。
 */

/** 财务内核版本（改公式/收敛判据须升版并记录原因，宪法第 13 条）。 */
export const FINANCE_VERSION = "1.0.0";

/** 产出结果携带的计算来源引用（供报告/审计溯源"这组数是哪版引擎按什么口径算的"，第 7/16 条）。 */
export function financeCalcRef(): string {
  return `finance@${FINANCE_VERSION}`;
}

/** 定点四舍五入去浮点尾噪（对 -0 归一为 0）。 */
export function round(v: number, dp = 2): number {
  if (!Number.isFinite(v)) return v;
  const f = 10 ** dp;
  const r = Math.round((v + Number.EPSILON * v) * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

/** NPV 单期折现：把第 t 年的 flow 折到 t=0。rate≤−1 无定义 → 抛给调用方的有限性校验处理（返回 NaN）。 */
function discountFactor(rate: number, t: number): number {
  return (1 + rate) ** t;
}

/**
 * 净现值 NPV = Σ flows[t] / (1+rate)^t。
 * 非法入参（空数组、非有限 rate、rate≤−1、含非有限现金流）→ 返回 `NaN`（诚实"算不出"，绝不给假值）。
 */
export function npv(rate: number, flows: readonly number[]): number {
  if (!Array.isArray(flows) || flows.length === 0) return NaN;
  if (!Number.isFinite(rate) || rate <= -1) return NaN;
  let acc = 0;
  for (let t = 0; t < flows.length; t++) {
    const f = flows[t];
    if (!Number.isFinite(f)) return NaN;
    acc += f / discountFactor(rate, t);
  }
  return acc;
}

export interface IrrResult {
  ok: boolean;
  /** IRR（小数，0.1=10%）；仅 ok=true 时有效。 */
  value?: number;
  /** 失败原因（no_sign_change / no_bracket / not_converged / invalid_input）。 */
  reason?: string;
  /** 现金流符号变化次数；>1 提示可能存在多解（区间二分只保证找到其中一个根）。 */
  signChanges: number;
  /** 是否可能存在多个 IRR 根（符号变化 > 1）；true 时 value 是其中一个，需谨慎解读。 */
  multipleRootsPossible?: boolean;
}

/**
 * 内部收益率 IRR：使 NPV(irr)=0 的折现率。用**区间二分法**在 (-1, maxRate] 上求根（对常规"先负后正"现金流稳健）。
 *
 * 诚实判据：
 *   - 现金流无任何符号变化（全正或全负）→ 无经济意义 → ok:false `no_sign_change`。
 *   - 在搜索区间端点上 NPV 同号（未跨越零轴）→ 区间内无根或根在界外 → ok:false `no_bracket`
 *     （例如纯收益项目 IRR 可能 >maxRate，或不赚钱项目无正 IRR，绝不外推一个假数）。
 *   - 二分 `maxIter` 次仍未收敛到 tol → ok:false `not_converged`。
 * 返回的 value 以小数计、四舍五入到 6 位；`multipleRootsPossible` 在符号变化>1 时置真以示警。
 */
export function irr(
  flows: readonly number[],
  opts: { maxRate?: number; tol?: number; maxIter?: number } = {},
): IrrResult {
  const maxRate = opts.maxRate ?? 10; // 上界 1000%，覆盖绝大多数实业项目
  const tol = opts.tol ?? 1e-7;
  const maxIter = opts.maxIter ?? 200;

  if (!Array.isArray(flows) || flows.length < 2) {
    return { ok: false, reason: "invalid_input", signChanges: 0 };
  }
  if (flows.some((f) => !Number.isFinite(f))) {
    return { ok: false, reason: "invalid_input", signChanges: 0 };
  }

  // 统计符号变化次数（忽略 0，跳过到下一个非零符号）。
  let signChanges = 0;
  let prev = 0;
  for (const f of flows) {
    if (f === 0) continue;
    const s = f > 0 ? 1 : -1;
    if (prev !== 0 && s !== prev) signChanges++;
    prev = s;
  }
  if (signChanges === 0) {
    return { ok: false, reason: "no_sign_change", signChanges: 0 };
  }

  const lo = -0.999999;
  const hi = maxRate;
  const fLo = npv(lo, flows);
  const fHi = npv(hi, flows);
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi)) {
    return { ok: false, reason: "invalid_input", signChanges };
  }
  if (Math.sign(fLo) === Math.sign(fHi)) {
    // 区间端点同号：常规区间内无根（或存在偶数个根相互抵消）。诚实回报，不硬编一个数。
    return { ok: false, reason: "no_bracket", signChanges, multipleRootsPossible: signChanges > 1 };
  }

  let a = lo;
  let b = hi;
  let fa = fLo;
  for (let i = 0; i < maxIter; i++) {
    const mid = (a + b) / 2;
    const fm = npv(mid, flows);
    if (!Number.isFinite(fm)) {
      return { ok: false, reason: "not_converged", signChanges, multipleRootsPossible: signChanges > 1 };
    }
    if (Math.abs(fm) < tol || (b - a) / 2 < tol) {
      return {
        ok: true,
        value: round(mid, 6),
        signChanges,
        multipleRootsPossible: signChanges > 1,
      };
    }
    if (Math.sign(fa) !== Math.sign(fm)) {
      b = mid;
    } else {
      a = mid;
      fa = fm;
    }
  }
  return { ok: false, reason: "not_converged", signChanges, multipleRootsPossible: signChanges > 1 };
}

/**
 * 简单（未折现）静态回收期：累计净现金流转正所需年数（含小数插值）。
 * 约定 flows[0] < 0（期初投资）。超出分析期仍未回本 → 返回 `null`（绝不假设"迟早回本"）。
 * flows[0] ≥ 0 或非有限 → null（该指标对"无投资"无意义）。
 */
export function simplePaybackYears(flows: readonly number[]): number | null {
  return paybackCore(flows, (f) => f);
}

/** 折现回收期：把各年现金流按 rate 折现后再累计转正。rate≤−1 或非法 → null。 */
export function discountedPaybackYears(
  flows: readonly number[],
  rate: number,
): number | null {
  if (!Number.isFinite(rate) || rate <= -1) return null;
  return paybackCore(flows, (f, t) => f / discountFactor(rate, t));
}

function paybackCore(
  flows: readonly number[],
  term: (flow: number, t: number) => number,
): number | null {
  if (!Array.isArray(flows) || flows.length === 0) return null;
  if (flows.some((f) => !Number.isFinite(f))) return null;
  if (flows[0] >= 0) return null; // 无期初投资 → 回收期无定义

  let cum = term(flows[0], 0);
  if (cum >= 0) return 0;
  for (let t = 1; t < flows.length; t++) {
    const next = cum + term(flows[t], t);
    if (next >= 0) {
      // 在 (t-1, t] 之间线性插值：还差多少 -cum、本段挣了多少 (next-cum)。
      const span = next - cum;
      const frac = span > 0 ? -cum / span : 0;
      return round(t - 1 + frac, 2);
    }
    cum = next;
  }
  return null; // 分析期内从未回本
}

export interface RoiResult {
  ok: boolean;
  /** 投资回报率（小数，0.1=10%）；仅 ok=true 时有效。 */
  value?: number;
  reason?: string;
}

/**
 * 全周期 ROI（简单投资回报率）：净现值之外的粗口径——`(Σ_{t≥1} flows[t] − 0) / (−flows[0])`，
 * 即"后续各年流入之和 ÷ 期初投资"（flows[0] 为负投资；未折现）。
 * 说明：与 NPV/IRR 互补——ROI 直觉但忽略时间价值，故刻意不计入 flows[0] 之外的折现，也**不做多年年化**。
 * flows[0] ≥ 0（无投资）或含非有限值 → ok:false（不硬编）。
 */
export function roiPct(flows: readonly number[]): RoiResult {
  if (!Array.isArray(flows) || flows.length < 2) {
    return { ok: false, reason: "invalid_input" };
  }
  if (flows.some((f) => !Number.isFinite(f))) return { ok: false, reason: "invalid_input" };
  const capex = -flows[0];
  if (capex <= 0) return { ok: false, reason: "no_investment" };
  let inflow = 0;
  for (let t = 1; t < flows.length; t++) inflow += flows[t];
  return { ok: true, value: round(inflow / capex, 6) };
}

/**
 * 年度净现金流构造器：给定 CAPEX（期初一次性支出，正数）、逐年 OPEX（正数）、逐年 Revenue（正数）、
 * 项目年限，产出可直接喂给 npv/irr/payback/roi 的 `flows`（flows[0]=−CAPEX，其后每年=Revenue−OPEX）。
 * 纯算术、不做任何通胀/税收/折旧（那是 R2.4 编排里结合具体参数的事），故可独立测死。
 * 任一入参非有限或 life<1 → 返回 null（诚实，绝不产出一条含 NaN 的现金流）。
 */
export function buildAnnualNetCashFlow(opts: {
  capex: number;
  opexAnnual: number;
  revenueAnnual: number;
  lifeYears: number;
}): number[] | null {
  const { capex, opexAnnual, revenueAnnual, lifeYears } = opts;
  if (
    !Number.isFinite(capex) ||
    !Number.isFinite(opexAnnual) ||
    !Number.isFinite(revenueAnnual) ||
    !Number.isFinite(lifeYears) ||
    lifeYears < 1
  ) {
    return null;
  }
  const flows: number[] = [-capex];
  const net = revenueAnnual - opexAnnual;
  for (let t = 1; t <= lifeYears; t++) flows.push(net);
  return flows;
}
