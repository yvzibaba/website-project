import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Vitest 配置。
 *
 * 环境：node（骨架阶段无 UI 组件测试；Phase 5 引入 React 组件测试时再加 jsdom）。
 * 超时：60s（原 30s）。跨太平洋连 Neon us-east-1、冷启动首查 ~1s，且个别重活用例（如 project-store 版本冻结+回滚，
 *   单跑即 ~28s）在全量文件级串行、连接池争用下会逼近 30s 偶发超时——这是**纯 harness 时延余量**上调，不改任何断言。
 * Pool：forks，避免 Prisma Engine 在 worker_threads 里偶发段错误。
 *
 * ## 别名顺序是硬约束（R9.1 内核成包后新增）
 *
 * `@app/kernel` 必须排在 `@` **之前**。Vite 的字符串别名是**前缀匹配、首个命中即胜**：
 * 若 `@` 先匹配，`@app/kernel/server/x` 会被改写成 `<root>/srcapp/kernel/server/x` ——
 * 一个静默的、只在运行测试时才炸的错误路径。
 * 因此这里改用**数组形式 + 正则锚定**，把顺序写成显式的：
 *   1. `@app/kernel`（精确）→ kernel/src/index.ts
 *   2. `@app/kernel/`（前缀）→ kernel/src/
 *   3. `@/`（前缀）      → src/
 *   4. `@`（精确）       → src/
 */
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@app\/kernel$/,
        replacement: path.resolve(__dirname, "./kernel/src/index.ts"),
      },
      {
        find: /^@app\/kernel\//,
        replacement: path.resolve(__dirname, "./kernel/src") + "/",
      },
      {
        find: /^@\//,
        replacement: path.resolve(__dirname, "./src") + "/",
      },
      {
        find: /^@$/,
        replacement: path.resolve(__dirname, "./src"),
      },
    ],
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globals: false,
    testTimeout: 60_000,
    hookTimeout: 30_000,
    pool: "forks",
    // 集成测试需要 .env 里的 DATABASE_URL；vitest 支持 dotenv 但为保持显式，
    // 我们在 npm script 里用 `node --env-file=.env` 加载，见 package.json 的 test:integration。
  },
});
