# CHANGELOG

记录规则（宪法第13条）：每次修改追加**版本号 + 时间 + 原因 + 内容 + 效果**；不得直接覆盖生产版本；必要时可回滚（Git revert 对应提交）。
时间时区：Asia/Shanghai。

## [0.3.0] - 2026-09-04

- 原因：接收《全自动开发总控 Prompt V1.0》，执行其第一阶段（Phase 0–3：环境检查 + 基础文档），暂不写业务代码（总控第37–39节）。
- 内容：
  - 总控 Prompt 版本化入库 `docs/MASTER_PROMPT_V1.md`。
  - 新增文档集：`README.md`、`PROJECT_RULES.md`（索引+优先级+冲突裁决）、`PRODUCT_SPEC.md`、`ARCHITECTURE.md`、`DATABASE.md`、`AI_WORKFLOW.md`、`SECURITY.md`、`TESTING.md`、`ROADMAP.md`、`CHANGELOG.md`、`.env.example`。
  - 环境检查：Node v24.17 / npm 11.13 / git 2.52 / gh 2.100；本机无 Postgres、无 Docker；npm 重型依赖下载 stall；命令行不可达 github.com（仅 api.github.com）。
- 效果：项目具备完整 Phase 0–3 设计基线与治理文档；明确 V1-A/V1-B 分层与 5 项开放决策、6 项进入 Phase 4 的阻塞资源。**未编写业务代码，未跑通 prisma validate/migrate（环境阻塞，已如实记录）。**

## [0.2.0] - 2026-09-04

- 原因：定义产业能力数据库 V1（宪法第12/13条）。
- 内容：新增 `prisma/schema.prisma`（12 核心实体 + ChangeLog，Postgres），`docs/DATABASE_SCHEMA_V1.md` 设计说明；`package.json` 接入 prisma ^6 / @prisma/client 与 db:* 脚本。
- 效果：核心闭环数据结构就绪（提交 `66fbec5`）；待 Postgres 与依赖就绪后 `prisma validate/migrate`。

## [0.1.1] - 2026-09-04

- 原因：确立项目宪法为最高优先级并版本化（宪法第13条）。
- 内容：新增 `docs/PROJECT_RULES_V2.md`（宪法全文），`AGENTS.md` 顶部加指针（保留 Next.js 自动块）。
- 效果：治理基线入库（提交 `d056391`）。

## [0.1.0] - 2026-09-04

- 原因：项目启动。
- 内容：create-next-app 生成 Next.js 16 + TS + Tailwind + ESLint 脚手架；创建公开仓库 `yvzibaba/website-project`。
- 效果：可开发的空项目基线（提交 `17ad619`）。
