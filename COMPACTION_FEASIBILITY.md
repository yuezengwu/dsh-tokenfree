# 压缩选区与官网根分支的可行方案

> 2026-10-23 最新策略：门槛改为 B 的 50%；B 读取不到时用默认 890,880，并记录默认来源。C 仍只用官网计数，缺 C 不触发。下文旧比例、缺 B 规则及验证数字保留当时记录，现行规范以 [技术主方案](TECHNICAL_DESIGN.md#压缩接入边界) 为准。

实现进展（2026-10-21）：下文保留方案调研时的证据与时态；后续已授权并完成官网 C/B、原生压缩和 usage 的源码与离线组合验证，当前装配及限制以 [计量与压缩说明](COMPACTION.md) 为准。新版真实 DSH 整链验收仍待用户手测。

2026-10-21。**发布版 DSH 已有公开安全检查与压缩事务接口，可由插件做很小的候选选区适配；官网同 chat 根编辑的独立根、准确测试输入、旧主链保留与新 chat 承接，已在当前账号短文本样本中通过真实验证。** 用户随后授权研发代为验证，实际完成 4 次生成和浏览器刷新检查；证据见 [真实验证结果](COMPACTION_LIVE_VALIDATION.md)。插件代码、依赖与安装配置未修改，实际 DSH 组合接入未实现。

这补齐了 [压缩接入核对](COMPACTION_INTEGRATION.md) 的两项条件。推荐采用下述方案；其中“完全继承内部范围选择”需准确改为“插件计算候选范围，复用原生配对检查和压缩事务”，不宣称能直接调用未导出的内部函数。

## 证据与验证范围

| 对象 | 本轮确认 |
| --- | --- |
| DSH 源码 | 0.2.1-rc.2，提交 687f282e8625c6b8d11ff58211a90524be2e4317 |
| npm 发布包 | 只读下载并检查 @deepseek-ai/dsh-compaction 与 dsh-compaction-basic 同版本 tarball；分别 22,449 和 37,044 字节，均无 src 文件 |
| 公开检查函数 | compaction 发布 JS 与类型声明均导出 toolPairingBalancedBefore、toolPairingBalancedAfter；公开 compactRegion 要求调用方指定合法范围 |
| 内部选择函数 | basic 发布 JS 主入口只导出 BasicCompactionEngine 及其 default 别名，未导出 selectCompactableRange；不使用源码深导入、bundle 私有符号或复制整个引擎 |
| 离线原生函数核验 | 在临时内存环境提取并转译现有 DSH 的配对模块、systemHead 和 selectCompactableRange，运行 9 个夹具；未编写插件选区实现、未启动 DSH |
| 官网公开前端 | 重新取得 main.a34f79a498.js，1,592,032 字节，SHA-256 49d1f126646236b5aabb8ee530f5f0953b542ad36fd1f9fa073d3499b62ab71c，与已审阅版本一致；只做静态阅读 |
| 官网真实响应 | 当前账号创建 2 个测试 chat、完成 4 次生成；根编辑新增 5→6 独立根，旧 1→2→3→4 保留，REPLACE 历史两次复核通过；18 项接口断言和刷新后旧分支检查通过 |

发布包导出检查证明调用入口存在，离线夹具证明当前源码范围语义，真实响应验证本次官网样本；它们均不等于插件装配和真实 DSH 整轮压缩已完成。

## 压缩范围的公开接口方案

### 选区与执行分别负责

TokenFree 负责官方 C≥0.8B 判断和很小的保留范围策略。DSH 负责工具配对是否安全、摘要输入构造、表面稳定性、摘要是否缩短、compaction 事件、checkpoint 与取消。无需真实模型窗口，也不将官网 B 传入 contextWindow。

推荐首发主动压缩采用**与原生 retainTokens=0 相同的保留规则**：保留最后一个表面节点；若该节点属于工具调用/结果组，则向前扩大保留段，直到原生判定配对平衡。0 表示不设额外的近期 token 保留预算，**不表示保留零条消息**。这是原生手动与真实超限路径已使用的规则；首发主动触发复用其语义，不套用依赖真实窗口的默认 retainRatio。

候选选区步骤如下，全部在 DSH 接入模块中完成，core 不导入 DSH session 类型：

1. 读取当前 surface.nodes 的原有顺序；不能按 seq 数值排序，checkpoint 替换后 seq 可以不递增。
2. 如果首节点是 system/message，将它排除在待压缩区间之外；没有系统头则从首节点开始。
3. 从最后一个节点开始确定保留段。调用公开 toolPairingBalancedBefore，若切在未配对的工具组内，向前移动保留起点，直至平衡。
4. 待压缩区间为非系统头到保留起点之前的连续前缀。区间为空则返回“无可压缩范围”，不能伪造成功。
5. 用公开 toolPairingBalancedBefore/After 再核实两端，将 start/end 原样交给继承的 BasicCompactionEngine.compactRegion；原生事务还会重新校验成员、顺序、配对和整个表面稳定性。

插件只挑“保留哪段尾部”，不复制配对计数器、摘要指令、checkpoint framing、替换操作或缩短判断。即使插件候选计算有误，原生 compactRegion 仍拒绝不安全范围。单个保留工具组或新输入本身过大时可能无法通过压缩恢复，必须明确报错。

### 离线案例结果

| 表面场景 | 原生 retainTokens=0 的结果 |
| --- | --- |
| 仅系统头 | 无范围 |
| 系统头、用户、回答、新用户输入 | 压缩旧用户与回答，保留新输入 |
| 用户、并行两工具调用、两个结果位于尾部 | 整组调用与结果保留，不截开工具组 |
| 完整工具组后又有新输入 | 旧工具组可进入压缩前缀，新输入保留 |
| seq 为 0、40、7、10 | 按表面位置得到 40 至 7 的区间，不按数字排序 |
| 没有系统头 | 首节点可以进入压缩区间 |
| 仅一个工具组 | 没有可压缩前缀 |
| 尾部仍有未完成工具调用 | 调用保留，不将其拆进前缀 |
| 孤立工具结果 | 原生配对检查拒绝损坏表面 |

9 项通过只是原生函数语义核验。后续仍需验证插件候选区间与这些结果一致，以及安装包里的服务继承和生命周期接线。

### 原生事件接线及失败检查

兼容 Basic 组合时只装配一个派生 compaction 服务：TokenFree pressure 分支用官网指标和上述候选范围，再调用继承的 compactRegion；其他路由交回 super。手动 compactNow 保留原生空闲维护；真实 context-overflow 才进入原生超限恢复。不在压力分支伪造超限或调用需要空闲的 compactNow。用户自定义 compaction 后端不自动替换，先做兼容检查。

原生 agent/pre-step 监听会捕获压缩错误、记录警告后继续，因此仅覆写 compactIfNeeded 不足以保证“达到门槛先压缩”。DSH 接入须把压缩阶段和失败传给插件 core；正常生成入口在联网、获取本会话锁前再次核实：如果本分支已知达到门槛而压缩未完成，或 checkpoint 后新 chat 未初始化，就报明确的压缩/初始化错误，不发送普通 completion。purpose=compaction 允许通过这一普通请求检查，否则会阻塞自身摘要。

缺少 C/B 且没有未完成压缩时仍按已确认规则允许普通对话。失败标记不能因原生捕获异常而清除；仅在核实 checkpoint 和新 chat 关联后推进代次。普通生成前不持有会被摘要再次请求的同一会话锁。不同 session 的生成、C/B 判断和摘要独立并发，A 的压缩不阻塞 B；2026-10-23 已按此规则实施；本地与真实验收见 [验证状态](VALIDATION.md)。

## 同一个网页 chat 的准确摘要方案

### 为什么编辑根输入

在旧尾部追加“总结前 N 轮”，模型仍沿父链看到保留尾部和其他历史，不能精确对应 DSH 选区。编辑非根输入也仍继承其祖先。推荐编辑**该 TokenFree 当前 chat 主链的根 USER 消息**，把 DSH 交来的完整 compaction 请求一次编码为新的根输入；chat ID 保持不变，摘要在新根分支生成。

已审阅前端提供以下依据：

| 前端位置 | 可确认行为 |
| --- | --- |
| EE.initFakeMessages | 查询被编辑消息的父消息；新 USER 沿用该父 ID，没有父消息则 parent=null；分配新的临时用户与回答身份 |
| addNewUserMessageCompose 与 addMessageIdToParent | 新增用户消息并插入父节点 childIds；无父节点走根分支入口，不在此处删除原消息 |
| SU.startStream | editMessage 向 /api/v0/chat/edit_message 发送原 message_id 和新 prompt；不另传 parent_message_id，也不支持凭空指定根 |
| Er.onReady / onNewAssistantMessage / S6 | 从 ready 与首次 SET 取得实际 request/response ID、parent_id，替换临时身份；不能沿用客户端临时 ID |
| rg 历史投影 | 从服务端 chat_messages 的 parent_id 重建多个根及 childIds；不是只能在当前前端缓存看到旧分支 |

静态证据支持根编辑形成独立根分支，后续真实请求进一步确认当前账号样本的正式父链和旧根保留。两者都不能宣称后台 KV 内部可审计、任意长龄根或其他账号一定可用；对应运行检查仍保留。

### 准确范围如何定义

准确输入以原生 purpose=compaction 的请求为准：原生选区对应的投影消息、原生加入的系统头与工具上下文、末尾原生摘要指令。插件只加入必要的文本桥接控制和关联信息，不再附加旧网页主链、保留尾部、当前正常任务输入或其他辅助分支。

工具目录使用此次摘要请求给出的快照，不拿当前普通任务的工具并集替换。历史工具结果保持数据身份；辅助请求禁止工具派发。思考沿用触发任务实际设置，手动压缩用当前 session 设置；搜索关闭、网页模型不变。摘要输出与官方计数归属摘要分支，不推进正常父消息，也不把摘要分支 C 当作正常主链 C。

编码后还须检查官网实际输入字符上限及本地字节保护，单位保持字符/字节，不换算 token。单条根输入放不下准确摘要范围时明确报输入过大，不擅自缩小范围、裁掉工具结果或拆成会引入额外回答的多个请求。新根输入重放选区，不保证继承官网旧主链的 KV 缓存；复用原生摘要内容和事务不等于保证官网缓存命中。

### 请求与验证顺序

1. 锁定本次压缩身份、选区表面快照和原生摘要请求摘要值。核实插件持有的根 USER 是当前主链祖先、parent_id=null、属于当前账号与 chat，且官网没有未确认生成或停止。
2. 保存操作意图、旧主链游标、旧根/后代的可核实内容及父链摘要。取得 completion 目标的 PoW，调用 edit_message，不删除任何旧消息。
3. 请求字段为 chat_session_id、原根 USER 的 message_id、准确编码的 prompt、ref_file_ids=[]、实际 thinking_enabled、search_enabled=false、action=null。不添加 edit 接口未使用的 model_type、messages、system、tools 或自定义父 ID。
4. 收集 ready 和实际消息快照。服务端返回的根 USER 必须是新的正式身份；摘要 assistant 的 parent_id 必须指向该新 USER。断流只 resume 原摘要响应，接受状态不明时查历史，不重发编辑。
5. 在将成功摘要交给原生事务之前，读取可核实的官方历史。使用无缓存版本的完整核实路径，不用前端 MERGE 缓存里残留的旧消息来证明服务端保留。确认新 USER 的 parent_id=null、其 prompt 与本次编码一致、摘要父链没有旧主链，并确认旧根及旧主链消息的内容与关系仍存在。
6. 同时核实摘要终态、非空正文和文本协议合法；若不能核实以上条件，不向原生返回成功摘要，DSH 不应据此提交 checkpoint。原生还会验证表面稳定和缩短，不由插件绕过。
7. DSH 实际提交 checkpoint 后，按既定规格创建**另一个 chat**继续同一 DSH session，导入系统、当前工具、checkpoint 和保留尾部一次。这里只改变续聊 chat，摘要仍在压缩前的同一个 chat 完成。

服务端可能改变前端默认选中的分支，插件始终按记录的消息 ID 维护主链与辅助分支，不读取“当前选中的最后回答”作为父消息。全文与关联日志保留，旧网页 chat 不自动清理。

### 失败处置

| 失败 | 行为 |
| --- | --- |
| 原根找不到、已被手动修改或不是根 USER | 不试编辑任意消息，停止并说明官网关联异常 |
| 旧根太久不可编辑、锁定或服务端拒绝 | 记录业务证据，当前摘要方案不可用；不改为尾部追加全历史摘要或换 chat 摘要 |
| 编辑接受状态未知 | 保留 pending，按输入摘要与根身份查找唯一候选；找不到或不唯一则暂停 |
| 新 USER 不是根或复用旧 USER 并覆盖内容 | 不交付成功摘要，不提交新 checkpoint；保留原生状态和诊断。上游已发生的官网编辑不能声称可回滚 |
| 官方历史仍只有局部缓存、读取失败或旧消息缺失 | 不宣布分支保留验证通过；继续核实已有操作，不重发生成 |
| 原生认为摘要未缩短或表面已改变 | 不提交 checkpoint；保留摘要分支供诊断，不自动重复编辑 |
| checkpoint 已提交，新 chat 创建或导入失败 | 保留已提交 checkpoint 和待初始化状态；恢复已有新 chat，不重新摘要或接回旧主链 |

## 官网验收步骤

用户本次明确授权研发代为执行，已使用专门的临时官网 chat 完成受控接口与浏览器验证。下列步骤保留为后续回归清单。

1. 首条消息放一个随机的旧分支口令，随后追加两轮，让最后一轮包含另一个随机的尾部口令；记录原根与后代的正式 ID。
2. 编辑首条消息，替换为一个独立的摘要输入，包含新的事实和摘要指令，但不包含两个旧口令。思考开启、搜索关闭；观察新根 USER、新摘要 assistant 及 ready/首次 SET 身份。
3. 完成后刷新并通过无缓存的 history_messages 响应核对：同一 chat、两个不同根、新根 parent_id=null、旧根及全部旧后代仍存在，摘要只接新根。仅 UI 上能切回旧分支不够。
4. 核对本次编辑实际请求只包含新的输入；摘要没有引入旧分支或尾部口令。口令检查是辅助证据，未泄漏口令不能单独证明服务端隔离；需要与父链、请求和旧分支保留一起检查。
5. 可切回旧分支查看原记录；不删除它。另在新的临时 chat 中只导入所得摘要与应保留尾部，核对续聊承接；这一步只验证官网协议，不能代替插件的原生 checkpoint 组合验收。

本次真实响应与浏览器刷新结果已满足上述根分支保留及受控新 chat 承接检查，见 [证据与正式 ID](COMPACTION_LIVE_VALIDATION.md)。后续任一账号或请求若否定根编辑，仍报告与规格的差异；独立摘要 chat 不成为自动后备。实际 DSH checkpoint 组合和异常路径留到实现期验收。

## 本轮结论与规格调整

- DSH 分发缺口已定位到私有选择函数，不是缺少公开安全与提交能力。现版本可采用插件最小候选选区加公开边界检查和原生 compactRegion，无需修改 DSH 核心或伪造窗口。
- 推荐主动压缩采用原生 retainTokens=0 的等价尾部规则；候选位置计算归插件，配对安全、摘要输入和事务归 DSH。若要求完全调用同一个内部选择函数，则当前版本不能满足，需要 DSH 后续增加正式导出；本轮不修改它。
- 官网采用根 USER 编辑建立同 chat 的独立摘要根分支，成功摘要在核实官方父链和旧分支保留后才交给 DSH；checkpoint 后新 chat 续聊不变。
- 当前官网短文本样本已真实通过；剩余为实际发布包/插件装配、原生 checkpoint 衔接及大输入、断流、停止等实现期验收。这不影响已确认的官方计数 80%、不切模型、不估算 usage/触发和先不实现。

## 依据

- 公开配对检查（`DSH packages/compaction/compaction/src/tool-pairing.ts:112`）、公开 compactRegion 约束（`DSH packages/compaction/compaction/src/index.ts:166`）、原生选区语义（`DSH packages/compaction/compaction-basic/src/region.ts:117`）。
- 自动监听捕获后继续（`DSH packages/compaction/compaction-basic/src/index.ts:160`）、原生事务调用（`DSH packages/compaction/compaction-basic/src/index.ts:358`）、原生摘要输入与调用（`DSH packages/compaction/compaction-basic/src/summarizer.ts:116`）。
- [npm compaction 元数据](https://registry.npmjs.org/@deepseek-ai%2fdsh-compaction/0.2.1-rc.2)、[npm basic 元数据](https://registry.npmjs.org/@deepseek-ai%2fdsh-compaction-basic/0.2.1-rc.2)、[官网已审阅脚本](https://fe-static.deepseek.com/chat/static/main.a34f79a498.js)。网页方法证据详见 [协议记录](WEB_API_REFERENCE.md)。
