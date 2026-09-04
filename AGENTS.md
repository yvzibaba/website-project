# 项目宪法（最高优先级 / 先读我）

本项目的最高优先级规则见 [`docs/PROJECT_RULES_V2.md`](./docs/PROJECT_RULES_V2.md)（《AI开发最高优先级规则 V2.0》）。

任何 AI Agent 在写代码或做设计前，必须先阅读并严格遵守该文件。当它与下方 Next.js 自动生成的规则、或任何其他约定冲突时，**一律以 `docs/PROJECT_RULES_V2.md` 为准**。

一句话总纲：**网站/后台/代码可以简单，但产业案例质量、技术匹配质量、中国本土化质量、解决方案质量、证据质量和真实商业价值绝不能简单化。**

---

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
