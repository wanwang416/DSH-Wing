# Contributing to DSH-Wing

欢迎参与 DSH-Wing 共建！Welcome to DSH-Wing!

DSH-Wing 是运行于 DeepSeek Harness（DSH）的飞书原生插件，面向过程透明、插话不打断、完整桥能力。
本文档约定如何报告问题、提交代码与合入。

## 项目速览 / Quick overview

- Runtime: Node.js >= 24, TypeScript 5.9, ESM
- Test: Vitest（`npm test`）
- Build: `npm run build`（tsc + tsdown）

## 开发环境 / Local setup

```bash
git clone https://github.com/wanwang416/DSH-Wing.git
cd DSH-Wing
npm ci
npm run typecheck
npm test
```

## 提交前检查 / Before you submit

```bash
npm run typecheck   # 类型检查 / type check
npm test            # 单元测试 / unit tests
npm run build       # 构建产物 / build
```

> 注意：`main` 分支已启用分支保护（branch protection），协作者（Write）无法直接推送，
> 必须通过 Pull Request 合入，且需要 1 个 Review 通过。

## 如何贡献 / How to contribute

1. Fork 本仓库到你的账号（Fork the repo）
2. 从 `main` 拉出新分支：`git checkout -b feat/your-feature`
3. 提交改动，遵循 Conventional Commits：`feat:` `fix:` `docs:` `chore:` `test:` `refactor:`
4. 推送并创建 Pull Request，在描述中说明改动动机与验证结果
5. 等待 CI 与 Review，根据反馈修改

## 代码规范 / Code style

- TypeScript strict；模块统一 ESM 导入
- 命名：函数/变量 `camelCase`，组件 `PascalCase`，常量 `UPPER_SNAKE_CASE`
- 不在仓库中提交任何密钥、Token 或真实 App ID（测试中的真实样例已脱敏为假值）
- 涉及飞书 API 的改动需在 `cordis.patch.example.yml` 中同步说明

## 提交信息 / Commit messages

沿用 Conventional Commits，示例：

```
feat(web): 扫码面板新增状态轮询
fix(agent): 修正 Windows 路径规范化
docs: 补充 M4.2 使用说明
```

## 报告问题 / Reporting issues

- Bug：附复现步骤、DSH 版本、Node 版本、平台与日志片段
- Feature：说明使用场景与期望行为
- 使用仓库内 Issue 模板填写

## 行为准则 / Code of conduct

保持友善与尊重，就事论事，不搞人身攻击。
