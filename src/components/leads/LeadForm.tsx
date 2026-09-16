"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  FieldError,
  Alert,
} from "@/components/ui";
import {
  LEAD_BUDGET_RANGES,
  LEAD_PROJECT_STAGES,
  type LeadBudgetRange,
  type LeadProjectStage,
  type LeadSource,
} from "@/server/leads";

/**
 * 留资（RFQ）表单（V1.1 P4 · 商业闭环最小可用，client）。
 *
 * 三处落位共用（source 区分）：
 *   - "enterprise" — /enterprise 底部「询价 / 联系我们」；
 *   - "report"     — 沙盘报告尾（保存项目 / 导出方案后的下一步）；
 *   - "pricing"    — 方案定价位（solutions/[id] 未定价 / 想直接聊价的分支）。
 * 提交到 `POST /api/leads`（CSRF 同源 + 允许游客 + 单实例 IP 频控）。
 *
 * 诚实边界：
 *   - 提交**不构成任何合同 / 报价承诺**（UI 明确标注）；
 *   - 「1 个工作日内人工联系」是**流程承诺**、不是系统能力（本页不发邮件 / 不接 CRM / 无自动工单），
 *     若未及时联系，请用后台反馈入口催办；
 *   - 字段全部有硬上限，与 zod 一致（避免客户端能提交但服务端拒收的错位体验）。
 *
 * 刻意**不做**：多步表单、行内富文本、图片/文件上传、地址簿、行业下拉——留资 MVP，
 * 只要一条可跟进的意向；更结构化的企业诊断属 V1-B。
 */

interface LeadFormProps {
  /** 落位来源，写入 `Lead.source`（白名单）。 */
  source: LeadSource;
  /** 表单标题（可按落位调，默认「联系我们 / 询价意向」）。 */
  title?: string;
  /** 表单副标题说明。 */
  subtitle?: string;
  /** 内嵌模式：去卡片外框，只保留字段（供更紧凑的段落中嵌入）。 */
  compact?: boolean;
}

type FieldKey = "company" | "contactName" | "role" | "email" | "phone" | "message";

export function LeadForm({ source, title, subtitle, compact = false }: LeadFormProps) {
  const pathname = usePathname();

  const [company, setCompany] = useState("");
  const [contactName, setContactName] = useState("");
  const [role, setRole] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [projectStage, setProjectStage] = useState<LeadProjectStage | "">("");
  const [budgetRange, setBudgetRange] = useState<LeadBudgetRange | "">("");
  const [message, setMessage] = useState("");

  const [pending, setPending] = useState(false);
  const [fieldErrs, setFieldErrs] = useState<Partial<Record<FieldKey, string>>>({});
  const [generalErr, setGeneralErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFieldErrs({});
    setGeneralErr(null);
    setDone(false);

    // 前端兜底：必填非空、邮箱形状（服务端仍走 zod 白名单为唯一真源，此处仅为即时反馈）。
    const errs: Partial<Record<FieldKey, string>> = {};
    if (company.trim().length < 2) errs.company = "请填写公司名称";
    if (contactName.trim().length < 1) errs.contactName = "请填写联系人姓名";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) errs.email = "邮箱格式不正确";
    if (Object.keys(errs).length > 0) {
      setFieldErrs(errs);
      return;
    }

    const body = {
      company: company.trim(),
      contactName: contactName.trim(),
      role: role.trim() || undefined,
      email: email.trim(),
      phone: phone.trim() || undefined,
      projectStage: projectStage || undefined,
      budgetRange: budgetRange || undefined,
      message: message.trim() || undefined,
      source,
      page: pathname ?? undefined,
    };
    setPending(true);
    try {
      const res = await fetch("/api/leads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => null)) as
        | {
            ok?: boolean;
            error?: { code?: string; message?: string; details?: { fields?: Record<string, string[]> } };
          }
        | null;
      if (res.ok && json?.ok) {
        setDone(true);
        // 提交成功后清空，避免用户误以为没提交而重复刷。
        setCompany("");
        setContactName("");
        setRole("");
        setEmail("");
        setPhone("");
        setProjectStage("");
        setBudgetRange("");
        setMessage("");
      } else {
        const fields = json?.error?.details?.fields ?? {};
        const mapped: Partial<Record<FieldKey, string>> = {};
        for (const k of ["company", "contactName", "role", "email", "phone", "message"] as FieldKey[]) {
          const arr = fields[k];
          if (Array.isArray(arr) && arr.length > 0) mapped[k] = arr[0];
        }
        setFieldErrs(mapped);
        // 若后端没给出字段级错误（如 429 / CSRF 拒），走通用提示条。
        if (Object.keys(mapped).length === 0) {
          setGeneralErr(json?.error?.message ?? `提交失败（HTTP ${res.status}）`);
        }
      }
    } catch {
      setGeneralErr("网络错误，请稍后重试");
    } finally {
      setPending(false);
    }
  }

  const inner = (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`lead-${source}-company`} required>
            公司名称
          </Label>
          <Input
            id={`lead-${source}-company`}
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            maxLength={200}
            disabled={pending}
            invalid={!!fieldErrs.company}
            aria-invalid={!!fieldErrs.company || undefined}
            placeholder="例如：大同港电新能源"
          />
          {fieldErrs.company ? <FieldError>{fieldErrs.company}</FieldError> : null}
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`lead-${source}-contactName`} required>
            联系人
          </Label>
          <Input
            id={`lead-${source}-contactName`}
            value={contactName}
            onChange={(e) => setContactName(e.target.value)}
            maxLength={100}
            disabled={pending}
            invalid={!!fieldErrs.contactName}
            aria-invalid={!!fieldErrs.contactName || undefined}
            placeholder="姓名"
          />
          {fieldErrs.contactName ? <FieldError>{fieldErrs.contactName}</FieldError> : null}
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`lead-${source}-role`}>职务 / 角色（可选）</Label>
          <Input
            id={`lead-${source}-role`}
            value={role}
            onChange={(e) => setRole(e.target.value)}
            maxLength={100}
            disabled={pending}
            invalid={!!fieldErrs.role}
            placeholder="例如：投资总监"
          />
          {fieldErrs.role ? <FieldError>{fieldErrs.role}</FieldError> : null}
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`lead-${source}-email`} required>
            联系邮箱
          </Label>
          <Input
            id={`lead-${source}-email`}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            maxLength={200}
            disabled={pending}
            invalid={!!fieldErrs.email}
            aria-invalid={!!fieldErrs.email || undefined}
            placeholder="用于人工回电后的书面沟通"
          />
          {fieldErrs.email ? <FieldError>{fieldErrs.email}</FieldError> : null}
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`lead-${source}-phone`}>电话（可选）</Label>
          <Input
            id={`lead-${source}-phone`}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            maxLength={50}
            disabled={pending}
            invalid={!!fieldErrs.phone}
            placeholder="+86 138…"
          />
          {fieldErrs.phone ? <FieldError>{fieldErrs.phone}</FieldError> : null}
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`lead-${source}-projectStage`}>项目阶段（可选）</Label>
          <select
            id={`lead-${source}-projectStage`}
            value={projectStage}
            onChange={(e) => setProjectStage(e.target.value as LeadProjectStage | "")}
            disabled={pending}
            className="h-[38px] w-full rounded-md border border-input bg-transparent px-2 text-sm"
          >
            <option value="">— 未选择 —</option>
            {LEAD_PROJECT_STAGES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1 sm:col-span-2">
          <Label htmlFor={`lead-${source}-budgetRange`}>预算档位（可选，区间档位、非承诺报价）</Label>
          <select
            id={`lead-${source}-budgetRange`}
            value={budgetRange}
            onChange={(e) => setBudgetRange(e.target.value as LeadBudgetRange | "")}
            disabled={pending}
            className="h-[38px] w-full rounded-md border border-input bg-transparent px-2 text-sm"
          >
            <option value="">— 未选择 —</option>
            {LEAD_BUDGET_RANGES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`lead-${source}-message`}>补充说明（可选，≤2000 字）</Label>
        <textarea
          id={`lead-${source}-message`}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={3}
          maxLength={2000}
          disabled={pending}
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
          placeholder="项目地点、装机容量、期望交付节奏等——任何能帮我们准备首次沟通的信息"
        />
        {fieldErrs.message ? <FieldError>{fieldErrs.message}</FieldError> : null}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" size="sm" disabled={pending}>
          {pending ? "提交中…" : "提交询价意向"}
        </Button>
        <span className="text-[11px] leading-snug text-muted-foreground">
          提交仅代表你的意向，不构成合同或报价承诺；后台人工阅读，通常 1 个工作日内邮件 / 电话联系（非系统级 SLA）。
        </span>
      </div>
      {generalErr ? (
        <Alert variant="danger" title="提交未成功">
          {generalErr}
        </Alert>
      ) : null}
      {done ? (
        <Alert variant="success" title="已收到">
          留资已记录，我们会通过你填写的邮箱 / 电话跟进。若急需联系，可再通过反馈入口催办。
        </Alert>
      ) : null}
    </form>
  );

  if (compact) return inner;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-col gap-1">
            <CardTitle className="text-base">{title ?? "联系我们 / 询价意向"}</CardTitle>
            <CardDescription>
              {subtitle ??
                "留下公司与联系方式，我们看到后会安排人工对接（不构成合同 / 报价承诺）。"}
            </CardDescription>
          </div>
          <Badge variant="outline" compact>
            人工跟进 · 无自动邮件
          </Badge>
        </div>
      </CardHeader>
      <CardContent>{inner}</CardContent>
    </Card>
  );
}
