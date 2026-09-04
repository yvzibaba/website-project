/**
 * 认证表单共享类型（登录 / 注册复用）。
 * 放在无 "use client"/"use server" 指令的纯类型模块，供 server action 与 client 组件同时 import。
 */
export interface AuthFormState {
  /** 顶层错误（登录失败、邮箱已存在等），用 Alert 展示。 */
  error?: string;
  /** 字段级错误（注册校验不通过），键为字段名，值为消息数组。 */
  fieldErrors?: Record<string, string[]>;
}
