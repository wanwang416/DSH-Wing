# dsh-wing 🪽

DSH（DeepSeek Harness）飞书原生插件 — **过程透明 / 插话不打断 / 完整桥能力**。

> M0 脚手架阶段：项目骨架 + API 签名确认 + 插话真机验证。尚未实现飞书连接。

## 项目定位

在 DSH 进程内以 Cordis 原生 TypeScript 插件形态，提供从飞书（Lark）到 DSH Agent 的完整桥接能力：

- **过程透明**：思考过程流式呈现，不黑盒
- **插话不打断**：任务进行中可随时插话，主任务不丢上下文
- **完整桥能力**：消息收发 / 会话管理 / 工具可见 / 交互卡片 / 可靠性（对标哈马飞书桥）

架构：平台接入层（飞书 Adapter，预留多平台接口）+ 核心层（平台无关）+ Agent 驱动层（A 插头 DSH 原生，B 插头预留）。

## 里程碑

| M | 内容 | 状态 |
|---|------|------|
| M0 | 修 成熟桥接实现 sessions:0 / 建仓库 / 脚手架 / Spike 1-7 | ⏳ 施工中 |
| M1 | 最小可用 + 体验先行（流式 / 插话 / 权限保守 / Outbox） | ⬜ |
| M2 | 可靠性 + 富文本 + 全事件 | ⬜ |
| M3 | 交互 + 权限 + 插话增强 | ⬜ |
| M4 | 易用性 + 诊断 + 完整度补齐 | ⬜ |

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsc → dist/
npm test            # vitest run
```

## 文档

- [M0 施工日志](docs/construction-log-M0.md)
- [Spike API 签名确认](docs/api-signatures.md)

## 许可证

MIT
