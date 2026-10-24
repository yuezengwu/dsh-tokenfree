# 贡献与本地开发

当前首次发行版本为 0.2.0，网页适配器仍为实验性；目标设计见 [技术方案](TECHNICAL_DESIGN.md)，确认状态见 [规格汇总](SPEC_STATUS.md)。源码已按四组模块实现第一阶段；本地模拟通过与真实验收分开记录，见 [主链说明](MAIN_CHAIN.md)。

## 初始化

推荐 Node.js 24，仓库 `.node-version` 为 24；package.json 固定 pnpm 10.12.1。已安装其他版本时使用自己的版本管理器切换，不改系统全局 Node。

```sh
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm check
```

未安装 pnpm 时，可使用本机已有 Corepack 的 `corepack pnpm`，或按 [pnpm 安装说明](https://pnpm.io/installation) 安装指定版本。本项目不依赖相邻的 DSH 源码 checkout；开发依赖通过锁文件安装。

| 命令 | 内容 | 需要真实账号或 Chrome |
| --- | --- | --- |
| `pnpm check` | 仓库边界、先构建再检查类型、离线测试、实际 tgz 检查 | 否 |
| `pnpm test` | 构建后运行离线测试，跳过真实 Chrome 夹具 | 否 |
| `pnpm test:browser` | 临时专用 Chrome、持久登录资料、管道与零 TCP 监听；页面全部拦截 | 需要 Chrome，不需要账号 |
| `pnpm check:repo` | 私有产物边界、公开文档链接与个人路径检查 | 否 |
| `pnpm check:package` | 解包实际 npm tgz，核对入口、完整许可及本地文档链接，随后移除临时包 | 否 |
| `pnpm login` / `doctor` | 打开专用官方登录窗口 / 验证真实凭据 | 是，明确手动执行 |
| `pnpm smoke` / `smoke --tools` | 真实官网生成，会增加网页历史 | 是，明确手动执行 |

`pnpm demo` 还要求显式设置 `DSH_SOURCE_DIR`，仅供同版本源码联调；它不是日常开发或 CI 的依赖。不要在默认验证中运行 login、doctor、smoke 或 demo。

客户端使用构建时生成的 Remote 声明，干净 checkout 必须先构建；`pnpm check` 已按此排序。单独运行 typecheck 或 test:unit 前先执行 `pnpm build`。

发布文档按 package.json 的显式清单分发，包含文档引用的公开源码。新增相对链接时，目标必须随包提供；不能靠本机 checkout 中恰好存在的文件通过检查。客户端当前只打入 Zod 的第三方实现；变更该依赖版本须同步更新 THIRD_PARTY_NOTICES，增加其他打包依赖前须补齐其许可声明。

## 改动规则

- 分支从 main 建立，使用短主题名；小问题直接修复，产品范围变化先开 Issue 讨论。
- 一份 PR 解决一个问题，说明最终行为与实际验证。模拟通过、浏览器夹具通过、真人账号验收分别记录。
- 修改影响的行为补回归验证；不为文案或简单可逆改动新增形式化测试。
- 一个包，四组模块；复用 DSH 工具执行与压缩事务。不要新增共享服务、监听端口、账号池或收费后备。
- 固定模型、搜索关闭；usage 与主动压缩只使用官网 C/B。不要为通过测试而改成估算值。
- 合成最小复现可以提交；凭据、个人路径、真实 chat URL、原始日志、截图和浏览器配置不能提交。完整证据留在本机 research 或 .local。
- 更新 pnpm-lock.yaml 与依赖声明必须同一 PR；不使用 file/link 依赖或依赖工作区提升。

[公开仓库](https://github.com/yuezengwu/dsh-tokenfree)包含四组模块、测试与 CI。安全渠道状态见 [安全报告](SECURITY.md)，不填写不存在的邮箱。代码以现有 MIT 许可贡献，不额外要求 CLA。讨论对事、尊重贡献者，不提供响应时限承诺。

## CI 与发布

GitHub CI 在 Ubuntu Node 22/24 与 macOS Node 24 执行 `pnpm check`，不使用账号 secrets、不启动 Chrome、不发布包。它证明离线基础兼容，不等于支持 Linux 真实登录或已验收三端。

工作流只读仓库，Actions 固定提交；基于 [checkout](https://github.com/actions/checkout)、[setup-node](https://github.com/actions/setup-node) 与 [pnpm setup](https://github.com/pnpm/action-setup) 的公开用法配置。每次发行须核对同一提交的远程运行结果。

发布步骤见 [发布流程](RELEASING.md)，版本维护见 [开源维护策略](OPEN_SOURCE.md)，安全报告见 [SECURITY.md](SECURITY.md)。
