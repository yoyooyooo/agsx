# 能力重建与去耦合账本

## 基线与口径

本轮按旧客户端的实际入口、注册表、发行机制及其活跃运维入口盘点，来源固定为 Agent Kit 提交 `aafe2e3bf3cacc0a2f711592070a456159f3766d`。原工作区、发行包和团队配置均未修改。

不是将整个旧源码目录或历史命令壳搬入新仓库。旧 `ci/review/profile/grant/session/access/agent/...` 中已被旧产品明确撤销的顶层别名，不能因为文件还存在就重新宣布支持。新命令不追求逐 flag 兼容，追求实际操作能力、授权和结果语义。

状态定义：**已重建**表示有可执行实现与隔离验证；**接口限制**表示当前服务端不能安全提供该语义，客户端明确拒绝而非伪造完成；**外置/撤销机制**表示业务能力换了归属，不再保留旧的实现手段。任何状态都不代表已切换生产环境。

## 日常交付

| 旧能力                                           | 新入口 / 所有者                                    | 状态和验证                                                                                                                                                                                   |
| ------------------------------------------------ | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原生 Git 启动、仓库作用域凭据                    | `git.run`；`git.bootstrap` 的显式会话 shim         | 已重建。真实 smart HTTP clone/commit/push/fetch、准确 Host/repo helper、旧 helper 隔离、写入不重放测试；真实 AGS 复验。                                                                      |
| PR create / fill / draft / body-file             | `pr.create`                                        | 已重建。远端 head 读回、明确 base、未知响应只查询；模拟与真实 AGS。                                                                                                                          |
| PR view / comments / JSON fields                 | `pr.view`，全局 `fields`                           | 已重建。原生 REST；结构化投影信息和纯展示 URL 重写。                                                                                                                                         |
| PR list / status / author/base/head/draft/labels | `pr.list`、`pr.status`                             | 已重建。原生 REST、有界分页；status 明确 createdByMe/other，不伪造审核责任。                                                                                                                 |
| comment / edit / review                          | `pr.comment`、`pr.edit`、`pr.review`、`pr.reviews` | 已重建。一次写请求、受限正文、head 预检、review commit 绑定；真实 AGS 生命周期通过。                                                                                                         |
| close / reopen                                   | `pr.close`、`pr.reopen`                            | 已重建。修改 AGS 状态，不隐式删除 Git 分支。                                                                                                                                                 |
| update-branch（合并 base）                       | `pr.update-branch`                                 | 已重建。原生 PUT 携带 `expected_head_sha`，不是构造未知字段。                                                                                                                                |
| update-branch --rebase                           | `pr.update-branch --rebase`                        | 已重建。隔离 clone、重新读取当前 base branch（不使用历史 PR base SHA）、本地 rebase、准确 force-with-lease、AGS receive-pack 原有权限。真实 AGS 验证了 base 前进后的成功重建。冲突时不推送。 |
| Human/service provider merge                     | `pr.merge`                                         | 已重建。精确唯一 provider mapping、expected head、服务器拥有的 merge endpoint。客户端不重复实现审查/CI门禁。                                                                                 |
| Multica maintainer merge                         | `pr.merge --identity workload`                     | 已重建。grant effect + invocation，不通过普通 transport session；隔离协议及错误绑定测试。                                                                                                    |
| 纯 AGS、无 provider 的安全 merge                 | `pr.merge` 明确返回能力缺口                        | **接口限制**。当前原生 merge 不接受原子 expected-head；不能从安全 provider 路径降级绕过。真实无 provider 服务上验证返回 unsupported。                                                        |
| pr checks / watch / required / fail-fast         | `ci.checks`                                        | 已重建。exact-head/actor/provider receipt、有界等待、明确 pending/fail；缺 required facts 时报告 unsupported。                                                                               |
| run list / view / logs / failed-only             | `run.list/view/logs`                               | 已重建。必须绑定 AGS PR 和 exact-head run，日志也验证认证回执；未调用 provider 直连。                                                                                                        |
| gh 兼容包装、任意 jq/template                    | 命令 schema、结构化 `fields`                       | 操作能力已迁移；**旧解析器和表达式执行撤销**。不再携带整个定制 gh 引擎，不继续宣称任意 gh flag 兼容。                                                                                        |

## 身份、配置和自动化

| 旧能力 / 问题                           | 新入口                                                                | 状态                                                                                                                                        |
| --------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| origin → 唯一 Context → Human token     | `context.*`、`auth.*`                                                 | 已重建。严格 endpoint/alias；命名环境变量或 owner-only 文件，不读取 GitHub/provider/legacy profile。                                        |
| Context 导入、迁移、默认选择、doctor    | `context.add/import/export/use/show/doctor`                           | 已重建。单版本 JSON、配置 hash compare-and-set、无需 Multica。网络诊断可选，缺少 server instance ID 不声称身份已认证。                      |
| 新机器 bootstrap、git helper、PATH 环境 | `git.bootstrap`                                                       | 已重建。只生成新 home 下的 shim；不修改全局 Git config/PATH，不替换系统 gh。                                                                |
| 个人团队安装 manifest                   | 显式 config/preset → `context.import`、`auth.import`、`git.bootstrap` | 配置能力保留。**个人机器/workspace/允许名单默认值不复制**；组织可提供自己的显式 preset。                                                    |
| 原生无人值守服务账号                    | `auth.kind=service`                                                   | 已重建。真实 `/user` kind 检查，不冒充 Human、也不伪造 Multica Task。                                                                       |
| Multica 源 token 交换                   | 可选 workload adapter                                                 | 已重建。独立 issuerInstanceId / endpoint / workspace allowlist，源 token 只交给选定 AGS，不直连 Multica。                                   |
| Access Grant 申请/当前/续期/撤销        | `grant.issue/status/renew/revoke`                                     | 已重建。严格 receipt 归属、有界敏感缓存、线上 current 校验、撤销后移除本地缓存。                                                            |
| request-level transport Session         | Identity 层，隐藏内部对象                                             | 已重建。字符串约束、exact executor、目标/repo/operation/authority revision/provenance 全部与父 grant 核对。                                 |
| effect unknown / invocation readback    | `invocation.list/show/reconcile`                                      | 已重建。未知意图不被 GC，重复 ID 不重放；不能证明的 comment/review/push 保留 unknown。原生 desired state 被观察到不等于证明由本客户端造成。 |
| 一次性 Human profile 迁移 fallback      | 新 `auth.import` / config import                                      | **长期 fallback 撤销**。不扫描旧 profile、不创建兼容路径；真正切换旧用户时需单独、明确迁移。                                                |
| auth login/status/logout                | `auth.device-start/device-finish/status/logout`                       | 新增明确设备流。只使用 AGS OAuth；有界等待、凭据不进 stdout；隔离服务协议测试。                                                             |

## 运维能力与私有依赖

| 旧能力                                                       | 新归属                                                  | 状态                                                                                               |
| ------------------------------------------------------------ | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `ctl repo onboard-forgejo`：仓库、保护、hook、label          | `ops.plan/verify/apply` + 明确 manifest                 | 已重建。只使用 provider 正常 API，精确 plan hash；保留未声明的审查/CI设置，不默认启用 force-push。 |
| 主站 repo mapping 读写                                       | ops 的显式 `runtime.root`                               | 已重建。只读取 `config/integrations.yaml`，保留无关字段，hash CAS。普通调用完全不读取此目录。      |
| GitLab mapping / 默认分支                                    | ops 的可选 GitLab 配置                                  | 已重建。只接受已有准确 project identity，使用 API 与独立凭据。不是 GitLab 自建安装平台。           |
| 显式 systemd/launchd 重启                                    | ops runtime restart                                     | 已重建、argv-only。未对生产执行；跨系统实际服务管理尚未实机验收。                                  |
| 多机 `.ak` registry、私有 ssh-exec-sync 脚本                 | 部署/自动化仓库；远端运行同一新 CLI                     | **外置**。不将主机编排、SSH账户或私有脚本路径塞回客户端。                                          |
| Docker 内生成 provider admin token、直接删 provider DB token | 无替代后门；明确引用已有 operator 凭据                  | **撤销不安全机制**。拥有 provider API 操作能力，不拥有绕过服务端账户治理的数据库入口。             |
| 写 AGS bare repo、provider hook 回推磁盘                     | 原生 AGS Git/API                                        | **撤销绕过机制**。无需复制已在运行体系中清掉的后门。                                               |
| 自动整库备份、日期部署目录、全局 no_proxy 修改               | 服务维护任务与明确备份政策                              | **外置**。客户端不复制主站数据库，也不改变全局网络设置。                                           |
| Multica 项目资源/小队/工作流编排                             | 团队工作流资产或 Multica API 所有者                     | **外置**。保留真正参与 Git/PR 身份的 adapter，不复活旧 CLI 已撤销的完整 Multica 控制面。           |
| provider 操作完成后的投影/ready                              | `ops.verify`、`repo.verify`、`context.doctor --network` | 独立观察，不把配置修改完成称作投影、权限和生产验收全部完成。                                       |

## 构建、分发和安装

| 旧机制                               | 新机制                                            | 结果                                                                           |
| ------------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------ |
| Bun runtime + TypeScript bundle      | Node ESM + Effect，Bun only install               | Node22.18+；所有运行/构建/测试都经 Node。                                      |
| 双平台 gh 二进制约100 MB             | 原生 REST + 系统 Git                              | 无旧 engine；当前独立候选包约1 MB，实际大小由构建回执记录。                    |
| registry/engine/wrapper 三层 hash    | package manifest + 文件hash +来源 + exact catalog | 本地字节可验证；没有把 hash 自校验冒充签名/可信发布者认证。                    |
| npm + 内置 releases/current/previous | 一个显式前缀、一个当前候选                        | 单槽替换；候选验证、未知安装中断标记、精确恢复；无永久版本目录。               |
| 自动 npm publish / install-latest    | 无，当前 private+发布守卫                         | **正式发行暂不实施**。包名、大版本、签名、registry发布和团队迁移等待独立决定。 |
| 旧版本回滚菜单                       | 安装明确验证的目标候选                            | 没有失去选择字节的能力，但不保存历史版本树或提供旧配置兼容。                   |

## 验证层级

`node scripts/task.mjs check`：类型、目录/依赖边界、构建、真实子进程/Git/HTTP/TLS/安装，以及本地协议服务测试。默认离线，不需要 AGS 部署。

`node scripts/compat.mjs`：额外下载固定公开 AGS Release；核验 archive/manifest/executable 后，在全新 user+network namespace、只有 loopback 的环境中创建一次性 SQLite/Git 数据，运行真实客户端旅程并清理。不是生产环境测试，也不会访问现有部署凭据。

发布前仍需要针对实际部署组合的受控 provider、工作负载身份、目标平台、服务管理、签名/分发及用户迁移验收。该边界不能用“所有本地测试通过”抹掉。
