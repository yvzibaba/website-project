import { type LicenseType } from "@/lib/validation";
import { type ScoutCandidateInput } from "@/server/scout";

/**
 * GitHub 仓库元数据抓取 + 许可证归一（Phase 10 M2，纯逻辑 + 可注入 fetch · **无 DB** · server 域）。
 *
 * 为什么（宪法第 11 条「GitHub = 能力供应链，非成品」+「须 需求定义 → 能力匹配 → 筛选 → 许可证检查 →
 *   依赖检查 → 安全检查 → 实测 → 二次封装」）：M1 只立了**离线治理判定**（给定元数据答"还差哪些门"），
 *   但那份元数据从哪来是悬空的——Scout 还只是纯函数、接不上真实的开源世界。M2 补上"从 GitHub 拉一个
 *   仓库的公开元数据 → 归一成 Scout 候选"这截**输入管道**，让 `evaluateCandidate` 的准入判定有真实入参。
 *
 * 刻意边界（宪法「V1 只做核心闭环、能简单就简单」+ 第 20 条诚实 + 第 11 条法律/工程门须人工）：
 *   - **只读公开仓库元数据、不猜依赖/安全/实测**：GitHub 的 repo API 能给出 license / stars / owner 这类
 *     客观元数据，但**给不出**"依赖是否安全""是否有 CVE""能否跑通"——那些要靠 npm audit / 扫描器 / 人工实测
 *     （M2 不投机）。故 `mapGitHubRepoToCandidate` 产出的候选里 `dependencyChecked/securityChecked/tested`
 *     **一律留空（交 ScoutCandidateSchema 落成最保守的 false）**，绝不假称已检查（第 20 条）。
 *   - **许可证只归一、不判定能否用**：本模块只把 GitHub 的 SPDX 标识映射成本项目的 `LicenseType` 枚举，
 *     "能不能商用/是否传染"仍交 `scout.ts` 的 `decideLicense` 且默认进人工复核（法律门始终落在人身上）。
 *   - **依赖注入 fetch**（同 DeepSeek provider 精神）：单测注入假 fetch → 无网络也把请求构造 / 响应解析 /
 *     错误归一整套契约离线测死；真实调用只在生产/RSC 里发生。
 *   - **绝不泄露令牌**：可选 `GITHUB_TOKEN`（仅提升私有/限流配额，公开仓库无需）只在发出的请求头里，
 *     错误只带 HTTP 状态、绝不回显响应体或令牌（宪法第 20 条 / 安全）。
 *   - **SPDX 映射是 v1 归类、非法律意见**：未识别的一律保守落 `OTHER`（→ unknown 档 → 强制人工复核），
 *     改映射表须升 `SCOUT_GITHUB_VERSION` 并记录原因（第 13 条）。
 */

/** Scout·GitHub 输入管道契约版本（改 SPDX 映射 / 返回结构须升版本并记录原因）。 */
export const SCOUT_GITHUB_VERSION = "1.0.0";

/** 最小 fetch 形态（够测试用；避免依赖完整 undici 类型，与 deepseek-provider 的 FetchLike 同构）。 */
export type GithubFetch = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/* ─────────────────────────── SPDX → LicenseType 归一（v1 映射，第 11 条） ─────────────────────────── */

/**
 * GitHub `license.spdx_id` → 本项目 `LicenseType` 的归一表（**大小写不敏感、去空格后匹配**）。
 * 只列常见且能明确对应枚举的 SPDX；其余（含 `NOASSERTION`、未识别、缺失）走 `parseSpdxLicense` 保守回落。
 */
export const SPDX_TO_LICENSE_TYPE: Record<string, LicenseType> = {
  mit: "MIT",
  "apache-2.0": "APACHE_2_0",
  "bsd-2-clause": "BSD_2_CLAUSE",
  "bsd-3-clause": "BSD_3_CLAUSE",
  "bsd-3-clear": "BSD_3_CLAUSE", // 归到最接近的 BSD-3 档（仍须人工确认具体条款）
  "mpl-2.0": "MPL_2_0",
  "lgpl-2.1": "LGPL",
  "lgpl-3.0": "LGPL",
  lgpl: "LGPL",
  "gpl-2.0": "GPL",
  "gpl-3.0": "GPL",
  gpl: "GPL",
  "agpl-3.0": "AGPL",
  agpl: "AGPL",
  "gfdl-1.3": "GPL", // 文档类强传染，保守并入强传染档交人工（非精确等同，故 licenseNote 保留原始 SPDX）
};

export interface ParsedLicense {
  licenseType: LicenseType;
  /** 审计用人类可读串：记录 GitHub 返回的原始 SPDX / license 名，供人工复核时对照（不覆盖人判的 review 态）。 */
  licenseNote: string;
}

/**
 * 把 GitHub 的 license 对象（可能为 null / spdx_id=NOASSERTION / 未识别 SPDX）保守归一。
 * 缺失 → UNKNOWN；`NOASSERTION`（GitHub 无法判定）或表外 SPDX → OTHER；两者都落 unknown 风险档 → 强制人工复核。
 */
export function parseSpdxLicense(license: { spdx_id?: string | null; name?: string | null } | null | undefined): ParsedLicense {
  if (!license) {
    return { licenseType: "UNKNOWN", licenseNote: "GitHub 未检测到 LICENSE 文件（UNKNOWN）" };
  }
  const spdx = (license.spdx_id ?? "").trim().toLowerCase();
  const name = (license.name ?? "").trim();
  const label = name || license.spdx_id || "无";
  if (!spdx || spdx === "noassertion") {
    return { licenseType: "OTHER", licenseNote: `GitHub 许可证无法自动判定：${label}（NOASSERTION → OTHER，须人工确认）` };
  }
  const mapped = SPDX_TO_LICENSE_TYPE[spdx];
  if (!mapped) {
    // 未识别 SPDX：保守落 OTHER（→ 人工复核），licenseNote 留原始标识供人对照，绝不猜成宽松档。
    return { licenseType: "OTHER", licenseNote: `未识别 SPDX「${license.spdx_id}」（${label}）→ OTHER，须人工确认` };
  }
  return { licenseType: mapped, licenseNote: `GitHub SPDX：${license.spdx_id}（${label}）` };
}

/* ─────────────────────────── 仓库元数据 → Scout 候选（纯函数，不判能否用） ─────────────────────────── */

/** GitHub repo API 里本管道关心的最小字段形状（其余字段忽略，不做类型收窄之外的假设）。 */
export interface GitHubRepoLite {
  full_name?: string;
  name?: string;
  html_url?: string;
  description?: string | null;
  stargazers_count?: number;
  license?: { spdx_id?: string | null; name?: string | null } | null;
  owner?: { login?: string } | null;
}

/** 映射产物：喂给 `evaluateCandidate` 的候选 raw + 许可证审计串 + 一句简介（供后续落库/展示）。 */
export interface RepoToCandidateResult {
  candidate: ScoutCandidateInput;
  licenseNote: string;
  description: string | null;
}

/**
 * 把一份 GitHub 仓库元数据归一成 Scout 候选入参（**不做准入判定**，判定交 `evaluateCandidate`）。
 * 关键诚实点：`dependencyChecked/securityChecked/tested` 一律**不设置**，让 `ScoutCandidateSchema`
 * 落成最保守默认 false——GitHub 元数据不能证明依赖/安全/实测已完成（第 20 条，绝不假称已检查）。
 */
export function mapGitHubRepoToCandidate(repo: GitHubRepoLite): RepoToCandidateResult {
  const { licenseType, licenseNote } = parseSpdxLicense(repo.license);
  const owner = repo.owner?.login?.trim() || repo.full_name?.split("/")[0] || undefined;
  const shortName = repo.name?.trim() || repo.full_name?.split("/")[1]?.trim();
  const name = (repo.full_name?.trim() || shortName || "").slice(0, 200);

  const candidate: ScoutCandidateInput = {
    name,
    repoUrl: repo.html_url?.trim() || (owner && shortName ? `https://github.com/${owner}/${shortName}` : name),
    owner,
    // stars 归一为非负整数或省略（脏值交 schema 处理，不硬塞）。
    stars: typeof repo.stargazers_count === "number" && Number.isFinite(repo.stargazers_count) && repo.stargazers_count >= 0
      ? Math.trunc(repo.stargazers_count)
      : undefined,
    licenseType,
    // 刻意省略 licenseReviewStatus / dependencyChecked / securityChecked / tested → schema 落最保守默认。
  };
  return { candidate, licenseNote, description: repo.description ?? null };
}

/* ─────────────────────────── 抓取（依赖注入 fetch，无网络可测） ─────────────────────────── */

/** 抓取失败的判别用错误类型（带 HTTP 状态；**消息绝不含响应体 / 令牌**）。 */
export class ScoutFetchError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "ScoutFetchError";
    this.status = status;
  }
}

/** 解析 `owner/repo`（接受 `owner/repo` 或完整 `https://github.com/owner/repo(.git)` 两种写法）。 */
export function parseRepoRef(ref: string): { owner: string; repo: string } | null {
  const s = ref.trim();
  if (!s) return null;
  let path = s
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "") // 协议（http / https / git / ssh）
    .replace(/[?#].*$/, ""); // 查询串 / 片段
  // 仅当第一段像域名（含点）时才剥掉 host；否则视为裸 `owner/repo`，不能误剥 owner。
  const slash = path.indexOf("/");
  if (slash > 0 && path.slice(0, slash).includes(".")) {
    path = path.slice(slash + 1);
  }
  path = path.replace(/\.git$/i, "").replace(/\/+$/, ""); // 剥结尾 .git / 尾斜杠
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[parts.length - 2];
  const repo = parts[parts.length - 1];
  // 拒绝 "." / ".." 等路径穿越段与含非法字符的段。
  const segOk = (x: string) => x !== "." && x !== ".." && /^[\w.-]+$/.test(x);
  if (!owner || !repo || !segOk(owner) || !segOk(repo)) return null;
  return { owner, repo };
}

export interface FetchRepoDeps {
  fetchImpl?: GithubFetch;
  /** 可选令牌（提升限流 / 访问私有仓库）；仅进请求头，绝不进日志 / 错误。 */
  token?: string;
  signal?: AbortSignal;
}

/**
 * 从 `https://api.github.com/repos/{owner}/{repo}` 拉一个仓库的公开元数据。
 * 用注入的 `fetchImpl`（缺省 `globalThis.fetch`），单测可注假 fetch 无网络测死整套契约。
 * 非 2xx → 抛 `ScoutFetchError`（只带状态码，不回显响应体 / 令牌）；非法 ref → 先抛，根本不发起请求。
 */
export async function fetchGitHubRepo(ref: string, deps: FetchRepoDeps = {}): Promise<GitHubRepoLite> {
  const parsed = parseRepoRef(ref);
  if (!parsed) {
    throw new ScoutFetchError("无效的仓库标识（须为 owner/repo 或 GitHub 仓库 URL）");
  }
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as GithubFetch);
  const url = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "website-project-scout",
  };
  const token = deps.token?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;

  let resp: Awaited<ReturnType<GithubFetch>>;
  try {
    resp = await fetchImpl(url, { method: "GET", headers, signal: deps.signal });
  } catch {
    // 网络/中断错误：归一为不含细节的失败（绝不外溢可能带 url/凭据的原始 error）。
    throw new ScoutFetchError("GitHub 抓取失败（网络错误）");
  }
  if (!resp.ok) {
    throw new ScoutFetchError(`GitHub 抓取失败：HTTP ${resp.status}`, resp.status);
  }
  const data = (await resp.json()) as GitHubRepoLite;
  return data;
}
