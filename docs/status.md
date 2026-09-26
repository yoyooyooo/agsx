# 开发阶段状态

## 已实现

这是官方 Git/gh 的独立配套组件，保留 12 个附属入口，不再保留此前的 50 命令替代客户端。普通 repo/pr/run、Git 代理、grant 控制面、独立 Context registry、operator 平台与 git-shim 源码已经移除；归属见 feature-parity.md。

实现了：单主机官方 gh 配置计划/核验/更新、origin 与覆盖变量诊断、任务边界运行身份、一次性环境清单、标准 URL-scoped Git credential helper、PR 运行/provider 关联查询、服务器 CI 选择查询，以及可验证的单槽安装。现有团队客户端和个人凭据没有被替换。

Effect v4 beta 的服务/层/Schema 与 Node 资源边界保留；Bun 只安装。包是独立 Node bundle，不带 gh 二进制、Bun 运行时或历史安装目录。当前仍 private、禁止自动发布，没有新公共远端。

## 验证入口

- `node scripts/task.mjs check`：类型、构建、边界检查，以及本地协议/HTTP/TLS/进程/凭据/helper/单槽安装测试。
- `node scripts/task.mjs format-check`：统一格式。
- `node scripts/compat.mjs --server-checkout <explicit-fork>`：构建候选与所选 Fork 的联合验证。Fork 脚本使用固定官方 gh，所有服务在 loopback-only namespace。
- 机器可读联合结果由所选 server checkout 的 `.test-build/gh-native.json` 拥有；source commit、dirty 状态和 companion source 以当次实际构建回执为准，不把旧 SHA 当永久基线。

联合流程已实际走过 setup → task environment → 系统 Git push → 官方 gh PR create → 关联查询 → 撤销。它还检查原版 gh 的双 CI backend 读取、日志、namespace ID 隔离和标准 expected-head 合并。GitHub/provider 服务在该流程中是符合真实 API 形状的隔离 fixture，不是生产任务。

## 不冒充已经完成的工作

- 没有发布、注册新包名、创建公共远端或迁移现有团队客户端。
- 没有修改 mini/imile/CCS 的 HTTPS/证书、tailnet 或生产 CI 配置。
- 没有改造真实 Multica 任务启动器；任务环境需要预先建立原生 AGS Agent 身份，不会回退到 Human/管理员或旧 per-command grant。
- 无后台自动续期；任务启动器负责选择 TTL、应用一次环境清单并结束会话。
- 官方 gh 完整平台兼容、所有 provider API、操作系统 keyring 沙箱隔离均不在此声明范围。
- 源码有 CI workflow 不代表新仓库的远端 CI 已运行。发布与线上切换仍需明确授权及目标环境验收。
