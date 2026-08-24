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
    async set(ref: string, value: LarkCredential): Promise<void> {
      await ctx.credentials?.set?.(ref, JSON.stringify(value));
    },
    async unset(ref: string): Promise<void> {
      await ctx.credentials?.unset?.(ref);
    },
  };
}
