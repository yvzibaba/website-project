/**
 * 沙盘中台图表（中途重构 R4 可视化）。
 *
 * 纯展示件（client）：只吃 `src/lib/sandbox-view.ts` 已算好并格式化过的扁平数据，
 * **不在这里做任何经济/技术计算**（第 7 条程序算、第 16 条单一真源）——所有数字来自引擎，
 * 图表绑定模型（§8），改参数→引擎重算→数据变→图变，全在 `SandboxWorkbench` 里串起来。
 *
 * recharts 3.x；每张图都用 ResponsiveContainer 撑满父卡片。金额为元，坐标轴用紧凑单位（万/亿）。
 */

"use client";

import {
  ResponsiveContainer,
  ComposedChart,
  BarChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
  Cell,
  LabelList,
} from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { formatMoney } from "@/lib/sandbox-view";
import type { CashFlowPoint, NamedValue, TornadoBar } from "@/lib/sandbox-view";

const AXIS = { fontSize: 12, fill: "#71717a" } as const;

/** 坐标轴金额紧凑刻度（万/亿），避免长串占满轴宽。 */
function moneyTick(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e8) return `${(v / 1e8).toFixed(a >= 1e9 ? 0 : 1)}亿`;
  if (a >= 1e4) return `${(v / 1e4).toFixed(0)}万`;
  return `${v}`;
}

/** 卡片式图表外壳，统一标题 + 说明。 */
function ChartCard({
  title,
  desc,
  height = 280,
  children,
}: {
  title: string;
  desc?: string;
  height?: number;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {desc ? <CardDescription>{desc}</CardDescription> : null}
      </CardHeader>
      <CardContent>
        <div style={{ width: "100%", height }}>{children}</div>
      </CardContent>
    </Card>
  );
}

/** 逐年净现金流（柱）+ 累计净现金流（折线，穿越 0 轴即回收）。 */
export function CashFlowChart({ data }: { data: CashFlowPoint[] }) {
  return (
    <ChartCard
      title="逐年净现金流与累计回收"
      desc="第 0 年为净 CAPEX 投入；累计线自下穿越 0 轴处即动态回收期（全部程序算，§7）。"
    >
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
          <XAxis dataKey="year" tick={AXIS} tickFormatter={(y) => `第${Number(y)}年`} />
          <YAxis tick={AXIS} tickFormatter={(v) => moneyTick(Number(v))} width={56} />
          <Tooltip formatter={(v) => formatMoney(Number(v))} labelFormatter={(y) => `第 ${Number(y)} 年`} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <ReferenceLine y={0} stroke="#a1a1aa" />
          <Bar dataKey="flow" name="当年净现金流" fill="#3b82f6" radius={[2, 2, 0, 0]} />
          <Line type="monotone" dataKey="cumulative" name="累计净现金流" stroke="#f59e0b" strokeWidth={2} dot={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

/** 单色分量条形（CAPEX / OPEX / 收入 / 能量平衡共用）。 */
export function BreakdownBar({
  title,
  desc,
  data,
  color = "#3b82f6",
  money = true,
}: {
  title: string;
  desc?: string;
  data: NamedValue[];
  color?: string;
  money?: boolean;
}) {
  const tick = money ? moneyTick : (v: number) => `${v}`;
  const fmt = (v: number) => (money ? formatMoney(v) : `${v.toLocaleString("zh-CN")}`);
  return (
    <ChartCard title={title} desc={desc} height={240}>
      <ResponsiveContainer>
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 24, bottom: 4, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" horizontal={false} />
          <XAxis type="number" tick={AXIS} tickFormatter={(v) => tick(Number(v))} />
          <YAxis type="category" dataKey="name" tick={AXIS} width={72} />
          <Tooltip formatter={(v) => fmt(Number(v))} />
          <Bar dataKey="value" fill={color} radius={[0, 3, 3, 0]}>
            <LabelList dataKey="value" position="right" formatter={(l) => fmt(Number(l))} style={{ fontSize: 11, fill: "#52525b" }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

/** 首年"钱从哪来 / 花到哪去"对比柱。 */
export function Year1MoneyChart({ data }: { data: NamedValue[] }) {
  return (
    <ChartCard title="首年收入 vs 成本" desc="首年（Y1）现金流三要素对比（元）。" height={240}>
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
          <XAxis dataKey="name" tick={AXIS} />
          <YAxis tick={AXIS} tickFormatter={(v) => moneyTick(Number(v))} width={56} />
          <Tooltip formatter={(v) => formatMoney(Number(v))} />
          <Bar dataKey="value" radius={[3, 3, 0, 0]}>
            {data.map((_, i) => (
              <Cell key={i} fill={["#16a34a", "#ef4444", "#f97316"][i % 3]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

/** 龙卷风敏感性：每参数 ±扰动后指标相对基线的位移（元），按 |摆幅| 降序。 */
export function TornadoChart({ data, base }: { data: TornadoBar[]; base: number | null }) {
  return (
    <ChartCard
      title="敏感性 · 龙卷风（对 NPV）"
      desc="各关键参数在自身扰动区间内单独摆动后，NPV 相对基线的位移；条越长越敏感（基线锚定，§14 #8）。"
      height={Math.max(260, data.length * 40)}
    >
      <ResponsiveContainer>
        <ComposedChart data={data} layout="vertical" margin={{ top: 8, right: 24, bottom: 4, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" horizontal={false} />
          <XAxis type="number" tick={AXIS} tickFormatter={(v) => moneyTick(Number(v))} />
          <YAxis type="category" dataKey="label" tick={AXIS} width={92} />
          <Tooltip
            formatter={(value, name) =>
              value == null
                ? ["算不出", String(name)]
                : [`${Number(value) >= 0 ? "+" : ""}${formatMoney(Number(value))}`, String(name)]
            }
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <ReferenceLine x={0} stroke="#a1a1aa" />
          <Bar dataKey="deltaLow" name="低值扰动" stackId="t" fill="#ef4444" />
          <Bar dataKey="deltaHigh" name="高值扰动" stackId="t" fill="#22c55e" />
        </ComposedChart>
      </ResponsiveContainer>
      {base != null ? (
        <p className="mt-2 text-xs text-zinc-500">基线 NPV = {formatMoney(base)}</p>
      ) : null}
    </ChartCard>
  );
}
