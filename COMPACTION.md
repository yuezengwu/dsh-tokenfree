# 官网计量与原生压缩

2026-10-21。已实现源码及离线组合测试。用户授权研发实测后，桌面和独立 Web 的原 chat 摘要、原生 checkpoint、重启与新 chat 承接已通过；CLI 原生装配已核实。摘要 SSE/JSON 22 恢复及实际取消已通过[后续复测](RECOVERY_TEST_RESULTS.md)；自然 50% 仍未真实覆盖。

2026-10-23：按会话并发、独立收尾及精确摘要停止已实施，并补充真实 DSH 原生压缩引擎与模拟官网组合验证；标准模式摘要与另一会话正文生成的真实重叠、checkpoint 和新 chat 承接已通过本轮验收，范围及额外故障见 [验证记录](VALIDATION.md)。模块与原生压缩架构不变。

## 计量口径

| 项目 | 取得与用途 |
| --- | --- |
| C | 当前已确认 chat/message 的 history.accumulated_token_usage，原值保存；SSE 生成中观测单独显示 |
| B | 优先读取 client/settings 中与官网 model_type 精确匹配的 model_configs[].file_feature；思考开启取 token_limit_with_thinking，关闭取 token_limit。读不到当前模式有效值时用默认 890,880，来源标记 default |
| 主动门槛 | 整数比较 C ≥ ceil(B/2)，例如 B=1001 时从 C=501 触发；不运行本地 tokenizer、不累加多条 C |
| 模型、档位、时间 | 每次读取保存实际模型类型、思考模式、字段名、配置版本和观测时间，且绑定账号、分支与消息 |

B 是官网文件功能预算参考或用户指定的默认预算，不能称为模型总窗口、账号剩余额度或单次输入/输出账单。50% 策略与默认 B 于 2026-10-23 确认，取代旧 80% 与“缺 B 停用主动判断”；默认门槛为 445,440 tokens。没有按 input/output/total 拆分 C，也不向 DSH 标准 usage 或 contextWindow 填入替代数值。原生压缩内部的估算、缩短校验保持原样，不作为官网计量展示。

缺 C 时仍允许正常对话，界面显示未知，停用 50% 判断；不估算 C、不填 0。仅预算配置不可用时使用默认 B，并在辅助详情、Remote 和本地记录标明默认来源，不借用其他模型、模式或旧配置。官网分支核实失败、认证失效、网页验证或取消仍暂停/结束原流程，不能用默认预算绕过。历史编辑后等待新 chat 的计量，不借旧分支的 C 触发压缩。退出账号使旧指标失效；已失败或未完成的压缩不能通过“指标未知”绕过。

## 一次压缩如何完成

1. 原生 pre-step 调用派生后端；插件核实当前官网分支与模式，按 C/B 判断。保留最后一个表面节点，必要时扩大到整个工具组；排除系统头，按 surface 位置选择其余连续前缀，复用原生配对检查。
2. 调用继承的 BasicCompactionEngine.compactRegion。原生负责摘要输入、原生末尾指令、工具快照、范围稳定性、缩短校验与事务；手动压缩继续用原生 compactNow 的空闲维护规则。模型固定，思考跟随当前任务/会话的实际选择，搜索关闭，不派发辅助工具。
3. 原生 purpose=compaction 的准确输入，编码到当前 chat 主链根 USER 的 edit_message。得到独立的新根分支；重新读取完整 REPLACE 历史，核实新根 parent=null、正文、摘要父链和旧主链保留。输入过长直接报错，不截断、不擅自缩小选区。
4. 核实摘要后交给原生引擎。只有原生 summary、checkpoint、end 完整匹配且公开 flush 有持久化参与并成功，才标记“等待新 chat”。摘要分支的 C 不推进普通主链。
5. 下一次正常生成新建 chat，bootstrap 当时 DSH 有效 checkpoint、保留尾部、当前系统及工具；原生保存首个响应后确认新关联。新 chat 的 C 独立使用，不把旧 C 或摘要 C 加上去。

DSH 的 pre-step 会捕获压缩错误后继续，因此普通模型入口还有一道检查：达到门槛或压缩失败/待核实，阻止新的普通 completion。原生 checkpoint 已提交后，即使初始化失败，也只恢复新 chat 初始化，不重做摘要、不回滚 checkpoint；已确认为空的初始化 chat 会复用。接受状态不明仍暂停。

摘要断流最多恢复原 response 两次，不重复 edit_message。卡片“停止摘要”携带 sessionId、operationId、compactionId，由宿主比较后取消该摘要已有的控制器，取消继续传入继承的原生摘要流程；不能用异步检查后无条件取消当前会话的方式冒充精确停止。已知 ready 时向原 response 发独立 stop，再在 5 秒期限内完整核实历史；缺 ready 仍须唯一发现原响应。未确认时只保留并阻塞本会话 active，其他会话可继续。摘要未变短、旧分支不保留或原生保存失败均不伪造 checkpoint。修复原因后可显式调用原生手动压缩重试。服务端真实 CONTEXT_LENGTH_EXCEEDED 才进入原生超限恢复；本地字符保护不冒充超限。

压缩前后只核对所属会话，不调用全局恢复并等待全部完成。外层不持会话锁进入摘要；摘要结束释放官网阶段的锁后，再核实该会话原生 checkpoint。一个会话 flush、压缩或收尾失败不影响其他会话的生成、用量和提交。

## 接入：随 TokenFree 主插件生效

最新确认：不再要求用户单独选择 `dsh-tokenfree/compaction`、编辑 YAML 或逐个 preset 配置。压缩不是独立功能；本人登录可用且会话启用 TokenFree 时，官方 C/B 50% 判断、原 chat 摘要、DSH 原生 checkpoint 和新 chat 承接必须一起可用。准确职责、接线约束和最少界面状态统一见[技术主方案](TECHNICAL_DESIGN.md#压缩接入边界)。

主插件现通过公开 Cordis 生命周期替换现有同作用域 Basic 槽位，覆盖标准预设的后续挂载；普通请求联网前再次确认接线。其他模型保留原 auto 设置与策略，自定义后端不覆盖；初始化失败仅阻止该作用域的 TokenFree 请求，卸载恢复原服务。保留的 `/compaction` 出口仅供内部解析和旧配置兼容，依赖主插件，不要求用户配置。实际标准预设、50% 触发与卸载恢复已有离线组合验证，真实范围见 [验证记录](VALIDATION.md)。

修复保留公开 Basic 引擎的原生范围校验、缩短判断和持久化事务，仅针对 TokenFree 接入官网策略和网页迁移。不得加载竞争的处理链、覆盖其他模型行为或绕过用户自定义后端。兼容性失败由插件明确报告，不能推给用户“配置压缩”。

## 查看与排查

桌面/本机 Web 在设置 → TokenFree 的单张卡片以“用量 {C} tokens”展示当前网页分支的官网计数；文件功能预算、50% 门槛、详细计量、来源、时间及待结算观测保留在辅助文本和 CLI/owner Remote 中。摘要停止、核实等操作位于卡片标题右侧，不另设会话标题用量面板。

```sh
node lib/cli.js usage <sessionId>
```

CLI 只读本地数据，不登录、不请求官网；应使用与宿主相同 DSH_HOME 和插件 home。显式 sessionStoreId 的组合使用同宿主 owner Remote usage；默认 CLI 不猜测其存储身份。离线 CLI 无法检查运行中的压缩后端，其输出只证明已保存的官网观测。

日志继续本地保留、不自动清理。metrics.observed 记录经过投影的官网原值、字段与来源；摘要 dsh.request 记录原生 compactionId/startSeq 和准确输入；web.request/web.event/web.response、native.commit 串起根编辑、恢复、校验、checkpoint 与新 chat。设置响应中的 JWT、认证头、Cookie 和 PoW 解答不会记入日志。

真实测试步骤见 [测试计划 E 组](LIVE_TEST_PLAN.md#e官网计量与原生压缩)。本地验证覆盖门槛、未知/0、原生事务、工具边界、断流、取消、缩短失败、刷盘失败、初始化恢复和 usage 界面。真实结果见复测记录；摘要故障的实际结果见后续复测；自然 50% 不能由手动压缩或模拟计量代替。
