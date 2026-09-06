import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Vitest 配置。
 *
 * 环境：node（骨架阶段无 UI 组件测试；Phase 5 引入 React 组件测试时再加 jsdom）。
 * 别名：@/* 对齐 tsconfig 的 paths，让测试里的 import 与业务代码保持一致。
 * 超时：60s（原 30s）。跨太平洋连 Neon us-east-2、冷启动首查 ~1s，且个别重活用例（如 sandbox-store 版本冻结+回滚，
 *   单跑即 ~28s）在全量文件级串行、连接池争用下会逼近 30s 偶发超时——这是**纯 harness 时延余量**上调，不改任何断言。
 * Pool：forks，避免 Prisma Engine 在 worker_threads 里偶发段错误。
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
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
