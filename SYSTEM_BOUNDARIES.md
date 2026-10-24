# TokenFree 职责与模块索引

2026-10-23。架构决定合并进 [技术方案](TECHNICAL_DESIGN.md)，本文只作导航，不再并行维护第二份架构规范。实现与未完成修复分别见 [规格状态](SPEC_STATUS.md)。

| 内容 | 唯一技术定义 |
| --- | --- |
| 上游 DSH、下游 DeepSeek Web 与能力归属 | [一个包，四组模块](TECHNICAL_DESIGN.md#1-一个包四组模块) |
| 原生启用、默认模型和分叉 | [P1-1：直接复用公开接口](TECHNICAL_DESIGN.md#2-p1-1原生启用默认模型与分叉)；用户已接受更新全局默认 |
| 状态权威来源、最少文件、锁和提交次序 | [一套操作流程与最少状态](TECHNICAL_DESIGN.md#3-一套操作流程与最少状态) |
| 停止、取消缺 replayState、修正父消息 | [P1-2：上下文归属](TECHNICAL_DESIGN.md#4-p1-2正文停止与修正的上下文归属) |
| 官网原生封装、工具、压缩、usage 与日志 | [功能接入](TECHNICAL_DESIGN.md#5-多轮工具压缩与计量) |
| 内置压缩与启用边界、DSH 继承职责 | [压缩接入边界](TECHNICAL_DESIGN.md#压缩接入边界)；随主插件成套接入，不单独配置 |
| 卡片最少状态 | [账号、DSH 与官网用量](TECHNICAL_DESIGN.md#卡片的最少状态)；内部阶段不外露为配置状态 |
| 开源发布与组合验收 | [发布与验收](TECHNICAL_DESIGN.md#6-发布与验收) |

产品范围和用户已确认的决定见 [规格汇总](SPEC_STATUS.md)，官网接口事实见 [接口参考](WEB_API_REFERENCE.md)。原职责表已并入主方案：DSH 保留 Agent、工具执行、历史和压缩事务；TokenFree 只做协议、策略与网页状态适配。
