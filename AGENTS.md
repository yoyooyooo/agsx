# AGS companion

这是独立的 Git/gh 配套组件，不是另一套 GitHub CLI。普通 repo/pr/run/CI 操作交给未经修改的官方 gh 和系统 Git；不得生成 gh/git shim、拦截业务命令或每次重写 GH_HOST/GH_REPO。现有团队客户端、凭据和生产部署不在本仓默认修改范围。

## 核心边界

- Node.js 22.18+ / TypeScript ESM；Effect v4 beta、Schema、Context、Layer 管理 I/O 边界。Bun 只负责 install，精确 catalog 与 bun.lock 是依赖权威。
- 标准协议和 CI 后端由 AGS 拥有。CI 选择与 Git 托管、PR 投影、合并权威分开；CLI 不默认 Forgejo、不读取 provider 密钥。
- 组件只做一次性 gh 主机接入、origin/认证诊断、任务启动时的运行身份配置和关联查询；安装、升级、发布交给 npm。没有普通 PR/CI 命令的复制，也没有 gh 失败后走另一条写入路径的自动重试。
- 运行身份继承真实原生账号；关联字段不是身份授权。关联可以 provisional/unlinked/conflict，不能因此阻断已授权的日常协作。元数据不允许选择另一个 principal 或添加仓库权限。
- setup 可显式更新官方 gh 的一个主机配置；保留其他主机和设置，先验证凭据，再以旧配置指纹 CAS 写入。普通命令不读取旧 ~/.ags-cli、不创建第二份 Context 注册表。
- session 在任务边界生成独立 GH_CONFIG_DIR 和标准 Git credential-helper 配置，不改变 PATH，也不污染并发任务。任何 parent/source/session token 不得出现在命令行、stdout、证据或普通日志中。
- HTTP/进程/文件有超时、容量、取消与资源释放。未知写结果不自动重发。凭据文件 owner-only，不跟随符号链接；配置里的 API 目标不能由远端返回 URL 改写。
- 测试默认隔离、无生产凭据。真实官方 gh 联调用 loopback-only netns 和一次性 AGS 数据；没有远端 CI 就不能声称远端验证完成。
- npm 包名为 `@yoyooyoooyoooo/agsx`。维护者使用普通 npm 发布流程，CLI 不实现发布、安装、版本切换或自更新。不得覆盖旧 ags-cli；生产服务切换须独立验收。

## 开发

`bun install --frozen-lockfile`；`node scripts/task.mjs check`；`node scripts/task.mjs format-check`。
`node dist/cli.js schema` 查看附属能力。`docs/feature-parity.md` 记录旧能力交回官方、归服务端或退役的理由，不以命令数量计完成度。
