# DSH 兼容与验证边界

核对日期：2026-11-14。npm 发布版 `dsh-tokenfree@0.2.0` 仍固定支持 DSH `0.2.1-rc.3`；它的发行提交、包及标签没有变化。下表新增支持仅属于当前 main，尚未发布新的 TokenFree 版本。

## 当前渠道与默认安装（2026-11-14）

[官方 rc.3](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.3) 固定源码 `38a6a5c965aa99ab525161efb7cc5cf1fe62fced`。CLI npm latest 为 rc.1，next 为 rc.3，alpha 为 alpha.3。store 的独立 latest 为 0.1.2-alpha.2，next 为 rc.3。开发 SDK 固定 rc.3，默认安装固定 rc.1，保留全部七个旧宿主。npm 0.2.0 的支持范围仍为 DSH 0.2.1-rc.3。

### 2026-11-13 rc.2 渠道与兼容证据

[官方 rc.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.2) 固定源码 `ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c`。CLI npm latest 固定 rc.1，next 固定 rc.2，alpha 固定 alpha.3；store 的独立 latest 仍为 0.1.2-alpha.2，next 为 rc.2。新增 rc.2 并保留全部六个既有宿主。

协调 rc.2 SDK 与 Cordis 4.1.0 / Loader 1.1.0，显式固定开发所需的间接 peer，防止锁文件混入旧版 SDK。rc.2 收窄 LlmError 构造器的错误码类型；适配器和 CLI 通过新版公开失败转换或旧宿主构造器保留原错误码。原生工具、压缩、计量和会话逻辑沿用既有实现。证据范围见[验证记录](VALIDATION.md)。

### 历史渠道记录（2026-11-06）

CLI npm `latest=next=0.2.2-rc.1`、`alpha=0.2.2-alpha.3`；store 独立 `latest=0.1.2-alpha.2`、`next=0.2.2-rc.1`、`alpha=0.2.2-alpha.3`。只有 CLI latest 从 rc.5 升至已验证的 rc.1，其余四十组已跟踪标签不变；别名与固定 rc.1 的 tarball/integrity 一致，官方 SHA 仍为 `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`。

默认 main 安装固定 rc.1（Node >=24.9），保留 rc.5 回退及全部六个宿主；npm 0.2.0 仍只承诺原 rc.3 范围。生产源码、测试、SDK、锁文件、引擎、清单与 CI 均不改。冻结安装、兼容一致性、构建、实际包检查、当前提交/main CI、完整 SHA 安装与产物比对随 PR 保存。本地 129 项检查、固定源码及同包原生挂载证据保留 2026-11-05 日期，不重复完整本地测试，不新增真实账号或自然 50% 验收，也不发布新版本或标签。

## main 已验证宿主

| DSH | 官方精确源码 SHA | 本轮验证 |
| --- | --- | --- |
| 0.2.1-rc.3 | `1f81c047fc48fa190a683e469daa699857e9afe8` | 保留原支持；协调 SDK 全量检查、同一包的隔离 web 配置与 headless 原生挂载 |
| 0.2.1-rc.4 | `504a01a9578abc2c6f1fb896b1dc322c9fe24f66` | 协调 SDK 全量检查、同一包的隔离 web 配置与 headless 原生挂载 |
| 0.2.1-rc.5 | `b830ec950faba0a46dda564be3e2d854afed94f1` | 协调 rc.5 SDK 全量检查、同一 alpha.2 构建包的隔离 web 配置与 headless 原生挂载 |
| 0.2.2-alpha.2 | `f3803c96974ad4a94195fb97e5c637e9c2a3afe3` | 协调 SDK 全量检查、同一包的隔离 web 配置与 headless 原生挂载；宿主要求 Node >=24.9 |
| 0.2.2-alpha.3 | `05b1cae8db6e674c5685101494d4eec24652424a` | 协调 SDK、129 项检查、同一包隔离 web 组合与 headless 原生挂载；Node >=24.9 |
| 0.2.2-rc.1 | `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db` | 协调 SDK、129 项检查、同一包隔离 web 组合与 headless 原生挂载；Node >=24.9 |
| 0.2.2-rc.2 | `ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c` | 协调 SDK、129 项检查、同一包隔离 web 组合与 headless 原生挂载；Node >=24.9 |
| 0.2.2-rc.3 | `38a6a5c965aa99ab525161efb7cc5cf1fe62fced` | 协调 SDK、129 项检查、同一包隔离 web 组合与 headless 原生挂载；Node >=24.9 |

2026-10-30 三个发布 SDK profile 均完成干净安装、frozen install、构建、类型、129 项检查与实际包校验。开发依赖固定 alpha.2，重新解析锁文件避免混入旧 SDK；peer 与 engines 保留 rc.3 并显式追加 rc.4 / alpha.2。共享清单、CI 精确源码 SHA、引擎与开发依赖由兼容一致性门禁核对。

alpha.2 移除了旧的 ModelSelectionProjection 类型导出；客户端从公开 projection 接口直接推导类型，无运行时行为变更。alpha.2 将工具执行器拆为独立插件，并把 tools.execute 改为批次入口：仅更新裸 SDK 测试装配及直接调用夹具，使用官方原生 executor / pipeline；真实宿主仍由其官方组合提供执行器，不在 TokenFree 中复制或接管工具执行。原生工具等待审批、目录变化、嵌套父令牌、取消与卸载拒绝的原断言继续通过。

2026-10-30，同一 alpha.2 构建包在当时三个精确源码宿主各安装到独立 web / headless profile。web 只检查组合配置；headless 禁用任务 runner，以真实原生宿主探针确认提供方、固定模型、TokenFreeCompactionEngine、auto=true 及 retainTokens=0 / compactionRetries=0 策略。探针使用全新临时账号路径，禁止 fetch 和模型调用。全量测试另以合成网页夹具覆盖原生 50% 压缩、checkpoint、新 chat 承接、流式、停止/恢复、工具与会话隔离。CI 对发布依赖的 Node 22/24、Linux/macOS 及四个固定源码宿主运行；当前提交 / main CI、不可变安装和产物核对链接随 PR 保存。

这不是新的真实账号、自然达到 50% 门槛、Chrome 登录、Desktop 或完整官网组合验收；历史真实样本保持各自原版本与日期。不修改用户账号、个人配置或日常宿主。

## 2026-11-05 0.2.2-rc.1

官方 rc.1 于 2026-11-04 13:07:14 UTC 发布，固定源码 `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`。CLI npm `latest=0.2.1-rc.5`、`next=0.2.2-rc.1`、`alpha=0.2.2-alpha.3`；相关 SDK 标签独立核对。开发 SDK 协调至 rc.1、Cordis 4.1.0 / Loader 1.1.0；引擎、peer、共享清单、CI 与锁文件追加第六宿主，保留五个旧版本及 SHA。与 alpha.3 的官方源码差异全部为 387 处版本清单，本轮仍独立构建、安装与验收。

冻结安装、类型、129 项检查、生产依赖审计、构建与实际包通过。固定源码冻结安装和完整构建 10/10 门禁通过，同一发布依赖构建 tarball 在新宿主通过隔离 web 配置组合与 headless 原生挂载，确认提供方、固定模型、TokenFreeCompactionEngine、auto=true、retainTokens=0 / compactionRetries=0，零网络 / 模型调用。headless 确认 Agent 作用域接线，完整标准预设自动接线另由 SDK 合成夹具验证。生产源码和测试不变；35 个 JavaScript 产物中 33 个与 M42 字节相同，两份 TypeRT 各只差一行依赖路径注释。

六个精确源码宿主 CI 安装同一份 tarball；当前提交 / main 的九项 CI、完整 SHA 安装及产物核对随 PR 保存。旧宿主本地证据保留原日期，不重写为本轮真实通过。没有真实账号、Chrome 登录、自然达到 50% 或 Web UI 新验收；npm 0.2.0 及 GitHub v0.2.0 仍限原 rc.3 范围，没有新发布或标签。

```sh
# Verified next; Node >=24.9. Replace main with a verified merge SHA for an immutable install.
npx @deepseek-ai/dsh@0.2.2-rc.1 plugin --profile web add github:yuezengwu/dsh-tokenfree#main
```

## 2026-11-04 alpha.3

官方 alpha.3 于 2026-11-03 07:56:48 UTC 发布，精确 SHA 见上表。开发 SDK 协调至 alpha.3，Cordis 4.0.6-alpha.2、Loader 1.0.7-alpha.2；引擎、peer、清单、CI、锁文件追加 alpha.3，保留四个已支持宿主。冻结安装、类型、129 项检查、生产依赖审计、构建、实际包校验通过。核心生成、流式、取消/恢复、工具、会话隔离及原生 50%/checkpoint 组合继续使用既有合成夹具，无生产源码变更。

同一 alpha.3 构建 tarball 在固定 alpha.3 源码上通过 web 配置组合及真实 headless 提供方、模型、TokenFreeCompactionEngine、auto=true / 策略挂载，零网络和模型请求。headless 探针确认 Agent 作用域的原生压缩，不冒充有完整标准预设服务；标准预设自动接线由 SDK 合成夹具另验收。五个源码宿主 CI 安装同一份包，当前提交/main、固定 SHA 安装和产物核对随 PR 保存。其余四个宿主的本地证据保持原日期；没有真实账号、自然50%或 Web UI 新验收。

CLI npm `latest=next=0.2.1-rc.5`、`alpha=0.2.2-alpha.3`，SDK 标签各自独立。新增兼容只属于 main，npm 0.2.0 仍仅承诺 rc.3，未创建新发布或标签。

## 2026-10-31 rc.5（历史）

2026-10-31 历史记录：CLI npm `latest=next=0.2.1-rc.5`，`alpha=0.2.2-alpha.2`；各 SDK 标签独立。官方 rc.5 tag / Release 已于 2026-10-30 02:12:26 UTC 补齐，精确源码见上表。2026-10-31 保留 rc.3、rc.4、alpha.2，追加 rc.5；开发依赖保留 alpha.2，rc.5 的 Cordis 4.0.5 / loader 1.0.6 协调 SDK 在独立干净 profile 完成冻结安装、类型、129 项检查与实际包检查。rc.5 未拆出原生工具执行器，测试沿清单使用旧宿主组合。

rc.5 只调整思考展示，TokenFree 不消费变更的 Slot；本轮无业务源码、协议、压缩或工具执行变动。固定源码完成冻结安装与完整构建，同一 alpha.2 构建 tarball 在 rc.5 进行 web 组合配置及 headless 原生提供方、模型、压缩 auto/策略挂载验证，禁止网络及模型调用。四个精确源码宿主纳入 CI；当前提交 / main CI、不可变安装与产物比对随 PR 保存。之前三个宿主的本地测试保持 2026-10-30 日期。

这不补充真实账号或自然 50% 压缩验收，不改变 npm 0.2.0 的 rc.3 支持范围。

## main 安装（2026-11-14）

使用新增兼容需安装 Git main；旧 npm 0.2.0 仍按 README 搭配原 rc.3。默认固定 rc.1，需要 Node >=24.9：

```sh
npx @deepseek-ai/dsh@0.2.2-rc.1 plugin --profile web add github:yuezengwu/dsh-tokenfree#main
npx @deepseek-ai/dsh@0.2.2-rc.1 --profile web
```

npm next 固定 rc.3（Node >=24.9）：

```sh
npx @deepseek-ai/dsh@0.2.2-rc.3 plugin --profile web add github:yuezengwu/dsh-tokenfree#main
npx @deepseek-ai/dsh@0.2.2-rc.3 --profile web
```

保留先前默认版 rc.5 回退：

```sh
npx @deepseek-ai/dsh@0.2.1-rc.5 plugin --profile web add github:yuezengwu/dsh-tokenfree#main
npx @deepseek-ai/dsh@0.2.1-rc.5 --profile web
```

alpha.3 同样固定 CLI 版本并满足 Node >=24.9；alpha.2 保留支持：

```sh
npx @deepseek-ai/dsh@0.2.2-alpha.3 plugin --profile web add github:yuezengwu/dsh-tokenfree#main
npx @deepseek-ai/dsh@0.2.2-alpha.3 --profile web
```

Git 依赖通过 prepare 构建；无新 npm 发布或 tag。审计安装使用 PR 中提供的完整不可变提交 SHA，避免 main 后续移动。
