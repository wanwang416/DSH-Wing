/**
 * dsh-wing client half (browser). Reuses the DSH Web GUI entirely
 * (对照 dsh-lark-link src/client/index.ts)。本 client 提供一个侧栏入口：
 *  未配置      → 「扫码连接」按钮 + 轮询展示注册二维码（/plugins/dsh-wing/setup 触发）
 *  已配置+未连 → ready
 *  连接中      → connecting
 *  已连接      → running（显示 appId / 计数）
 *  异常        → error
 *
 * 状态来自 host 的 /plugins/dsh-wing/status（JSON：configured/connState/计数）。
 * 二维码是 host 提供的 PNG（/plugins/dsh-wing/qr）——GUI 的 markdown 图片清洗器
 * 会丢弃 data: URL，插件也无法用 ctx.remote 推送，所以轮询一个自己拥有的本地图片。
 *
 * 挂载：`sidebar.footer.action` 是 ui-sidebar 声明的 list 槽；
 * register 需要父槽名 + entry id。弹层用 React portal 渲染到 document.body，
 * 逃逸出 sidebar footer 容器——同槽插件（如 dsh-cost-meter 重排该容器 children/order）
 * 无法重排或扭曲它。
 */

import type { Context } from "@deepseek-ai/cordis";
import { ICON_LIGHT, ICON_DARK } from "./icons.js";

type ReactApi = {
  createElement: (
    type: unknown,
    props?: Record<string, unknown> | null,
    ...children: unknown[]
  ) => unknown;
  useState: <S>(initial: S) => [S, (next: S | ((prev: S) => S)) => void];
  useEffect: (setup: () => (() => void) | void, deps?: unknown[]) => void;
};
const R = require("react") as ReactApi;
const { createElement: h, useState, useEffect } = R;
// 通过 portal 渲染到 document.body，逃逸共享的 sidebar footer 槽容器。
// sidebar.footer.action 是 LIST 槽，其他插件（如 dsh-cost-meter）合法地重排容器
// children / 用 MutationObserver 重写内联 flex 样式——留在槽内的弹层会被打乱变形。
const reactDom = require("react-dom") as {
  createPortal?: (node: unknown, container: unknown) => unknown;
};

const win = globalThis as unknown as {
  location?: { origin?: string };
  matchMedia?: (q: string) => {
    matches: boolean;
    addEventListener?: (t: string, cb: () => void) => void;
    removeEventListener?: (t: string, cb: () => void) => void;
  };
  fetch?: (url: string, init?: { method?: string }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
  // Browser-only，仅作 portal 挂载点。本包 lib 是 ES2023（无 DOM lib），
  // 通过 globalThis 惰性访问。
  document?: { body?: unknown } | null;
};

const bodyEl = win.document?.body;
const portalToBody =
  bodyEl != null && reactDom.createPortal
    ? (node: unknown) => reactDom.createPortal!(node, bodyEl)
    : (node: unknown) => node;

export const name = "dsh-wing-client";
export const inject = ["slots"];

export interface ClientContext extends Context {
  slots: {
    inject(name: string, register: () => () => void): void;
    register(
      opts: { name: string; id: string; order?: number; label?: string },
      Component: (props?: unknown) => unknown,
    ): () => void;
  };
}

interface StatusPayload {
  configured?: boolean;
  connState?: string;
  appId?: string;
  wsReady?: boolean;
  outboxPending?: number;
  outboxFailed?: number;
  inboundPending?: number;
  sessions?: number;
  busy?: boolean;
}

type PanelState =
  | "loading"
  | "setup"
  | "ready"
  | "connecting"
  | "running"
  | "error";

function deriveState(s: StatusPayload | undefined): PanelState {
  if (!s) return "loading";
  if (!s.configured) return "setup";
  switch (s.connState) {
    case "connected":
      return "running";
    case "connecting":
    case "reconnecting":
      return "connecting";
    case "degraded":
    case "quarantined":
      return "error";
    default: // stopped | idle | undefined
      return "ready";
  }
}

const STATE_VIEW: Record<
  Exclude<PanelState, "loading">,
  { emoji: string; label: string; color: string; bg: string; hint: string }
> = {
  setup: {
    emoji: "⚙️",
    label: "未配置",
    color: "#ffb454",
    bg: "rgba(255,180,84,.12)",
    hint: "点击下方按钮生成二维码，用手机飞书扫码完成注册",
  },
  ready: {
    emoji: "✅",
    label: "已配置 · 未连接",
    color: "#7fd1ff",
    bg: "rgba(127,209,255,.12)",
    hint: "桥尚未连上飞书，稍候或检查 host 网络",
  },
  connecting: {
    emoji: "🟡",
    label: "连接中…",
    color: "#ffd66b",
    bg: "rgba(255,214,107,.12)",
    hint: "正在建立飞书长连接",
  },
  running: {
    emoji: "🟢",
    label: "运行中",
    color: "#7ee2a8",
    bg: "rgba(126,226,168,.12)",
    hint: "发消息即可对话 · 换 bot 请在飞书私聊运行 /setup",
  },
  error: {
    emoji: "🔴",
    label: "连接异常",
    color: "#ff8a80",
    bg: "rgba(255,138,128,.12)",
    hint: "桥连接异常，检查 host 日志与飞书应用配置",
  },
};

export function apply(ctx: ClientContext): void {
  const SidebarAction = (): unknown => {
    const [open, setOpen] = useState<boolean>(false);
    const [st, setSt] = useState<StatusPayload | undefined>(undefined);
    const [qrTs, setQrTs] = useState<number>(0);
    const [qrLoaded, setQrLoaded] = useState<boolean>(false);
    const [posting, setPosting] = useState<boolean>(false);
    // 主题感知：深色背景用银灰版图标，浅色背景用黑版图标
    const [dark, setDark] = useState<boolean>(
      typeof win.matchMedia === "function" && win.matchMedia("(prefers-color-scheme: dark)").matches,
    );

    useEffect(() => {
      if (!open) return;
      const origin = win.location?.origin ?? "";
      const fetchStatus = (): void => {
        void win
          .fetch?.(`${origin}/plugins/dsh-wing/status`)
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error("status"))))
          .then((j) => setSt(j as StatusPayload))
          .catch(() => setSt((prev) => prev));
      };
      fetchStatus();
      const stId = setInterval(fetchStatus, 3000);
      // 二维码只在 setup 状态有意义；未配置时轮询刷新 PNG（带 cache-bust t）
      const qrId = setInterval(() => setQrTs(Date.now()), 4000);
      setQrTs(Date.now());
      return () => {
        clearInterval(stId);
        clearInterval(qrId);
      };
    }, [open]);

    // 监听系统主题切换（prefers-color-scheme），实时换图标版本
    useEffect(() => {
      const mq =
        typeof win.matchMedia === "function" ? win.matchMedia("(prefers-color-scheme: dark)") : undefined;
      const onChange = (): void => setDark(Boolean(mq?.matches));
      mq?.addEventListener?.("change", onChange);
      return () => mq?.removeEventListener?.("change", onChange);
    }, []);

    const state = deriveState(st);
    const origin = win.location?.origin ?? "";
    const isSetup = state === "setup";
    const iconSrc = dark ? ICON_DARK : ICON_LIGHT;
    // 图标是宽幅 logo（64×24），按高度控制、宽度自适应，避免方形 contain 把图压扁变小
    const wingIcon = (height: number) =>
      h("img", {
        src: iconSrc,
        alt: "",
        height,
        style: { height: `${height}px`, width: "auto", objectFit: "contain", flexShrink: 0, display: "block" },
      });

    // 面板里点「扫码连接」→ 触发 host 后台注册（POST /setup），二维码经 /qr 轮询
    const startSetup = (): void => {
      setPosting(true);
      void win
        .fetch?.(`${origin}/plugins/dsh-wing/setup`, { method: "POST" })
        .then(() => setQrTs(Date.now()))
        .finally(() => setPosting(false));
    };

    const button = h(
      "button",
      {
        type: "button",
        title: "Wing 飞书桥",
        onClick: () => setOpen((v) => !v),
        style: {
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          gap: "6px",
          padding: "5px",
          border: "1px solid rgba(127,127,127,.25)",
          borderRadius: "8px",
          background: open ? "rgba(127,127,127,.18)" : "transparent",
          color: "inherit",
          cursor: "pointer",
          fontSize: "13px",
          lineHeight: 1,
        },
      },
      wingIcon(20),
    );

    if (!open) return button;

    const view =
      state === "loading"
        ? {
            emoji: "…",
            label: "读取状态",
            color: "#9aa0a6",
            bg: "rgba(255,255,255,.05)",
            hint: "",
          }
        : STATE_VIEW[state];

    const extras: string[] = [];
    if (st?.appId) extras.push(`app ${st.appId}`);
    if (st?.outboxPending && st.outboxPending > 0) extras.push(`待发 ${st.outboxPending}`);
    if (st?.outboxFailed && st.outboxFailed > 0) extras.push(`失败 ${st.outboxFailed}`);
    if (st?.sessions !== undefined && st.sessions > 0) extras.push(`会话 ${st.sessions}`);

    const banner = h(
      "div",
      {
        style: {
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "10px 12px",
          marginBottom: "10px",
          background: view.bg,
          borderRadius: "8px",
          color: view.color,
          fontWeight: 600,
        },
      },
      h("span", { style: { fontSize: "16px" } }, view.emoji),
      h("span", null, view.label),
      extras.length
        ? h(
            "span",
            {
              style: {
                marginLeft: "auto",
                fontWeight: 400,
                opacity: 0.8,
                fontSize: "11px",
              },
            },
            extras.join(" · "),
          )
        : null,
    );

    const hint = view.hint
      ? h(
          "div",
          {
            style: {
              opacity: 0.8,
              marginBottom: "10px",
              whiteSpace: "pre-wrap",
            },
          },
          view.hint,
        )
      : null;

    // 未配置：扫码连接按钮 + 二维码（dsh-wing 懒启动注册；busy/已有 QR 时 img 才有效）
    const setupCta = isSetup
      ? h(
          "button",
          {
            type: "button",
            disabled: posting || st?.busy,
            onClick: startSetup,
            style: {
              display: "block",
              width: "100%",
              padding: "9px 12px",
              marginBottom: "10px",
              border: "1px solid rgba(255,180,84,.45)",
              borderRadius: "8px",
              background: "rgba(255,180,84,.14)",
              color: "#ffb454",
              fontWeight: 600,
              cursor: "pointer",
              fontSize: "13px",
            },
          },
          posting || st?.busy ? "⏳ 正在生成二维码…" : "📱 扫码连接",
        )
      : null;
    const showQr = isSetup;
    const qrImg = showQr
      ? h("img", {
          src: `${origin}/plugins/dsh-wing/qr?t=${qrTs}`,
          alt: "dsh-wing setup QR",
          onError: () => setQrLoaded(false),
          onLoad: () => setQrLoaded(true),
          style: {
            width: "220px",
            height: "220px",
            display: qrLoaded && (st?.busy || posting) ? "block" : "none",
            margin: "0 auto 10px",
          },
        })
      : null;
    const qrHint =
      showQr && !qrLoaded && !posting && !st?.busy
        ? h(
            "div",
            {
              style: {
                textAlign: "center",
                opacity: 0.6,
                padding: "8px 0 12px",
                fontSize: "11px",
              },
            },
            "二维码生成中…（若长时间无显示，点击上方按钮重新生成）",
          )
        : null;

    const footer = h(
      "div",
      {
        style: {
          marginTop: "6px",
          paddingTop: "8px",
          borderTop: "1px solid rgba(255,255,255,.08)",
          opacity: 0.6,
          fontSize: "11px",
          lineHeight: 1.6,
        },
      },
      "重新配置：飞书私聊运行 /setup 换 bot",
      h("br"),
      "详情与全链路：飞书运行 /status",
    );

    const panel = h(
      "div",
      {
        style: {
          position: "fixed",
          top: "12px",
          right: "12px",
          zIndex: 2147483000,
          minWidth: "300px",
          maxWidth: "360px",
          padding: "14px 16px",
          background: "rgba(24,26,32,.97)",
          color: "#e6e8eb",
          border: "1px solid rgba(255,255,255,.16)",
          borderRadius: "12px",
          boxShadow: "0 16px 48px rgba(0,0,0,.5)",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: "12px",
          lineHeight: 1.5,
        },
      },
      h(
        "div",
        {
          style: {
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "10px",
          },
        },
        h(
          "strong",
          {
            style: {
              fontSize: "13px",
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
            },
          },
          wingIcon(18),
          "Wing 飞书桥",
        ),
        h(
          "button",
          {
            type: "button",
            onClick: () => setOpen(false),
            style: {
              background: "transparent",
              border: "none",
              color: "#9aa0a6",
              cursor: "pointer",
              fontSize: "16px",
              lineHeight: 1,
            },
            title: "关闭",
          },
          "×",
        ),
      ),
      banner,
      hint,
      setupCta,
      qrImg,
      qrHint,
      footer,
    );

    // 弹层走 portalToBody（document.body），同槽插件（dsh-cost-meter 重排共享
    // sidebar footer 容器）无法扭曲它。只有触发按钮留在 sidebar footer 槽内。
    return h("div", null, button, portalToBody(panel));
  };

  ctx.slots.inject("sidebar.footer.action", () =>
    ctx.slots.register(
      {
        name: "sidebar.footer.action",
        id: "dsh-wing-entry",
        order: 110,
        label: "Wing 飞书桥",
      },
      SidebarAction,
    ),
  );
}
