# agsx

[English](./README.md) | [中文](./README.zh-CN.md)

官方 Git 和 gh 的配套组件，不是第二套 GitHub CLI。普通 repo、PR、CI 操作仍使用官方 `git` 和 `gh`。agsx 只负责一次性 AGS 接入、诊断、任务运行身份，以及跨工具关联。

```bash
npm install -g @yoyooyoooyoooo/agsx
agsx --version
agsx schema
```

需要 Node.js 22.18 或更新版本、Git，以及官方 gh。

## 解决的问题

`git` 和 `gh` 已经能创建仓库、PR 和 CI。AGS 主机还缺三件事：在官方 gh 里做一次主机接入，给任务准备一份不覆盖日常登录的身份，以及在 `gh pr create` 之后只读地取回 Forgejo 链接。如果为此再包一层 gh，就会长出第二套 PR 命令和第二套凭据。

## 主要能力

- `setup plan` 只展示主机变更。`setup apply` 先核验原生账号，再写入官方 gh 的一个 host。
- `doctor` 查看 origin、gh 配置和覆盖变量。不加 `--network` 时不联网。
- `session start` 在任务启动时准备一次运行身份。`session end` 撤销这份运行凭据。
- `association collect` 读取 gh 已经创建的 PR 的 AGS 和 Forgejo 链接。
- `ci backend` 查看服务器选择的 CI 后端，不代理检查或日志。

没有 PR、CI、安装、升级或自更新命令，也没有 gh/git shim。

## 工作原理

npm 上的包是一个打包好的 Node 程序。仓库根目录是 private 的 Bun 开发工作区，npm 不会安装它。

agsx 调用你机器上的官方 `gh`。setup 只改 gh 配置里的一个 host，其他 host 保持不动。任务会话使用自己的 `GH_CONFIG_DIR` 和标准 Git credential helper，不改 `PATH`。association 只对已经存在的 PR 发 GET。投影还在 pending 时就返回 pending，不会再执行一次 `gh pr create`。

## 安装

```bash
npm install -g @yoyooyoooyoooo/agsx
```

固定版本用 `npm install -g @yoyooyoooyoooo/agsx@0.2.0`。升级和卸载都是 npm 的事。安装软件不会切换账号、修改 remote，也不会升级 AGS 服务端。

独立 API hostname 的 `api_host` 需要官方 gh 2.100 或更新版本。这个设置不是安全边界。

## 快速开始

在 `origin` 指向要接入的主机的仓库里：

```bash
agsx setup plan --host ags.example.test --token-file /private/ags.token
agsx doctor
agsx schema
```

`setup plan` 不写配置。只有在核对过刚才的 plan 之后才执行 apply。`agsx schema` 以 JSON 打印命令列表。

PR 仍由 gh 创建，然后再收集两条地址：

```bash
git push origin HEAD
pr_url="$(gh pr create --base main --title '本次修改' --body '修改说明')" &&
  agsx association collect --url "$pr_url" --wait-seconds 5
```

`&&` 要保留。gh 失败时收集器不运行。投影未完成时返回 pending，不猜 Forgejo 编号，也不重开 PR。

命令说明见 [docs/commands.md](docs/commands.md)，协议见 [docs/protocol.md](docs/protocol.md)。

## 安全与限制

凭据留在官方 gh。agsx 不把 `GH_TOKEN` 当作后备，也不跟着展示 URL 改去另一台主机。任务目录只属于该任务。这不是操作系统沙箱。见 [SECURITY.md](SECURITY.md)。

agsx 不管理全局 npm，不替换 `git` 或 `gh`，也不保留历史安装目录。`0.2.0` 由维护者本机发布，没有 npm provenance。之后的版本由 `.github/workflows/publish.yml` 在 tag 上发布。

## 开发

```bash
bun install --frozen-lockfile
npm test
npm run format:check
```

Bun 只安装锁住的开发依赖。Node 运行测试和 CLI。下一次 npm 发布是 annotated tag，不是本机 `npm publish`。见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

Apache-2.0。见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。
