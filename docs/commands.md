# 附属命令，而不是第二套 gh

`node dist/cli.js schema` 是输入契约。`setup plan` 与 `setup.plan` 等价，结构输入用 `--input file.json` 或 `--input -`；未知字段和重复参数在凭据读取前拒绝。

```text
agsx
├── schema
├── setup
│   ├── plan       查看目标主机配置与导入计划，不写入
│   └── apply      核验原生身份，更新官方 gh 的一个 host
├── doctor         查看 origin、gh 配置、覆盖变量及可选真实访问
├── session
│   ├── start      在任务启动边界准备一次运行身份与环境
│   ├── show       查看所属身份、关联质量和环境文件位置
│   └── end        撤销这个运行凭据，清理其确切本地凭据文件
├── association
│   ├── show       查询一个 AGS PR 的 run 与 provider 关联
│   └── collect    收集已创建 PR 的 AGS／Forgejo 链接；只读，可限时等待
├── ci
│   └── backend    查询服务器选择的 CI 后端，不代理检查/日志命令
└── --version      当前 npm 包版本
```

普通 `repo/pr/run` 操作、检查与日志、Git push 不在这个命令树里：用官方 gh / Git。没有 grant 命令，没有自动生成的 git/gh shim，没有失败时改走另一条写入路径。

## 安装、升级与发布

使用 `npm install -g @yoyooyoooyoooo/agsx`，或加 `@<version>` 选择明确版本。升级仍然使用 npm；agsx 没有 package/install/upgrade/release 命令，没有自更新、版本切换或候选目录管理。

维护者在干净源码执行 `bun install --frozen-lockfile`、`npm test`、`npm run build`，然后 `npm publish .test-build/candidate --access public`。固定构建目录只是开发输出，不是机器运行目录；npm 负责安装布局与完整性。根目录保留 Bun catalog 的开发依赖，不发布根工作区。

## 状态与 I/O

默认输出 `agsx.result.v1` JSON。附属写入需要 `--apply`；它不改变原版 gh 的执行语义。session.start 未 apply 时不读取凭据或创建会话目录。setup.plan 是显式本地配置/凭据观察，返回摘要不含凭据值；doctor 默认不联网，network 才调用原版 gh 查看仓库。

`--gh` 可明确选择已安装官方 gh 的绝对路径；也可在试用 shell 或任务启动时一次性设置 `AGSX_GH`，优先级为 `--gh`、`AGSX_GH`、已知系统路径。它只选择可执行文件，不选择仓库或认证目标；显式路径不可用时不静默回退。`--gh-config` 选择官方配置目录；`--ca-file` 只增加明确的证书信任，不关闭 TLS 校验。host 使用 hostname，不带协议或端口；默认 HTTPS API 地址由该 hostname 产生。setup 的 `--api-host` 可显式指定受信任的独立 API hostname，保存在官方 gh 配置中，要求 gh 2.100+；后续 session 和关联查询复用这份配置，原主机仍拥有认证身份。它不是安全边界，不会阻止 gh 访问原主机。远端返回的展示 URL 不能改认证目标。

独立 API 网关还需要服务器显式设置 `AGS_API_BASE_URL`，使 jobs、logs、分页等机器跟随的 API 链接指向网关，而不是把 HTTP Git 端口强改成 HTTPS。Git remote 和回调的原 `BASE_URL` 不必变化。

没有 Context 的第二份全局默认配置。主机登录归官方 gh；source/repo 选择不会从旧 ~/.ags-cli、Agent Kit registry 或私有部署 manifest 猜测。

## 创建后一次收集两条地址

原版 `gh pr create` 只打印一个原生 PR URL，不会自动显示扩展字段。需要在同一次 Agent shell 调用里得到 Forgejo 地址时，用显式的只读收集器：

```bash
pr_url="$(gh pr create --base main --title 'A change' --body 'Description')" &&
  agsx association collect --url "$pr_url" --wait-seconds 5
```

`&&` 保留创建成功与后续读取的边界；gh 失败就不运行收集器。不要改成忽略前一条命令状态，也不要因 Forgejo 未就绪重跑整段创建。

收集器不执行 `gh pr create`，不解析或接管其业务参数，不写配置，不调用 Forgejo API。它只用 origin 与官方 gh 配置解析确定的 AGS API，在这个 API 上读取同一个原生 PR。输入 URL 只用于匹配 host/repository/number，不会被当作携带凭据的网络地址；短名与 FQDN 必须已在 gh 配置中指向同一个 API 才作为别名接受。

输出沿用 JSON envelope，`data` 为 `agsx.pr-links.v1`，其中：

- `ags`：原 URL、编号、仓库，以及本次读取是否核实成功；它不是“收集器创建了 PR”的声明。
- `forgejo`：记录的外部编号／地址与 `projected | pending | not_observed | failed | unavailable | conflict`；只有真实保存的映射才能提供地址。已知地址但 head 尚未同步时返回地址和 `currentHead: false`，不冒充当前提交已投影。
- `readOnly: true`、`retryCreation: false`：可重做关联查询，不应重做创建。

默认等待 5 秒，范围 0–30 秒；0 表示只读一次（该次请求最长 5 秒）。等待预算从身份解析完成后开始，单次请求及整体轮询都受限。仅对 pending／尚未观察到映射继续 GET；认证失败、错误响应或未知状态不自动重试。取消时释放在途读取。没有映射也没有 job 不能证明 Forgejo 被禁用，因此标为 `not_observed`，不猜 `disabled`。

有效 URL 已绑定当前仓库之后，投影查询失败仍返回原 URL 与分类状态，不将它变成“创建失败”。输入错误、目标冲突和命令取消则保持非零退出码。所有情况下都没有 POST 重放。这里省的是 Agent 的额外决策轮次，不承诺省去服务端异步投影所需的内部 GET。

该能力包含于 0.2.0 源码。发布状态以 npm registry 为准，旧的已安装版本不会自动获得新命令。

## 会话环境

session 目录必须为空或尚未存在。只有此组件创建的确切文件会被移除；不会递归清空用户提供目录，也不会覆盖已存在 session。

生成：

```text
session.json         身份与关联摘要、生命周期、凭据摘要（无明文 token）
environment.json     任务启动时应用一次的 set/unset；没有原始凭据
 gh/hosts.yml        仅这个任务的 AGS host 与运行 token，0600
 gh/config.yml       非交互配置
```

`GH_CONFIG_DIR` 隔离并发任务，`GIT_CONFIG_*` 仅指定标准 URL-scoped credential helper。环境清单不会改 PATH 或包含 GH_HOST/GH_REPO；需要取消父环境中那些会覆盖自动选路的变量。它不自动继承个人 GitHub 令牌。若任务确实需要多个服务的身份，应由任务启动器显式配置，而不是静默共享个人账户。

`association.show` 和 `ci.backend` 是 AGS 附属查询，目前要求 canonical origin；普通 gh 自己仍处理其完整 SSH alias/default-remote 行为。辅助查询不会因远端 HTML URL 指向另一主机就搬运凭据。
