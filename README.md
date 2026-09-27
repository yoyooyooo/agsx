# agsx

官方 Git／gh 的配套组件，不是第二套 GitHub CLI。普通 repo、PR、CI 操作仍使用官方 `git` 和 `gh`；agsx 只负责一次性 AGS 接入、诊断、任务运行身份及跨工具关联。没有 gh/git shim，没有内置安装器、版本切换、自更新或发布命令。

## 安装与升级

```bash
npm install -g @yoyooyoooyoooo/agsx
agsx --version
agsx schema
```

需要固定版本时使用 `npm install -g @yoyooyoooyoooo/agsx@0.2.0`。再次安装其他版本也是 npm 的职责。需 Node.js 22.18+、Git 和官方 gh；独立 API hostname 的 `api_host` 设置要求 gh 2.100+。安装软件不会自动更换账号、修改 remote 或升级 AGS 服务端。

## 日常工作

```bash
git push origin HEAD
pr_url="$(gh pr create --base main --title '本次修改' --body '修改说明')" &&
  agsx association collect --url "$pr_url" --wait-seconds 5
gh pr checks
gh run list
```

原版 gh 创建真正的 AGS PR，收集器只读关联；投影未完成时返回 pending，不猜 Forgejo 编号，不因读取失败重开 PR。AGS 与 Forgejo 地址各自保留。GitHub 项目仍正常使用同一个官方 gh。

## 接入与诊断

```bash
agsx setup plan --host ags.example.test --token-file /private/ags.token
# 根据 plan 的 expectedPlan 执行明确的 setup apply。
agsx doctor --network
agsx association show --number 123
agsx ci backend
```

使用默认 gh 配置，不需要常驻 GH_HOST、GH_REPO、GH_CONFIG_DIR 或 AGSX_GH。仅并发任务的会话边界可显式使用任务私有配置，避免账号互相覆盖；日常个人登录不需要隔离 shell。Fork／多 remote 仓库通过官方 `gh repo set-default origin` 明确默认协作目标。

更多输入以 `agsx schema --command <command>` 为准；见 [命令](docs/commands.md)、[协议](docs/protocol.md) 和 [架构](docs/architecture.md)。

## 开发与 npm 发布

```bash
bun install --frozen-lockfile
npm test
npm run build
npm publish .test-build/candidate --access public
```

Bun 只安装开发依赖，版本锁在 catalog／bun.lock；编译、测试、构建与运行使用 Node。根工作区有 catalog 开发依赖且保留 private，发布的是不带开发依赖的独立 npm 包。固定构建目录只是可再生成的开发输出，不是运行安装路径。普通 npm 负责打包、registry 发布和全局安装，不另设 release 管理层。

维护者先提交源码再构建发布；build-manifest 只记录来源与构建信息，不是额外的客户端安装协议。发行包不包含个人配置、token、测试工作树、数据库或官方 gh 二进制。具体版本是否已发布以 npm registry 为准。
