# DeepSeek 网页对话接口参数与能力

2026-10-20。本文说明官网前端实际使用的对话协议，供 TokenFree 产品和技术设计参考。

官网采用服务端会话、父子消息和 SSE 事件管理对话。普通续聊只提交新输入并引用父消息，编辑、重生成、继续、恢复流和停止生成分别有对应接口。当前公开前端没有向这些接口提交独立 system 消息或用户自定义工具声明。

## 阅读范围与依据

重新获取官网 HTML 后，对其加载的公开编译产物作静态语法解析，追踪输入参数组装、网络发送、SSE 校验、消息树、重生成和恢复流程。没有执行下载的脚本，也没有用真实账号调用生成、编辑、停止或恢复接口。

- [官网主脚本](https://fe-static.deepseek.com/chat/static/main.a34f79a498.js)：1,592,032 字节，SHA-256 `49d1f126646236b5aabb8ee530f5f0953b542ad36fd1f9fa073d3499b62ab71c`。
- [官网依赖脚本](https://fe-static.deepseek.com/chat/static/default-vendors.3473f64207.js)：1,031,463 字节，SHA-256 `2b0a5517ea9651adfdc364d01f2a46a5459c1db5c0056886823da43c54c71451`。其中的字段校验器用于核对消息 ID 等数据形态。

以下描述的是当前前端的调用方式，不是官方公开的服务端完整 schema；未出现的参数不能据此判定服务端一定拒绝，也不能当作已支持的能力。账号可用模型和功能由动态配置及服务端共同决定。

## 普通对话补全

请求为 `POST https://chat.deepseek.com/api/v0/chat/completion`，正常生成返回 SSE。

网络发送器对 completion 场景组装以下十个字段。表中形态来自前端正常调用路径，服务端的完整必填规则没有公开在该代码中。

| 字段 | 前端可见形态与来源 | 用途 |
| --- | --- | --- |
| `chat_session_id` | 网页创建接口返回的字符串 ID | 选择已有网页会话 |
| `parent_message_id` | 服务端消息 ID，首次为 null | 将新输入接在指定消息之后；正常续聊引用上一条 assistant 响应 ID |
| `model_type` | 模型类型字符串，或 null | 新对话采用所选模型类型；已有真实父消息时，普通发送路径传 null，而不是逐轮强制传 default |
| `prompt` | 本次输入文本 | 单条用户输入，不是 messages 数组 |
| `ref_file_ids` | 已准备好的文件 ID 数组，无文件时为空数组 | 关联经过上传、解析等流程的文件 |
| `thinking_enabled` | 上层传入的思考开关，正常界面操作使用布尔值 | 控制官网思考模式，受模型能力约束 |
| `search_enabled` | 上层传入的搜索开关，正常界面操作使用布尔值 | 控制官网内置联网搜索，受模型与文件兼容性约束 |
| `source` | 来源标记；未提供时 JSON 序列化会省略 | 前端透传入口来源，例如外部打开来源；不是工具声明 |
| `action` | 未指定时为 null；失败消息重发路径出现 retry | 动作标记；前端代码不能证明任意字符串都可用 |
| `preempt` | 布尔值，由请求父消息的生成状态计算 | 父消息仍在生成时，前端将其设为 true 并进入中断后发送的流程；不是并发数量参数 |

前端维护临时消息 ID，并在发送时避免把临时 ID 当作服务端父消息。ready 事件里的 request 和 response 消息 ID 由依赖脚本的 number 校验器校验；它们与 UUID 形式的网页 session ID、DSH 自己的 tool callId 是三种不同身份。

### 首次输入示意

以下会话 ID 及后续消息 ID 均为说明占位，不是可直接调用的真实记录：

```json
{
  "chat_session_id": "由创建接口返回的网页会话ID",
  "parent_message_id": null,
  "model_type": "default",
  "prompt": "请介绍一下这个项目。",
  "ref_file_ids": [],
  "thinking_enabled": false,
  "search_enabled": false,
  "action": null,
  "preempt": false
}
```

### 下一轮输入示意

假设首次 ready 返回的 response 消息 ID 为 2，则下一轮沿用同一网页会话，父消息填 2，prompt 只放新增输入。前端已有真实父消息时使用 null 模型类型的调用方式如下：

```json
{
  "chat_session_id": "同一个网页会话ID",
  "parent_message_id": 2,
  "model_type": null,
  "prompt": "继续说明其中的登录流程。",
  "ref_file_ids": [],
  "thinking_enabled": false,
  "search_enabled": false,
  "action": null,
  "preempt": false
}
```

已有历史通过父消息链由服务端关联，前端不会为了普通续聊重新发送整个角色消息数组。

## 登录与工作量证明

官网 HTTP 客户端默认启用登录 token，并从其 token store 注入 Bearer Authorization。普通对话路径还先请求 `POST /api/v0/chat/create_pow_challenge`，请求体包含目标路径；计算完成后生成 `X-DS-PoW-Response` 请求头。

该证明头编码的内容包含 algorithm、challenge、salt、answer、signature 和 target_path。completion、regenerate 和 editMessage 的前端路径都使用 completion_like 的挑战流程；其证明头构造使用 `/api/v0/chat/completion` 作为目标路径。continue 和 resumeStream 的这条前端路径没有主动获取新的挑战。

HTTP 客户端还统一生成客户端 bundle、平台、版本、语言和时区请求头，部分路径使用设备信息。具体值来自运行环境，而不是对话参数。本文不包含任何真实 token、Cookie 或可复用的认证值。

## SSE 返回的不只是回答文本

| 原始事件 | 前端解析的主要字段 | 能力与含义 |
| --- | --- | --- |
| `ready` | request_message_id、response_message_id、可选 model_type | 获得服务端输入与响应身份，支持续聊、中断定位和恢复 |
| 未命名 data 事件 | p、o、v | 主要内容增量；前端按 delta 解析，没有要求必须出现名为 delta 的 event 行 |
| `title` | content | 服务端生成的会话标题 |
| `update_session` | updated_at | 更新会话时间等前端状态 |
| `update_parent_message` | chat_message | 更新父消息状态或内容 |
| `update_file` | id、status、retryable 等文件字段 | 文件状态变化与解析结果 |
| `hint` | type、content、clear_response、可选 finish_reason | 错误或提示，可要求移除当前响应；不能把它当作普通回答文本 |
| `toast` | type、content、可选 finish_reason | 提示通知或错误 |
| `finish` | 当前解析器不读取事件数据 | 流程事件；不能单凭此事件臆造未返回的响应内容或消息 ID |
| `close` | 可选 click_behavior，retry 或 none | 流程关闭，附带界面的后续动作提示 |

增量采用压缩的对象更新协议：p 表示路径，o 为 SET、APPEND 或 BATCH，v 为值。路径与操作可省略并继承前一次状态，BATCH 内部还有相对路径。它不是开放平台的 choices/delta 响应格式。

响应中的 fragments 同样有不同类型。官网前端明确处理正文 RESPONSE、模板回答 TEMPLATE_RESPONSE、思考 THINK、请求 REQUEST、文件 FILE、搜索 SEARCH，以及 TOOL_SEARCH、TOOL_OPEN、TOOL_FIND、READ_LINK 和提示片段等。把所有片段拼成一条正文会混淆不同功能。

消息状态包括 WIP、FINISHED、INCOMPLETE、CONTENT_FILTER、CONTEXT_LENGTH_EXCEEDED 和 TIMEOUT。官网同时维护 ready、delta、close、业务错误和已收到完整消息等状态，断开网络本身不能证明回答已经成功或失败。

官网发送器有 60 秒等待 ready 的检测，以及默认 10 秒的 SSE 心跳超时检测；心跳阈值可由响应头调整。这些是连接活性规则，不等于固定的整轮生成总时限。

## 会话与生成的相邻接口

以下请求地址均相对于 `https://chat.deepseek.com`。它们属于同一套网页对话流程，不能全部合并为重新调用 completion。

| 接口 | 方法与请求字段 | 前端用途 |
| --- | --- | --- |
| `/api/v0/chat_session/create` | POST，空对象 | 创建网页会话，返回会话信息和 ttl_seconds 等数据；普通续聊复用已有会话 |
| `/api/v0/chat/history_messages` | GET，chat_session_id、cache_version、cache_reset_at | 加载历史，返回会话与消息；前端根据 REPLACE 或 MERGE 合并缓存 |
| `/api/v0/chat/regenerate` | POST，chat_session_id、child_message_id、search_enabled、thinking_enabled、user_options | 对已有回答重新生成；child_message_id 指向原 assistant 回答，界面维护其分支 |
| `/api/v0/chat/edit_message` | POST，chat_session_id、message_id、ref_file_ids、prompt、search_enabled、thinking_enabled、action | 从已有用户消息发起编辑并再次回答，界面为编辑结果维护新的消息与分支身份 |
| `/api/v0/chat/continue` | POST，chat_session_id、message_id、fallback_to_resume | 用户继续指定的响应；官网这条路径设置 fallback_to_resume 为 true |
| `/api/v0/chat/resume_stream` | POST，chat_session_id、message_id | 恢复指定响应的接收，供历史恢复与断流恢复使用；不带新的 prompt |
| `/api/v0/chat/stop_stream` | POST，chat_session_id、message_id | 向服务端发出停止请求；与本地中止 HTTP 连接是两个动作 |

### 重生成选项

前端菜单根据模型配置决定是否提供简洁、详细、强制搜索或关闭搜索选项。传入 user_options 的已见形态是 verbosity 为 low/high，或 search 为 force_on/force_off；普通再次尝试可传空对象。

这些选项出现在 regenerate 请求中，不能据此认定普通 completion 接受相同 user_options 字段。它们也不等价于 temperature 或 max_tokens。

### 恢复流与继续生成

resume_stream 定位已经存在的响应；continue 发起对指定响应的继续操作。重新提交 completion 则是新的输入请求。三者的请求体和界面流程不同。

恢复时如果服务端已完成响应，官网发送器会处理非 SSE 的 JSON：业务码 22 对应返回完整消息，前端以该消息结束恢复。因此，恢复实现必须同时处理 SSE 与“已有完整消息”的 JSON，不能只接受 text/event-stream，也不能一律把该业务码当成错误。

源码还区分消息未找到、恢复时间过长、当前消息不是叶节点和消息被锁定等情况。可恢复不代表所有历史消息永远都能重新连接。

## 多轮与分支怎样工作

正常输入路径先找到当前选中分支，再找该路径中的最后一条真实服务端消息，作为新请求的父消息。ready 确认服务端身份后，前端把临时消息替换成真实消息。下一轮接在新响应后面。

会话状态明确包含 rootBranchIds、rootBranchIndex；消息状态包含 parentId、childIds 和 currentChildIndex。重生成与编辑都会维护分支索引。因此，官网使用消息树，而非只有一条无法回退的文本历史。

这已足以支撑正常 DSH 多轮续聊，以及设计重生成、编辑和断流恢复。把任意 DSH 历史压缩或跨模型切换映射成官网的同会话新分支，仍需验证具体接口行为；消息树存在不等于任意历史重写都已可用。

## 工具 系统指令与生成参数的边界

| 能力 | 官网前端实际证据 | 对 TokenFree 的意义 |
| --- | --- | --- |
| 普通提示文本 | completion 有 prompt | 可直接传本轮文本输入 |
| 服务端多轮历史 | session、父子消息、ready 与历史接口 | 应保存关联并发送增量，避免逐次创建网页会话 |
| 思考模式 | thinking_enabled 与 THINK 片段 | 网页能力存在；插件当前关闭它，不代表官网接口不能思考 |
| 内置搜索与网页浏览工具 | search_enabled，TOOL_SEARCH、TOOL_OPEN、TOOL_FIND 等片段 | 属于官网自身工具流程，不能当作 DSH read/write/exec 的调用 |
| 文件与图片相关流程 | ref_file_ids、上传、文件解析与图像文件字段，动态视觉模型配置 | 网页具备相关路径；插件当前仅做文本，尚未接入这些能力 |
| 自定义 DSH 工具声明 | completion 请求组装中没有 tools、tool_choice 等字段 | 没有已确认的原生注册途径，现有工具能力来自文本协议桥接 |
| 独立 system 角色 | 对话角色使用 USER/ASSISTANT，completion 没有独立 system 或 messages | 系统指令目前需用文本表达，不能声称具有原生 system 角色的优先级 |
| 采样与输出限制 | completion 请求组装中没有 temperature、top_p、max_tokens、stop、response_format | 不能宣称已有与开放平台相同的控制能力 |

本表判断依据是实际调用和渲染路径，不是仅凭关键词出现或缺失。内置工具片段的存在能证明官网搜索等流程使用工具结果，但不能证明客户端可以注册自己的函数。

模型类型来自带 model scope 的客户端动态配置，前端按 enabled、switchable 和 is_default 选择可用项，另读取文件、搜索、思考、输入字符上限及重生成选项。default 是回退模型类型标识，不足以保证固定映射某一代 Flash。源码中的文件 token 预算或文件大小回退常量也不能当作当前账号的模型上下文或免费配额。

## 业务错误与额度信息

前端可见的业务码中，下列几类直接影响适配器设计：

| 业务码 | 前端枚举的含义 |
| --- | --- |
| 1 | 无效网页会话 |
| 2 | 父消息角色不是 assistant |
| 3 | 达到消息数量上限 |
| 7、8 | 恢复消息不存在，或恢复时间过长 |
| 11 | 上一条消息仍在生成 |
| 15 | 思考额度超限 |
| 22 | 恢复时已经得到完整消息，前端走完整消息处理 |
| 23 | 当前消息不是叶节点 |
| 24、25 | 当前消息或父消息被锁定 |
| 26 | 父消息 ID 无效或不存在 |
| 40029 | IP 访问受限 |
| 40300、40301 | PoW 头错误或证明无效 |

HTTP 状态与业务码需要分开处理。官网还有 WAF/captcha/challenge 判断，403 或 429 不能只按网页登录失效来解释。生成请求返回 HTTP 200 也仍可能携带业务错误，或在 SSE 中产生提示和过滤状态。

历史消息暴露 accumulated_token_usage，文件信息暴露 token_usage，前端将这些返回值用于分支与文件预算判断。它们不能直接等价为开放平台的精确输入输出 token 账单；这些调用路径没有给出可据此展示的统一“剩余免费调用次数”。

### accumulated_token_usage 的含义与官网实际用法

2026-10-20 再次读取官网公开 HTML，其主脚本仍为 main.a34f79a498.js，重新下载的 SHA-256 与本文记录一致。以下结论来自消息映射与所有 accumulatedTokenUsage 使用位置，而非只根据字段名推断。

| 位置 | 可直接确认的行为 |
| --- | --- |
| 历史映射 nc | 将每条消息的 accumulated_token_usage 映射为 accumulatedTokenUsage，同时保留 message_id、parent_id |
| 首条响应映射 S6 | 读取 SSE 初始 response 快照中的同名字段；原始字段不等同于前端临时消息继承的数值 |
| xQ.useBranchUsedTokenCount | 取当前选定父消息的 accumulatedTokenUsage，作为该分支已用 token；不把历史每条消息的值相加 |
| xQ.useBranchAndProcessingFilesTokenCount | 分支已用值加上当前文件列表中的 tokenUsage |
| xQ.useMaxTokenNewFilesAllowed | 文件功能的 token 预算减去该分支已用值，得到新文件可用预算 |
| cf / getTokenConfig | 读取当前模型 file_feature.token_limit 或 token_limit_with_thinking；缺配置时前端回退 61,440 |

因此，插件应将它解释为**官网在该消息处提供的当前分支累计 token 计数**，并以“官网分支累计 token”显示。官网把它用于上下文与文件预算判断；这不能证明它是精确的模型 KV 占用，更不能证明它是账号级历史消耗、剩余免费额度或单次调用的输入/输出账单。是否包含思考、搜索内部内容以及服务端裁剪前后的口径，单凭前端无法进一步确认。

特别注意：这里读到的上限是文件功能配置，前端回退值也只是客户端默认。不能把它们直接标成模型总上下文窗口，或据此显示未经确认的上下文百分比。

补充本机已有缓存证据：2026-10-20 21:04:04.024 +08:00 的官网模型配置记录中，default、expert、vision 的 file_feature.token_limit 与 token_limit_with_thinking 均为 890,880，input_character_limit 为 2,621,440。这是一份既有缓存快照，不是本次请求实时账号接口所得。可基于该官方预算及分支累计值制定明确标注的预防性压缩策略；不能据此将 890,880 宣称为真实模型总窗口。完整接线与边界见 [自动压缩接入核对](COMPACTION_INTEGRATION.md)。

使用规则：以当前 chat、当前分支所关联服务端消息的最新原始返回值为准；新快照替换旧快照，不逐轮相加。SSE 期间可标记为生成中的观测，结束或恢复后通过 history_messages 核实对应消息。字段缺失或核实失败时显示未知或明确标记为旧观测，不补 0、不继承临时前端消息的值。

例如两条连续响应分别返回 12,000 和 15,300（仅示例），第二轮显示 15,300。27,300 没有累计意义；3,300 只能是两次观测的数值变化，不能据此声称“本轮消耗 3,300”。压缩后新 chat 的计数独立起算，不能把多个 chat 的此类累计值相加冒充账单。

本项目按用户要求只保存和展示官方返回值，不计算估算 token。DSH 的 inputTokens/outputTokens 是单次调用计量，不能用该累计字段凑齐；单个累计值也不写入 DSH 的 totalTokens。可使用现有插件通信与本地状态展示该原始字段，无需新开服务端口。

## 对当前插件设计的修正

首发应以官网实际协议为基础，先补齐持久会话、消息 ID、SSE 状态和恢复，再讨论界面层的体验包装：

1. 正常聊天及工具步骤共用一个关联网页会话；续聊使用确认过的响应 ID，并只追加新增上下文。
2. SSE 返回值应包含消息身份与状态，而不只是一条文本；工具结果的 callId 对应关系和 isError 仍需保留。
3. 断流优先研究 resume_stream 的接收恢复，用户停止时考虑 stop_stream，避免把两者实现成重复提交 prompt。
4. 利用已确认的编辑和重生成接口设计分支；上下文压缩如何重建分支单独验收。
5. 内置搜索、思考、文件和视觉能力与 DSH 自定义工具分别设计；是否纳入首发还未确认。

本次只形成接口说明和方案依据，没有修改运行时代码，也没有把文本工具桥接路线标记为用户已确认。

## 源码定位

| 位置 | 追踪内容 |
| --- | --- |
| 主脚本 SU.startStream | 五种流式场景的 URL、完整请求体、证明头、JSON 完整消息与 HTTP 错误处理 |
| 主脚本 SC、Sg、事件字段校验 | SSE 事件、number 类型消息 ID、压缩增量与相对批次 |
| 主脚本 Ef、E_、EE、Ek、Eo | 普通发送、重生成、编辑、继续与恢复的具体界面流程 |
| 主脚本模块 58636 | 当前分支路径、父子消息与临时 ID 处理 |
| 主脚本模块 87287 | 正文、思考、文件和内置工具片段分类 |
| 主脚本模块 7017 | default 回退与动态模型选择 |
| 主脚本模块 63021 | 会话与生成业务错误枚举 |
| 主脚本模块 84212 | PoW 挑战管理与证明头编码 |
| 主脚本模块 6594 | 客户端请求头与 WAF/challenge 识别 |
| 依赖脚本模块 44623 | 前端字段校验函数 |
