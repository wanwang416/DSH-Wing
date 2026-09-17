/**
 * 飞书凭据管理（封装 ctx.credentials）
 *
 * 参考前期调研结论：实际签名 resolve/set/unset（终审方案写的 persist/clear 有误）。
 * app_secret 只存于 DSH 凭据系统，绝不硬编码（铁律 7）。
 */

export interface LarkCredential {
  appId: string;
  appSecret: string;
  domain: "feishu" | "lark";
}

export function createCredentialStore(ctx: any) {
  return {
    /** 解析凭据 ref → {appId, appSecret, domain}；未配置或格式错误返回 undefined */
    async resolve(ref: string): Promise<LarkCredential | undefined> {
      const resolved = await ctx.credentials?.resolve?.(ref);
      // DSH credentials.resolve 返回 { value: <string> }，兼容直接值
      const raw = resolved?.value ?? resolved;
      if (!raw) return undefined;
      if (typeof raw === "string") {
        try {
          const parsed = JSON.parse(raw) as Partial<LarkCredential>;
          if (parsed?.appId && parsed?.appSecret) return parsed as LarkCredential;
          return undefined;
        } catch {
          return undefined;
        }
      }
      return raw as LarkCredential;
    },
    /** 原始凭据读取：不经 LarkCredential 形状过滤（企微 WING_WECOM_BOT 专用，R1/M1） */
    async resolveRaw<T = unknown>(ref: string): Promise<T | undefined> {
      const resolved = await ctx.credentials?.resolve?.(ref);
      const raw = resolved?.value ?? resolved;
      if (!raw) return undefined;
      if (typeof raw === "string") {
        try {
          return JSON.parse(raw) as T;
        } catch {
          return undefined;
        }
      }
      return raw as T; // 兼容直接对象值（测试桩/非 DSH 存储）
    },
    // ★ 企微适配：value 放宽为 unknown（WING_WECOM_BOT 存 {botId, secret}，非 LarkCredential）
    async set(ref: string, value: unknown): Promise<void> {
      await ctx.credentials?.set?.(ref, JSON.stringify(value));
    },
    async unset(ref: string): Promise<void> {
      await ctx.credentials?.unset?.(ref);
    },
  };
}
