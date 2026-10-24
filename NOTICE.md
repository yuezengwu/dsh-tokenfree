# 来源与第三方说明

- 本项目代码按 [MIT](LICENSE) 许可，名称为社区项目标识，与 DeepSeek 官方产品没有隶属或背书关系。
- DSH 集成使用 `@deepseek-ai/*` 公开包；React、Playwright、Zod 和其他依赖保留各自许可。本项目 MIT 声明不改变第三方许可。客户端中包含的 Zod 完整许可及版权见[第三方许可声明](THIRD_PARTY_NOTICES.md)，同样保留在客户端产物中。
- 网页协议来自官网公开前端的观察与本地验证，参见 [接口参考](WEB_API_REFERENCE.md)。它不是官方承诺稳定的开放 API。
- 早期协议参考过 [sums001/Deepseek-API](https://github.com/sums001/Deepseek-API)；本仓库维护自己的适配实现，不将其他项目的许可自动改为 MIT。
- PoW 使用官网前端加载的 WASM：首次使用从代码中固定的 HTTPS 来源下载并校验 SHA-256，缓存留在本机。WASM 与官网 JavaScript 不随 Git 或 npm 包分发；资源许可不由本项目 MIT 覆盖。

来源记录不等于已完成所有依赖的许可审查。每次发布应核对实际锁文件、构建包及需要保留的第三方声明；未核实的资源不新增到分发包。
