import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * R8 守卫（mandate §十「AI / 发现期草料不得直接修改 Benchmark 或 Engine」的最严实现——
 * **候选池这一层连读都不读**计算真源）。
 *
 * 做法：静态扫源码 import 集合，钉死 candidate 层（store + screening 纯函数）永不含
 *   benchmark / engine / finance / parameter-engine / solution-generation / project-model。
 *   这条不测行为、测「依赖边界」——比行为测更能防止未来有人顺手 `import { runCalculation }` 进来污染草料池。
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");

const FILES = [
  "kernel/src/server/candidate-store.ts",
  "kernel/src/lib/candidate-screening.ts",
];

// 禁止出现的落点子串（匹配 import 语句里的 module specifier 是否含下列 token）。
const FORBIDDEN = [
  "benchmark",
  "engine",
  "/finance",
  "parameter-engine",
  "project-model",
  "solution-generation",
  "runCalculation",
  "scoring",
  "deepseek",
  "model-router",
];

function imports(file: string): string[] {
  const src = readFileSync(resolve(root, file), "utf8");
  const re = /from\s+["']([^"']+)["']/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}

describe("R8 · candidate 层依赖边界守卫（绝不触碰基准/引擎/财务真源）", () => {
  for (const file of FILES) {
    it(`${file} 的 import 不含任何计算真源/模型层`, () => {
      const specs = imports(file);
      for (const spec of specs) {
        const hit = FORBIDDEN.find((tok) => spec.toLowerCase().includes(tok));
        expect(
          hit,
          `${file} 不得 import ${spec}（命中禁用落点 "${hit}"）`,
        ).toBeUndefined();
      }
      // 白名单兜底：本层允许的跨模块 import 只有 prisma / logger / @prisma/client / zod / candidate-screening。
      const allowed = [
        "@app/kernel/lib/prisma",
        "@app/kernel/lib/logger",
        "@app/kernel/lib/candidate-screening",
        "@prisma/client",
        "zod",
      ];
      for (const spec of specs) {
        expect(allowed, `${file} 出现白名单外 import：${spec}`).toContain(spec);
      }
    });
  }

  it("candidate-screening 是零外部依赖纯函数（连 prisma 都不 import）", () => {
    expect(imports("kernel/src/lib/candidate-screening.ts")).toEqual([]);
  });
});
