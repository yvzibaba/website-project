# 项目宪法（最高优先级 / 先读我）

本项目的最高优先级规则见 [`docs/PROJECT_RULES_V2.md`](./docs/PROJECT_RULES_V2.md)（《AI开发最高优先级规则 V2.0》）。

任何 AI Agent 在写代码或做设计前，必须先阅读并严格遵守该文件。当它与下方 Next.js 自动生成的规则、或任何其他约定冲突时，**一律以 `docs/PROJECT_RULES_V2.md` 为准**。

一句话总纲：**网站/后台/代码可以简单，但产业案例质量、技术匹配质量、中国本土化质量、解决方案质量、证据质量和真实商业价值绝不能简单化。**

## 治理与规格文档

- 文档索引与优先级：[`PROJECT_RULES.md`](./PROJECT_RULES.md)
- 全自动开发总控 Prompt：[`docs/MASTER_PROMPT_V1.md`](./docs/MASTER_PROMPT_V1.md)
- 设计文档：[`PRODUCT_SPEC.md`](./PRODUCT_SPEC.md) · [`ARCHITECTURE.md`](./ARCHITECTURE.md) · [`DATABASE.md`](./DATABASE.md) · [`AI_WORKFLOW.md`](./AI_WORKFLOW.md) · [`SECURITY.md`](./SECURITY.md) · [`TESTING.md`](./TESTING.md) · [`ROADMAP.md`](./ROADMAP.md) · [`CHANGELOG.md`](./CHANGELOG.md)

## 工作纪律（每个任务都要遵守）

READ → PLAN → IMPLEMENT → TEST → VERIFY → DOCUMENT；小步执行、一次一个明确任务；禁止一次性重写整系统、禁止改无关模块、禁止无测试宣布完成、禁止隐藏错误或虚构"已完成/测试通过"；每次修改追加 CHANGELOG；遇到需人工裁决的业务规则或缺失凭证/资源时，停下来如实汇报（见 ROADMAP「阻塞与开放决策」）。

---

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
