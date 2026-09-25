# AGS CLI · independent rebuild

开发命令名 **`agsx`**。这是独立、尚未发布的 AGS 客户端重建；不替换当前 `ags-cli`，不读取旧 profile，不访问维护者的私人部署，也不自动切换任何团队安装。

TypeScript ESM + Effect v4 beta，Node.js 22.18+ 运行。Bun **只安装依赖**：精确版本由 `package.json` 的 catalog 与 `bun.lock` 锁定。构建、测试和命令执行全部使用 Node。没有完整 gh 原生二进制、Bun runtime 或 Agent Kit checkout 依赖。

```bash
bun install --frozen-lockfile
node scripts/task.mjs check
node dist/cli.js schema
node dist/cli.js schema --command pr.create
```

## 一条路径完成一件事

默认输出 `agsx.result.v1` JSON。`schema` 给出每条命令的精确输入 JSON Schema、作用域和风险，未知命令/参数在读取配置或凭据之前失败。大多数写操作没有 `--apply` 时只返回计划；计划不代表服务端已授权。

```bash
node dist/cli.js context add --name local --configuration '{"endpoint":"http://127.0.0.1:6666","instanceId":"local"}' --apply
node dist/cli.js context use --name local --apply
node dist/cli.js auth import --context local --kind human --file /private/operator/token --apply
node dist/cli.js pr list --context local --repo sample/project
node dist/cli.js pr create --input ./request.json
node dist/cli.js pr create --input ./request.json --apply
```

`request.json` 示例：

```json
{
  "context": "local",
  "repo": "sample/project",
  "head": "feature/example",
  "base": "main",
  "title": "Example change",
  "body": "A bounded native AGS request."
}
```

`AGSX_HOME` 可改变新的客户端目录，默认 `~/.agsx/`。配置只有 `config.json` 一种格式，密钥使用 owner-only 文件或显式命名的专用环境变量。Human 不需要 Multica；服务账号不冒充 Human；Multica 委派需要显式的信任适配配置。非 loopback HTTP 必须显式 `allowHttp`，不自动关闭 TLS 验证。

## 功能范围

Context 与认证、原生 Git、仓库创建/读取、PR 创建/列表/读取/评论/修改/审查/关闭/重开/更新分支/合并、CI 检查/有界等待与日志、委派 grant 生命周期、未知效果查询、显式 operator 计划/核验/执行，以及本地构建包验证与单槽安装。

运维命令只接受明确的 operator manifest；日常用户不会加载 provider 密钥或主站文件系统。没有 Docker 内生成令牌、直接改 provider 数据库或私有 SSH 脚本后门。能力去向与已知边界见 [feature parity](docs/feature-parity.md)。

`node scripts/task.mjs build` 同时生成常规 `dist/` 与 `.test-build/candidate/` 独立包。独立包不需要外部 Node 依赖，但需要系统 Node/Git；`package verify/install` 校验明确 candidate，安装仅发生在显式选择的空目录或同一安装器拥有的单槽。不提供永久 releases/current/previous 集合。它是本地内容校验，不冒充签名或正式发行。

## 不隐藏失败

服务端决定权限、required CI、provider 与合并规则。缺失政策字段明确返回能力缺口，不由 CLI 猜测。HTTP 错误不换 endpoint，不退回 Human/admin 凭据，不重放未知写入。当前 AGS 的 native merge 没有原子 expected-head 输入，因此不能通过它绕过已有 exact-head provider merge；该限制会清楚返回而不是虚构支持。

仓库当前 `private=true` 且 prepublish 守卫始终拒绝发布。没有生产端到端、公共发布或团队切换验收的声明。现有工具可以继续日常使用；新项目作为后续独立迭代的唯一支点。

更多：[架构](docs/architecture.md) · [命令/配置](docs/commands.md) · [协议与失败语义](docs/protocol.md) · [功能去向](docs/feature-parity.md) · [安全](SECURITY.md)。
