# 工具与最终输出设置

设置属于本机某个 DSH 存储实例中的一个 session，桌面、CLI、本机 Web 共用对应记录。默认工具 `auto`、输出 `text`；没有全局覆盖，不为其他会话修改设置。设置和摘要、用量一样留在现有本地状态文件中，无新增服务或监听端口。

当前 DSH 的 GenerateOptions 没有通用 tool_choice/response_format。这些选项通过插件 CLI 或已有 owner Remote 设置，不扩展原生请求字段，也不在单张设置卡片增加控件。

## 使用

将以下内容保存为本地 `settings.json`，然后执行：

```sh
dsh-tokenfree policy <sessionId> settings.json
dsh-tokenfree policy <sessionId>
```

开发 checkout 先运行 `pnpm build`，将上述 `dsh-tokenfree` 替换为 `node lib/cli.js` 即可。独立 CLI 使用包声明的 SDK peer 依赖；DSH 宿主内通过 owner Remote 操作同一设置，不需要启动独立 CLI 或新增端口。

例如，禁用工具并要求最终 JSON：

```json
{"tools":{"mode":"none"},"output":{"type":"json"}}
```

恢复默认：

```json
{"tools":{"mode":"auto"},"output":{"type":"text"}}
```

CLI 默认定位当前 DSH_HOME 的标准 sessions 存储及 TokenFree 本地目录；自定义 DSH_HOME 时使用与目标宿主相同的环境。非标准存储、显式 sessionStoreId 的宿主通过本身的 owner Remote 设置，不能用默认 CLI 猜测其身份。

插件已有 owner Remote 提供 `tokenfree.policy(sessionId)` 和 `tokenfree.setPolicy(sessionId, settings)`，参数与上面的 JSON 一致。返回值另带 revision，仅用于识别设置版本；写入只传 tools/output。读写不需要登录，不发送官网模型请求。会话有活动或待核实操作时拒绝修改，不等待其他 session。

## 工具选择

| tools | 作用 |
| --- | --- |
| `{"mode":"auto"}` | 持续生效；模型可以回答或调用本轮声明的工具 |
| `{"mode":"none"}` | 持续生效；不发送工具目录，拒绝任何工具分支 |
| `{"mode":"required"}` | 下一次正常生成必须给出工具批次 |
| `{"mode":"named","name":"read_file"}` | 下一次批次只能调用该名称；没有对应本轮声明时提前报错 |

工具名以 DSH 当前模型可调用的声明为准。PTC 模式通常只直接声明 run_code；不能用指定内层名称绕过其外层调用契约。审批、沙箱、执行及真实错误继续由 DSH 处理。

required/named 只有在合规批次被 DSH 保存并通过公开 flush 核实后才恢复 auto。恢复原响应、一次格式修正、压缩、标题、错误或取消均不消耗它；已保存但执行被原生拒绝时已经消费，不反复要求批准。输出设置保持。策略 revision 与确认游标在同一次原子写入中更新，重启或迟到结算不能重复消费。

## JSON 与 Schema

`output.type` 为 text、json 或 schema。schema 示例：

```json
{
  "tools": {"mode":"auto"},
  "output": {
    "type":"schema",
    "schema": {
      "type":"object",
      "properties":{"ok":{"type":"boolean"},"items":{"type":"array","items":{"type":"string"}}},
      "required":["ok","items"],
      "additionalProperties":false
    }
  }
}
```

工具步骤仍使用工具协议；只有 final.text 按最终格式校验。JSON 允许对象、数组、字符串、数值、布尔及 null 根。重复键、多份根、代码围栏、尾随内容和不完整 JSON 均拒绝，不抽取片段、不强转或补默认值。

schema 复用 DSH 公共子集：单一 type、properties、required、布尔 additionalProperties、items、标量 enum/const、oneOf 与支持的说明字段。$ref、$defs、anyOf、pattern、范围等未支持约束在生成前报错。设置最大 65,536 字符，JSON 嵌套最多 64 层。它是本地校验，不是官网约束解码。

结构化正文完整校验后才交付；思考仍真流式。stop 作用于最终可见文本后重新检查完整 JSON，截断导致非法值时明确失败。工具说明不当作最终 JSON；摘要保持原生摘要格式，不受最终输出设置约束。

## 工具目录变化

请求固定当时的目录，发送增删/完整替换以及内容版本；仅排序或对象键序变化不更新定义。生成前确认原生声明仍匹配，交付前整批复核被调用定义；无关新增不阻止正常候选。

仅旧目录快照缺失、而消息分支和提交可核实时，在原 chat 的下一次增量中显式替换完整目录，不重发历史或额外请求确认。损坏的快照和未知请求仍阻断，不能用目录替换绕过核实。

DSH 保存调用后，插件从该 callId 的原生消息、operationId 和本地持久快照核实关联。tools.guard 在审批结束、工具体执行前，再比较当前作用域中该工具的描述、参数、声明属性及输出定义。失效时只拒绝，记录并回传原生错误；不替换工具或重跑。PTC 内层同样检查，web_search 不能绕过。插件卸载时，已保存且尚未完成的旧调用保留原生拒绝，重载后新的调用不受影响。

检查不声称与第三方热更新具有跨进程原子事务，也不能识别所有可见定义完全不变的实现语义变化。旧版本在途调用没有持久快照时拒绝执行；升级前正常退出旧宿主。已验证与未验收范围见 [验证记录](VALIDATION.md)。
