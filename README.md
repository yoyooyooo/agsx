# AGS companion

这是官方 Git／gh 的配套组件，不是另一套 GitHub CLI。进入哪个仓库，就让官方 gh 根据它的 origin 和已登录主机决定操作 GitHub 还是 AGS。组件不安装 gh/git shim，不代跑普通 PR／CI 命令，也不要求每次执行前设置目标变量。

当前为未发布的独立开发项目，暂用 `agsx` 作为附属命令名。现有团队 `ags-cli`、认证配置和服务不自动切换。

## 日常工作仍然这样进行

```bash
git push origin feature
gh pr create --fill
gh pr checks --watch
gh run view --log-failed
```

AGS 负责标准接口、业务权限和配置选择的 CI 后端。CI 可以是 native、none、Forgejo 或 GitHub Actions；不由本 CLI 决定，也不因 CI 切换而改变 Git 托管、PR 投影或合并权威。仓库含 backup/upstream 时，可用官方 `gh repo set-default origin` 明确一次协作目标。

本项目补充的只有：一次性 gh 主机配置、origin/认证诊断、任务启动时的运行身份、跨工具关联查询，以及可校验的单套安装。

## 开发

Node.js 22.18+ 是运行时，TypeScript ESM，Effect v4 beta 精确锁定。Bun **只安装依赖**。

```bash
bun install --frozen-lockfile
node scripts/task.mjs check
node scripts/task.mjs format-check
node dist/cli.js schema
```

当前没有远端发布，不要执行 npm publish。独立 bundle 位于 `.test-build/candidate/`，没有 vendored gh、Bun 运行时或历史版本目录；系统仍需 Node、官方 gh 和 Git。

## 一次性接入一个 AGS 主机

主机应提供 gh 能访问的 HTTPS API。Git remote 的 HTTP :6666 可以继续用于代码传输；gh 从 hostname 使用同主机的 HTTPS API。初始化凭据不是每次操作切换账号。

```bash
node dist/cli.js setup plan --input examples/setup.example.json
node dist/cli.js setup apply --input examples/setup.example.json --expected-plan <plan-digest> --apply
node dist/cli.js doctor --network
```

setup 先向目标 AGS 核验身份，再只更新官方 gh 的该主机配置，保留其他主机。它不写第二份 Context 注册表，不改 remote，不把 GitHub 账号凭据复制给 AGS。设置采用本组件锁与写前指纹检查；不能与另一个 gh auth 写配置操作并发执行。凭据文件 owner-only，目录必须 owner-controlled。

官方 gh 已经完成认证时，不必再执行 setup。凭据可以保留在 gh 支持的配置／系统凭据存储中，组件通过官方 `gh auth token --hostname` 读取明确主机的身份，不猜环境变量中的 token。

## Agent 任务启动接入

```bash
node dist/cli.js session start --input examples/session.example.json --apply
```

它签发一个继承现有原生账号的有界运行凭据，并生成任务私有 `GH_CONFIG_DIR` 和 `environment.json`。任务启动器在启动 Agent 进程时应用其中的 set/unset **一次**；PATH 和 gh/git 二进制都不改变。Git 使用标准 credential helper 扩展点，不经过 Git 命令代理。

普通 gh 的所有 API 请求使用同一个合法运行身份，不逐命令申请 grant。来源 Agent／Task／Run 是关联数据：未验证为 provisional，暂缺为 unlinked；不是权限。并发任务使用不同 session，不通过“Agent 最近的任务”猜关联。可选受信 source 验证由 AGS 完成，不能凭自报 metadata 换成另一个用户。

```bash
node dist/cli.js session show --directory /private/tasks/task-123/ags
node dist/cli.js association show --number 123
node dist/cli.js ci backend
node dist/cli.js session end --directory /private/tasks/task-123/ags --apply
```

初始化需要已建立的原生 AGS 身份。这里没有复活旧 mat-token → per-operation grant 的旁路，也不声称已经修改 Multica 的任务启动器。session 的初始 POST 结果未知时保留 request UUID；end 可用原账号撤销该 UUID，不重新创建任务凭据。令牌不会进入命令输出或环境清单。

## 验证与边界

- 默认测试使用临时文件、本地 HTTP/TLS、标准 Git 凭据协议和隔离的 Effect 服务。
- 两仓真实联调使用 server checkout 的 `scripts/gh-native-acceptance.mjs`、固定官方 gh 发行物以及 loopback-only netns；不继承生产凭据或数据。
- `docs/feature-parity.md` 记录普通功能交回 gh、标准缺口归服务端、grant 控制面和 shim 退役的理由。
- `docs/protocol.md` 区分认证、关联、CI 后端与合并权威；没有用关联完成度阻断正常协作。
- 实验源码、日志和会话凭据不得进入发行物。生产入口、正式发布和团队客户端切换由用户单独决定。
