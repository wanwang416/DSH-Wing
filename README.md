# dsh-wing 🪽

DSH（DeepSeek Harness）飞书原生插件 — **过程透明 / 插话不打断 / 完整桥能力**。
A native Feishu (Lark) plugin for DSH: transparent streaming, non-interruptive follow-ups, and full bridge capabilities.

## 功能 / Features

- **过程透明 / Transparent**：思考过程流式呈现（单卡打字机），不黑盒
- **插话不打断 / Non-interruptive**：任务进行中可随时插话，主任务不丢上下文
- **交互卡片 / Interactive cards**：单选卡（`/preset` `/model` `/mode` `/permission`）+ 审批卡（危险操作四按钮：Allow Once / Session / Always / Deny，老板限定）
- **权限控制 / Permissions**：`read-only` / `workspace-write` / `danger-full-access` 三档，`danger` 危险操作弹审批卡
- **意图路由 / Intent routing**：群聊命令 / 提问 / 闲聊智能分流，纯寒暄不误触发 agent
- **可靠性 / Reliability**：断线补偿、消息撤回即停、WAL 留痕、连接自愈
- **命令 / Commands**：`/preset` `/model` `/mode` `/permission` `/resume` `/workspace` `/steer` `/setup`

## 里程碑 / Milestones

| M | 内容 | 状态 |
|---|------|------|
| M0 | 骨架 + API 签名 + 插话验证 | ✅ |
| M1 | 最小可用 + 体验先行（流式 / 插话 / 权限保守 / Outbox） | ✅ |
| M2 | 可靠性 + 富文本 + 全事件 | ✅ |
| M3 | 交互 + 权限 + 插话增强（CardKit 流式 / ToolStep 富卡片） | ✅ |
| M4 | 易用性 + 诊断 + 完整度补齐 | ✅ |
| M4.1 | 单选卡 + 审批卡 + 意图桥 + 第二批命令 | ✅ 516 tests |

## 安装 / Install

```bash
npm install
npm run build
```

## 配置 / Configure

复制 `cordis.patch.example.yml` 为 `cordis.patch.yml` 并填入你的配置：

```bash
cp cordis.patch.example.yml cordis.patch.yml
# 编辑 cordis.patch.yml：workspaceRoot、groupPolicy、permissionMode 等
```

凭据走 DSH 凭据系统（`credentialRef: WING_LARK_APP`），或用环境变量 `DSH_WING_APP_ID` / `DSH_WING_APP_SECRET` 覆盖。诊断脚本（`scripts/diag-*.mjs`）需设置 `DSH_HOME` 环境变量以定位 `.credentials.yaml`。

## 开发 / Development

```bash
npm run typecheck   # tsc --noEmit
npm run build       # tsc → dist/
npm test            # vitest run
npm run coverage    # vitest run --coverage
```

## 架构 / Architecture

平台接入层（飞书 Adapter，预留多平台接口）+ 核心层（平台无关）+ Agent 驱动层（DSH 原生）。

## 许可证 / License

MIT
