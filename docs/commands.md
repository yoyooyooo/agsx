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
│   └── show       查询一个 AGS PR 的 run 与 provider 关联
├── ci
│   └── backend    查询服务器选择的 CI 后端，不代理检查/日志命令
└── package
    ├── inspect
    ├── verify
    └── install    显式目录、单套安装，不接管 npm 或当前团队客户端
```

普通 `repo/pr/run` 操作、检查与日志、Git push 不在这个命令树里：用官方 gh / Git。没有 grant 命令，没有自动生成的 git/gh shim，没有失败时改走另一条写入路径。

## 状态与 I/O

默认输出 `agsx.result.v1` JSON。附属写入需要 `--apply`；它不改变原版 gh 的执行语义。session.start 未 apply 时不读取凭据或创建会话目录。setup.plan 是显式本地配置/凭据观察，返回摘要不含凭据值；doctor 默认不联网，network 才调用原版 gh 查看仓库。

`--gh` 可明确选择已安装官方 gh 的绝对路径；`--gh-config` 选择官方配置目录；`--ca-file` 只增加明确的证书信任，不关闭 TLS 校验。host 使用 hostname，不带协议或端口；普通 HTTPS API 地址由该 hostname 产生，远端返回的展示 URL 不能改认证目标。

没有 Context 的第二份全局默认配置。主机登录归官方 gh；source/repo 选择不会从旧 ~/.ags-cli、Agent Kit registry 或私有部署 manifest 猜测。

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
