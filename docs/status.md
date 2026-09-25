# 重建阶段交付状态

这是新项目的开发基线，不是正式发行、生产替换或向外部用户开放的决定。

## 已落地

- 独立单包 TypeScript/Node 项目；Effect v4 beta.107 与 Node 平台包精确锁定，Bun 只安装依赖。
- 50 个可发现命令，来自同一份 Effect Schema；默认 JSON、严格输入、明确状态/退出码和写入执行边界。
- 原生 AGS/Git 客户端、Human/service/可选 Multica 身份、exact-head provider merge、CI/run、未知结果记录与查询。
- 显式 operator manifest 取代 `.ak` 发现和个人部署默认；普通调用不读取 provider 凭据或主站文件系统。
- Node 独立 bundle、第三方许可、完整文件/来源 manifest、单槽安装与中断恢复。没有旧 gh 引擎、历史版本集合或自动发布。
- 配置只有 `agsx.config.v1`，没有旧 profile/path/instance 默认回退。原工具和现有配置未改动。

## 本地验证

`node scripts/task.mjs check` 当前包含 41 个 Node tests，覆盖真实 HTTP/TLS/CONNECT、子进程终止、smart HTTP Git、凭据隔离、未知请求、原生服务账号、委派协议、device flow、operator 配置以及独立包的重复安装/升级/中断。

`node scripts/task.mjs format-check`、严格 TypeScript、精确 catalog/安装版本对账和架构边界检查通过。发布守卫被实际执行并拒绝。

额外的 `node scripts/compat.mjs` 对固定公开 AGS `fork-20260924.3` / `91a5cd7ff299950e94e8dbbbce7750512d9878be` 运行过完整无 provider 主站旅程：新 Context、身份、建仓、Git/PR 操作、无 provider 的明确能力缺口，以及 base 前进后的真实 rebase/lease/object 检查。该程序与数据始终处于一次性 user+network namespace，只有 loopback，完成后清理。最新机器可读回执在 `.test-build/compatibility.json`，不将生产数据或完整现场日志写入源码。

## 未宣称完成

- 没有创建远端仓库、公开源码、打发布 tag、发 npm 包或切换任何现有 CLI。
- CI workflow 已编写，但新仓库没有远端；不能把本地通过说成远端 CI 已运行。
- Multica/provider 身份和运维服务管理通过本地协议/资源测试，不是生产任务/真实权限回收/跨主机部署验收。
- 当前 AGS 不提供安全的原生 merge expected-head 合同，以及部分 required-CI 事实缺失。这些属于明确接口边界，客户端未改造运行主站或降低安全规则以消除限制。
- Linux x64 的本地和真实服务测试已执行；其他系统运行、系统包管理器、签名发布及正式用户迁移需后续单独验证。

下一阶段应继续在同一个新核心上迭代，不发展“公共核心+私人核心”两个长期分支。旧 CLI 在用户批准切换前继续承担日常工作；这次不删除它、不抢占其命令名和 home。
