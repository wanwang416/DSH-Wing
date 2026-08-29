# Changelog

> 里程碑记录：M0 → M4.1。commit 历史已脱敏，详见 `git log`。

## M4.1 · P2 开源交付（2026-08-29）

- `chore` 开源脱敏——注释中性化 + 路径/App ID 移除 + 文档移出 + README 中英重写

## M4.1 · P1 验收闭环（2026-08）

- `chore` 群聊寒暄判定加诊断日志（验收遗留——"你好"直通疑点需观察 mentions）
- `feat` 意图桥 + 第二批命令（`/resume` `/workspace` `/steer` `/setup`）
- `feat` 审批卡（四按钮 + 老板限定 + 记忆）
- `feat` 单选卡框架 + preset 管理 + 模型 GUI 同步

## M4.1 · P0 收尾

- `fix` 三个遗留项（计数虚高 / 空闲重连噪音 / steer-diag 可配置）
- `feat` 六个核心命令 + runtime 可变状态
- `feat` 命令三级分流（含 C2 followup 补发钩子）
- `feat` 任务中断四类分类

## M4 · 终审与稳定性

- `fix` 三风险闭环修复（终审）
- `fix` 提问桥补传 timeoutMs 根治 30s 静默过期（连续卡片中断根因）
- `fix` 移除提问卡片 form 容器恢复卡片弹出
- `fix` form 提交按钮补 form_action submit（真机回归）
- `fix` 提问卡片 note→markdown 修多选 400 + 内置「其他反馈」输入框
- `fix` 真机三问题修复（单飞竞态 / 400 盲降级 / chat_type 透传）
- `test` 全局行覆盖率 45.83% → 89.64%
- `refactor` 事件处理提取 event-handler 模块 + apply 集成测试
- `fix` 死代码修复 + chatTypeOf 提取补测
- `fix` chat_type 动态判断 + 撤回停止 agent + 覆盖率补测
- `fix` 恢复打字机流式 + 按钮断言，修复 M3 终审失败

## M3 · 交互卡与流式输出

- `fix` 提问卡片点击无响应根因修复（schema 2.0 按钮回调格式）
- `fix` 日志落盘，不依赖终端窗口
- `fix` 卡片按钮回调失败与流式卡片限频
- `fix` reasoning 防抖导致限频 + 提问卡雪崩
- `fix` 真机三处飞书 API 修复
- `feat` 交互式提问卡片 + CardKit 流式打字机 + ToolStep 富卡片

## M2 · 连接监督与消息管道

- `fix` WS 阻塞 + 插话不生效 + 桥冲突 + batching 吞插话
- `fix` 心跳检测（2min 无事件自动重连）、WS 接收问题记录
- `feat` 连接监督（WS 卡死修复）、入站 WAL + 补偿、batching、群策略、全类型解析、chunker/cardkit/fallback、流式卡片集成
- `feat` 基线对齐（session nonce + generation、preset 挂载、StreamingCard 单卡流式、原生 compact）

## M1 · 最小可用

- `fix` workspace attach + workspaceRoot 配置、停用词、单条回复、工具结果合并
- `feat` 飞书桥最小可用（sessions / streaming / tools / steer / stop / outbox）

## M0 · 脚手架

- `ci` GitHub Actions：PR 与 main 的 typecheck/test/build
- `chore` 插件骨架（TypeScript + Cordis）
