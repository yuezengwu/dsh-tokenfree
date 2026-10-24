# 发布流程

一个 npm 包，一份正式 tarball。发布由维护者明确发起；普通 push 和 CI 不自动发布，不把 DeepSeek 账号交给 CI。GitHub 与 npm 使用同一版本和同一份包。

## 1. 准备版本

从 main 修改 package.json 的版本、DSH engines 与对应 SDK，更新锁文件、README 安装说明和带日期的 CHANGELOG。0.x 新能力或不兼容状态变化升 minor，兼容修复升 patch；不重复使用已发布的版本。

执行 `pnpm install --frozen-lockfile`、`pnpm check`、`pnpm audit --prod --audit-level high`，审查公开文件、历史、实际 tgz 和第三方许可，确认没有凭据、真实 chat 标识或个人路径。浏览器夹具、真实验收与离线测试分别记录；未验收的能力在发行说明中写清楚。只有收到本次发布授权才移除 private，保持 registry 为官方 npm。

提交全部发行输入并推送 main，等待该 commit 的 CI 全部通过：Ubuntu Node 22/24、macOS Node 24。安全报告使用仓库的私密漏洞渠道。

## 2. 冻结一个包

以下以 0.2.0 为例，后续替换版本号：

```sh
git tag -a v0.2.0 -m 'Release 0.2.0'
pnpm release:prepare
```

脚本要求干净 main、本地标签、远程 main 和成功 CI 全部对应同一 SHA，再做生产依赖高危审计，然后构建、检查实际包，生成 `.local/releases/0.2.0/` 下的 tarball、SHA256SUMS、release.json 和 notes.md。它不发布；目录已存在时拒绝覆盖。先在项目外安装这个实际包，验证 CLI 与原生宿主挂载，不使用个人登录做安装探针。

## 3. 发布 npm

```sh
npm login --auth-type=web --registry=https://registry.npmjs.org/
npm whoami
npm owner ls dsh-tokenfree
npm publish .local/releases/0.2.0/dsh-tokenfree-0.2.0.tgz --ignore-scripts --access public --tag latest --registry=https://registry.npmjs.org/
```

确认登录用户有包权限，在官方页面完成所需验证。不把 npm token 写进仓库、日志或 CI secrets。首次采用维护者本机发布；将来如迁移到 [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)，另行明确配置仓库和工作流权限，不以本次发布授权自动添加。

如果 npm 返回 staged 审批，完成该版本审批后查询 registry；stage 成功不等于正式发布。网络结果不明时先查询版本与 integrity，匹配则继续后续步骤；不要重新打包或盲目重发。候选因检查失败需要修改时，先停止旧候选审批并将本地包移入独立归档，保留证据；在尚未发布该版本的前提下重新冻结 commit 和候选，不覆盖已有包。旧候选不得被批准。

## 4. 发布 GitHub

确认 npm 上 0.2.0 的 integrity 与 release.json 一致，再推送已经核对的标签并发布：

```sh
git push origin v0.2.0
gh release create v0.2.0 --repo yuezengwu/dsh-tokenfree --verify-tag --title 'TokenFree 0.2.0' --notes-file .local/releases/0.2.0/notes.md .local/releases/0.2.0/dsh-tokenfree-0.2.0.tgz .local/releases/0.2.0/SHA256SUMS .local/releases/0.2.0/release.json
```

维护者应按本次版本更新命令；首次源码公开会随 main 推送生效，不能把它与 npm 成功混为一谈。

## 5. 核对发行结果

从 registry 重新下载并对比 tarball 的 SHA-256 / integrity；从 GitHub Release 下载资产并核对相同字节。确认 npm latest、Git tag、release.json 的版本及 commit 对应；从 registry 在新目录安装，运行 CLI 帮助、客户端挂载及无真实账号的原生宿主探针。发布成功与真人功能验收仍是两层证据。

失败时保留原包与记录，补齐同一版本的缺失步骤。已发布版本不能覆盖；修复发新 patch，不移动标签、不自动 unpublish。需要撤回推荐时先 deprecate 问题版本并写明原因；如有旧的可用版本，可将 latest 指回它。首发没有旧可用版本时不能退回 0.0.0-stage 占位包。本地日志和账号状态不因回退而清理。
