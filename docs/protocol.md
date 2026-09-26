# 协议与权属

## 官方协议在前

日常仓库、PR 和 CI 由原版 gh 消费 AGS 的 GitHub-compatible REST/GraphQL。组件没有普通业务命令的转发或替代实现。Git remote 决定代码传输；gh 从 hostname 和已配置账号决定 API 目标。HTTP :6666 Git origin 与同主机 HTTPS API 可以并存。辅助接口使用 `/api/ext/v1`，不伪装成 gh 内置命令。

本组件的 schema/JSON 只描述附属操作。原版 gh 的 JSON、提示和退出码保持原状。没有“全局 --apply”被套在日常 Git/gh 上。

## 任务运行身份

服务端契约：

```text
POST   /api/ext/v1/client-runs
GET    /api/ext/v1/client-runs/{uuid|current}
DELETE /api/ext/v1/client-runs/{uuid}
GET    /api/ext/v1/repos/{owner}/{repo}/pulls/{number}/context
GET    /api/ext/v1/repos/{owner}/{repo}/ci
```

client-runs POST 使用一个现有原生账号凭据，传入客户端 UUID、60–28800 秒 TTL、可选 source/agent/task/run 标识和可选受信来源查询参数。返回一次性 bearer；读取接口只返回 identity/association 摘要。令牌服务端仅保存 hash，继承原生 parent 的有效期与撤销状态；账号失效会拒绝后续访问。

该凭据是标准 Git/gh 的运行登录，不是单个命令的 grant。它不会创建 collaborator、覆盖 role 或提升权限。任务身份不能读取/生成长期账号凭据来逃逸生命周期。

source/Task/Run 为空 => unlinked；自报但未验证 => provisional；可选 connector 查询绑定当前 native actor 后可 linked；不一致为 conflict。所有这些关联标签都不是访问权限。缺来源信息仍然允许原本有权限的 Git/PR；真正的认证无效、权限不足、保护规则或 expected-head 冲突仍然拒绝。

成功业务之后的关联写失败不改成业务失败，不重放 PR 创建。关联查询返回当前 PR/head、运行 provenance 和 provider projection 的独立事实，不把接收投影消息等同于远端 Task 已完成。

## 未知 setup 结果

客户端生成 UUID 并持久化 starting 后才 POST。网络结果不确定时为 unknown；不能删除 receipt 后盲重试。服务端不会因相同 UUID 再次返回 bearer。session.end 可以使用原账号按 UUID 撤销，不要求把已丢失的明文令牌重新取出来。

本地 active receipt 仅保存 token 指纹，明文只在任务私有 gh/hosts.yml。environment.json 不含明文凭据。结束精确清理自己的文件，父账号与其他任务不受影响。

## CI 不是 Git 托管或 merge authority

服务器配置选择 native、none 或一个具名 CI 后端。Forgejo 和 GitHub Actions 适配器使用各自真实 API 形状。run/job 的公开数值 ID 是带后端身份命名空间的稳定映射；更换 API origin 或 external repository 后，不会把旧 ID 当成新后端同号任务。

required_checks 是明确政策，nil/unknown 不等于已知空列表。标准检查始终关联当前 PR head。后端不可用、分页不完整、未知状态或混入其他 run 的 job/log 不能变成空成功。显式字段缺口应当修服务端或声明 unsupported，不能触发另一个 CI 后端作为失败回退。

Forgejo 当前公开 API 缺少 jobs/logs/catalog 和部分执行管理操作：服务端从真实 ActionTask 获得 jobs，并可通过显式、认证且绑定精确 task/run/head 的日志桥接提供日志。已观察 workflow 名称不等于完整可执行目录，未支持的管理 API 明确拒绝。组件只提供 ci.backend 查看配置，不为这些差异新增一套检查/运行命令。

## 兼容验收范围

先构建本项目，再在 AGS Fork checkout 运行：

```bash
node scripts/gh-native-acceptance.mjs --companion /absolute/path/to/ags-cli/.test-build/candidate
```

该脚本使用固定官方 gh 和当前 Fork 源码，全部服务在 loopback-only network namespace，一次性数据库、仓库和凭据。包含 setup、任务环境、系统 Git push、官方 gh PR 创建、双 CI 后端、日志、head 条件、关联与撤销。测试产物不代表已部署生产入口、不代表公开发行或已修改真实 Multica 启动器。
