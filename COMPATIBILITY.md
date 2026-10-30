# DSH 兼容与验证边界

核对日期：2026-10-30。npm 发布版 `dsh-tokenfree@0.2.0` 仍固定支持 DSH `0.2.1-rc.3`；它的发行提交、包及标签没有变化。下表新增支持仅属于当前 main，尚未发布新的 TokenFree 版本。

## main 已验证宿主

| DSH | 官方精确源码 SHA | 本轮验证 |
| --- | --- | --- |
| 0.2.1-rc.3 | `1f81c047fc48fa190a683e469daa699857e9afe8` | 保留原支持；协调 SDK 全量检查、同一包的隔离 web 配置与 headless 原生挂载 |
| 0.2.1-rc.4 | `504a01a9578abc2c6f1fb896b1dc322c9fe24f66` | 协调 SDK 全量检查、同一包的隔离 web 配置与 headless 原生挂载 |
| 0.2.2-alpha.2 | `f3803c96974ad4a94195fb97e5c637e9c2a3afe3` | 协调 SDK 全量检查、同一包的隔离 web 配置与 headless 原生挂载；宿主要求 Node >=24.9 |

三个发布 SDK profile 均完成干净安装、frozen install、构建、类型、129 项检查与实际包校验。开发依赖固定 alpha.2，重新解析锁文件避免混入旧 SDK；peer 与 engines 保留 rc.3 并显式追加 rc.4 / alpha.2。共享清单、CI 精确源码 SHA、引擎与开发依赖由兼容一致性门禁核对。

alpha.2 移除了旧的 ModelSelectionProjection 类型导出；客户端从公开 projection 接口直接推导类型，无运行时行为变更。alpha.2 将工具执行器拆为独立插件，并把 tools.execute 改为批次入口：仅更新裸 SDK 测试装配及直接调用夹具，使用官方原生 executor / pipeline；真实宿主仍由其官方组合提供执行器，不在 TokenFree 中复制或接管工具执行。原生工具等待审批、目录变化、嵌套父令牌、取消与卸载拒绝的原断言继续通过。

同一 alpha.2 构建包在三个精确源码宿主各安装到独立 web / headless profile。web 只检查组合配置；headless 禁用任务 runner，以真实原生宿主探针确认提供方、固定模型、TokenFreeCompactionEngine、auto=true 及 retainTokens=0 / compactionRetries=0 策略。探针使用全新临时账号路径，禁止 fetch 和模型调用。全量测试另以合成网页夹具覆盖原生 50% 压缩、checkpoint、新 chat 承接、流式、停止/恢复、工具与会话隔离。CI 对发布依赖的 Node 22/24、Linux/macOS 及三个固定源码宿主运行；当前提交 / main CI、不可变安装和产物核对链接随 PR 保存。

这不是新的真实账号、自然达到 50% 门槛、Chrome 登录、Desktop 或完整官网组合验收；历史真实样本保持各自原版本与日期。不修改用户账号、个人配置或日常宿主。

## 当前 npm 渠道

CLI npm `latest=next=0.2.1-rc.5`，`alpha=0.2.2-alpha.2`；各 SDK 标签独立。rc.5 的官方 tag / Release 当前不可用，CLI 元数据没有 gitHead，因此不接纳 rc.5，也不直接把下面的命令换成 @latest 或 @next。

使用新增兼容需安装 main，而非旧 npm 0.2.0：

```sh
npx @deepseek-ai/dsh@0.2.1-rc.4 plugin --profile web add github:yuezengwu/dsh-tokenfree#main
npx @deepseek-ai/dsh@0.2.1-rc.4 --profile web
```

alpha.2 同样固定 CLI 版本，并先满足 Node >=24.9：

```sh
npx @deepseek-ai/dsh@0.2.2-alpha.2 plugin --profile web add github:yuezengwu/dsh-tokenfree#main
npx @deepseek-ai/dsh@0.2.2-alpha.2 --profile web
```

旧 npm 包仍按 README 与原 rc.3 发行范围使用。Git 依赖通过 prepare 构建；无新 npm 发布或 tag。审计安装使用 PR 中提供的完整不可变提交 SHA，避免 main 后续移动。
