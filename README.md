![DSH-TokenFree](https://raw.githubusercontent.com/yuezengwu/dsh-tokenfree/main/assets/readme/dsh-tokenfree.png)

# TokenFree

> 为穷学生带来免费的 DSH

A local DSH plugin for students. No paid API key required.

TokenFree 为预算有限的学生而做，[DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 能在工作目录中调用工具、读写文件并推进任务。如果确实囊中羞涩，TokenFree 把 DSH 接到你自己的 DeepSeek 网页账号上，让这些能力帮助你进行日常学习和研究。

## 安装与使用

首个公开版本为 **0.2.0**。当前支持范围：**macOS、DSH 0.2.1-rc.3、已安装 Google Chrome**。DeepSeek 网页接入仍为实验性；官网协议变化可能影响可用性。

`main` 另外验证了 DSH **0.2.1-rc.4 / 0.2.2-alpha.2**，保留 rc.3；这些改动尚未进入 npm 0.2.0。新增兼容的固定版本安装命令、源码 SHA 和验证边界见[兼容约定](COMPATIBILITY.md)。当前 CLI npm latest/next 已指向待源码验证的 rc.5，请按兼容约定固定已验证版本；alpha.2 要求 Node >=24.9。

1. 在 DSH 的「插件 → 添加插件」中输入 `dsh-tokenfree@0.2.0` 并安装。
2. 打开「设置 → TokenFree」，点击「登录」，在专用官方窗口中完成 DeepSeek 登录。
3. 点击「使用」，或在模型列表中选择 **TokenFree · DeepSeek Web**。点击「使用」也会设为当前 DSH profile 的默认模型。

登录由本机桌面、CLI 和 Web 共用。不同 DSH profile 需要各自安装插件；退出 TokenFree 会同步撤销三端使用。插件不新增监听端口，不读取日常 Chrome 账号。

桌面和本机 Web 使用相同的插件安装入口。使用 DSH CLI 时，可以安装到 headless profile：

```sh
dsh plugin --profile headless add dsh-tokenfree@0.2.0
```

先在桌面完成登录；再保存以下内容为 `tokenfree.yml`，用 `dsh headless --patch ./tokenfree.yml "你的任务"` 启动：

```yaml
- id: agent-default-model
  config:
    provider: tokenfree-deepseek-web
    model: web-default
```

CLI 自行读取同一份登录，无须另行配置压缩。独立诊断/登录 CLI 的高级用法见[会话设置](POLICIES.md)。

[GitHub Release](https://github.com/yuezengwu/dsh-tokenfree/releases/tag/v0.2.0) · [npm](https://www.npmjs.com/package/dsh-tokenfree) · [变更记录](CHANGELOG.md) · [发布流程](RELEASING.md)

## 能力与限制

- 支持多轮增量上下文、会话并发、流式思考与正文、停止和断流恢复。
- 工具经过完整校验，再交给 DSH 原生审批与执行；支持[工具选择与 JSON/schema 最终输出](POLICIES.md)。工具采用文本协议桥接，不是官网原生 function calling。
- 使用官网 C/B 按 50% 门槛自动接入 DSH 原生压缩；读不到 B 时采用默认 890,880，C 不估算。摘要在原网页 chat 生成，checkpoint 保存后新建 chat 续聊。
- 首发关闭网页搜索和内置 web_search，不支持文件上传、图片或音频输入。

普通对话、文件工具、桌面并发及手动压缩已有实机证据；自然 50% 自动触发、新工具策略与结构化输出的完整真实组合仍待验收。rc.3 已通过本地 Node 22/24 与原生宿主验证，历史真人测试的宿主版本单独记录，详见[验证记录](VALIDATION.md)。官网撤回导致历史请求消失时，原会话可能保持待核实；可从 DSH 独立分叉继续，不自动清除状态或重复派发工具。

## 使用演示

### 登录配置

![登录配置](assets/readme/tokenfree-login.png)

### 选择模型

![选择模型](assets/readme/tokenfree-model-selection.png)

## 常见问题

### “免费”具体指什么？

TokenFree 采用 MIT 协议，插件本身不收费。它使用你自己的 DeepSeek 网页账号，无需购买付费 API Key 或 API 额度。账号要求、服务可用性与使用限制以 [DeepSeek 官网](https://chat.deepseek.com/)为准。

### 我的数据会去哪里？

模型在 DeepSeek 服务器上运行。对话中发送的问题、相关文件内容和工具结果，会通过你的账号发送到 DeepSeek 网页服务。插件的登录凭据与诊断日志保存在本机；日志可能包含任务内容。

### 这是 DeepSeek 官方项目吗？

这是社区独立维护的非官方插件，与 DeepSeek 官方没有隶属或背书关系。DSH 与 DeepSeek 网页服务分别由其上游项目维护。

### 如何更新或卸载？

在 DSH 插件管理中更新或卸载；更新前查看变更记录中的 DSH 兼容要求。首次请明确安装 `0.2.0`，旧 `0.0.0-stage` 是不可用占位版本。卸载不自动清理本地日志；如需退出账号，先在 TokenFree 卡片中点击「退出」。

### Windows 和 Linux 呢？

当前验证聚焦 macOS。Windows、Linux 的支持状态将在完成验证后更新。

## 一起把门槛再降一点

欢迎通过 [Issues](https://github.com/yuezengwu/dsh-tokenfree/issues) 反馈你在学习和研究中的需求，或帮助完善文档、测试与兼容性。安装问题请同时提供 DSH 与插件版本。

反馈问题时，请使用不含账号凭据、私人文件或完整对话日志的最小复现。

## 致谢与许可

感谢 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供原生 Agent 与工具能力。

本项目采用 [MIT License](LICENSE)。第三方项目与服务保留各自的许可和使用条款。
