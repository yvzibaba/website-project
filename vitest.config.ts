import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Vitest 配置。
 *
 * 环境：node（骨架阶段无 UI 组件测试；Phase 5 引入 React 组件测试时再加 jsdom）。
 * 别名：@/* 对齐 tsconfig 的 paths，让测试里的 import 与业务代码保持一致。
 * 超时：30s，考虑到集成测试要跨太平洋连 Neon us-east-2，冷启动首查可能 ~1s。
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
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    // 集成测试需要 .env 里的 DATABASE_URL；vitest 支持 dotenv 但为保持显式，
    // 我们在 npm script 里用 `node --env-file=.env` 加载，见 package.json 的 test:integration。
  },
});
