# 第一阶段：会话、增量、恢复和停止

2026-10-21。一个 npm 包、四组模块，根入口仅导出。主链及官网计量/原生压缩已实现，79 项离线测试通过。获用户授权后，桌面与独立 CLI/Web 主链、真实恢复及手动压缩已有[主链复测](FOLLOWUP_TEST_RESULTS.md)和[摘要恢复/取消证据](RECOVERY_TEST_RESULTS.md)；完整首发验收与自然 50% 仍未完成。

2026-10-23：已改为会话级并发、活动状态与独立恢复，见 [技术方案](TECHNICAL_DESIGN.md#多会话并发与隔离)。桌面双会话真实生成重叠、独立停止与上下文/官网用量隔离已通过，其他并发组合仍待实测，见 [验证记录](VALIDATION.md)。旧账号串行测试保留原始结论，不作为新版并发证据。

| 模块 | 本阶段实现 |
| --- | --- |
| dsh | 原生适配器、start/end 与结算读取、flush、流块/错误转换、owner Remote 与设置页、CLI |
| core | 唯一 SessionEngine、增量编码、协议身份与整批校验、正文增量解析 |
| deepseek-web | 官方 create/completion/history/resume/stop、PoW、SSE 与完整消息解析、插件专用官方登录窗口（见 BROWSER_CONNECTION.md） |
| local | 凭据、跨进程锁、原子状态、撤销代次和追加诊断 |

## 主链行为

1. 默认存储身份取 DSH 公开 home paths 的 sessions 路径并规范化；自定义持久化可显式设置 sessionStoreId。该身份与 sessionId 哈希构成本地键，不复用其他 DSH 存储或其他账号的 chat。
2. 先在对应 session 文件保存操作意图，再创建 chat/提交生成。首轮 bootstrap 传有效 DSH 历史；正常续聊仅传新消息、真实工具结果及发生变化的指令/工具定义。每个请求有唯一协议身份，搜索固定关闭，思考默认开启。
3. 保存 ready 的真实 request/response ID。断流最多两次 resume 同一响应，共用原请求总期限；兼容 SSE 和业务码 22 的完整消息。去重已经显示的前缀，不重发 completion。缺 ready 时仅以历史中的父消息和精确请求摘要定位，不能唯一证明则暂停。
4. 完成后重新读取官网完整历史，核对输入、响应身份、祖先链、终态及完整正文；HTTP 200、finish 或 EOF 不代表完成。工具必须整批通过协议、名称、参数与原生 schema 校验后交付。
5. 只有 DSH 对应原生结算已保存、operationId 与正文相符，并且公开 sessions.flush 有持久化参与且成功，才推进 session 的网页父消息。普通退出通过可等待的 agent/turn-stopping 与卸载收尾完成核对；崩溃取消缺 assistant 时仅接受精确原生中断闭合及独立官网终态证据。在同一 session 文件中原子提交 confirmed 并清本会话 active；崩溃恢复以该完整封装和 lastOperationId 核对。能证明未提交或被明确拒绝的操作只清 active，不推进任何原生/网页游标。
6. DSH 原生停止立即中断本地输出。插件使用独立 5 秒期限停止并核实同一官网响应；结果不明只保留本会话 active 并阻止本会话新生成。确认停止/最终失败并核实 DSH 保存内容后，下一轮从有效 DSH 历史新建 chat。旧 chat 和日志保留，不重执行旧工具。

网页祖先链发生外部变化时暂停；用户可显式 rebuild，由下一轮从 DSH 历史建立新 chat。编辑历史导致模型可见前缀改变、原生分叉产生新 sessionId 时，也建立独立 chat。格式修正仅限已有完整合法意图缺协议包装、未显示正文且未派发工具，最多一次；修正响应是下一轮的父消息。

已显示的正文来自真正流式 JSON 字符串解码，协议外壳不显示。非前缀修订冻结后续拼接，终稿通过权威 block-end 替换；撤回会发送空块并失败。失败预览与校验前事件保留在日志，三端具体显示效果由用户手测验收。

## 使用与排查

构建和本机安装方式见 [README](README.md)。现阶段仍用原生模型选择器选择 TokenFree，原生选择会保存当前 profile 的全局默认。设置页有官方登录，以及“核实原请求”“停止遗留生成并核实”。正在生成时使用会话本来的停止按钮；核实操作仅检查原请求，绝不补发问题。

只读本地状态，不登录、不联网：

```sh
node lib/cli.js inspect
node lib/cli.js inspect <sessionId>
node lib/cli.js usage <sessionId>
```

明确要求从 DSH 历史重建（不会立即联网或删除官网历史）：

```sh
node lib/cli.js rebuild <sessionId>
```

这两个 CLI 命令使用默认 DSH 存储身份。自定义 sessionStoreId 必须在相同插件配置的主机端使用 owner Remote inspect/rebuild 能力；不能用默认 CLI 键冒充自定义存储。核实与停止遗留请求通过运行中 DSH 的 owner Remote 执行，独立 CLI 不伪造原生持久化结果。

数据目录沿用 DSH_TOKENFREE_HOME 或默认插件 home。account.json 只保存账号身份、凭据提交校验与撤销代次；sessions/<hash>.json 保存各自 confirmed 和 active，版本化并私有原子写入。新版本不猜测或认领旧 MVP chat；首次请求建立新关联。文件损坏、未知版本或不安全路径会暂停并保留原件，不自动重置。

诊断按 operationId 串联 logs/events.jsonl 与 logs/requests/<operationId>.jsonl。重点查看 operation.state、stream.resuming、stream.stopping、operation.pending、native.commit 和 operation.committed。完整记录实际 wire body、逻辑 SSE（包括拒绝事件）、校验与提交；认证头、Cookie、登录响应和 PoW 解答不记入日志。默认本地追加、不自动清理。

常见错误：

| 错误码 | 含义与处理 |
| --- | --- |
| PENDING_OPERATION | 原请求/停止/原生持久化尚未核实；先使用设置页核实原请求，保留日志 |
| WEB_CONTEXT_CHANGED | 官网祖先链变化；确认以 DSH 为准后显式 rebuild |
| NATIVE_CONTEXT | 缺原生尝试关联；不带原生 session 的直接 LlmRuntime 调用只按临时请求处理 |
| WEB_DISCONNECTED | 两次同响应恢复仍未完成；插件核实停止，不重新发问题 |
| AUTH / WEB_CHALLENGE | 官方要求验证或安全检查；使用插件专用官方登录窗口（见 BROWSER_CONNECTION.md），不转到付费 API |
| INPUT_TOO_LARGE | 命中本地字符保护上限，不等于官网上下文超限 |
| COMPACTION_REQUIRED / COMPACTION_PENDING | 官网门槛已到或压缩待核实；检查后端装配和原生 checkpoint，不重发问题 |

## 用户手动验收

详细执行顺序、主链与压缩用例及日志判据见 [真实运行测试计划](LIVE_TEST_PLAN.md)；首轮桌面结果见 [实机记录](LIVE_TEST_RESULTS.md)，最新三端恢复结果与逐项缺口见 [复测记录](FOLLOWUP_TEST_RESULTS.md)。

下面是手动复验顺序。本任务用户已授权研发直接实机测试，使用本人单账号和合成测试内容：

1. 同一 DSH 会话连续发送两轮，再执行一次文件读取。正常情况下官网只有一个 chat；第二轮请求只包含新增用户消息，工具后续步骤只包含真实工具结果和必要目录变化。
2. 确认正文和思考在完成前出现；思考默认开启，官网搜索关闭。
3. 生成途中短暂断网后恢复，确认继续同一响应、内容不重复；恢复失败应停止/暂停，不出现重复问题或新 completion。
4. 点击 DSH 停止，确认本地立即停止，日志显示官网确认。下一轮建立新 chat，并保留 DSH 已显示的中断内容。
5. 重启 DSH 后在原会话继续，正常完成的 chat 被复用；遗留操作先核实。官网外部改写、DSH 编辑/分叉分别符合上文规则。

这些涉及真实账号与额度，由获授权的执行者操作；本地测试覆盖不等于真实服务、桌面/CLI/Web 的组合验收。

## 留到后续阶段

官网预算读取、50% 判断、原生 compaction/checkpoint、原 chat 精确摘要、新 chat 接续和 usage 展示已有源码及离线组合验证，装配与边界见 [计量与压缩说明](COMPACTION.md)。自动启用按钮、其余 toolChoice/结构化输出策略与派发前目录竞态保护仍待后续交付。没有估算 usage 或假窗口。三端及冷恢复已执行的路径见复测记录；完整组合、摘要故障和实际 npm tgz 干净安装仍待验收。
