# 命令与配置

## 唯一输入契约

`node dist/cli.js schema` 返回机器可读命令清单。`schema --command pr.create` 返回该命令的完整 JSON Schema（含 `$defs`），以及风险、所有者和是否需要显式执行。文档不复制全部 flag 清单；实际 schema 是命令解析与测试共同使用的来源。

两种等价写法：

```bash
node dist/cli.js pr list --context local --repo sample/project --limit 20
node dist/cli.js pr.list --input ./request.json
```

`--input -` 读取一个 JSON 对象。文件和 flag 不得重复提供同一属性。数组/对象 flag 使用 JSON，不接受会有歧义的逗号魔法；例如 `--fields '["number","state","head.sha"]'`。`fields` 只是属性投影，不执行 jq、模板或 JavaScript。

大部分写操作默认只输出 `planned`。`--apply` 才执行。`git.run` 根据实际 Git 子命令区分：read 类可直接运行，commit/push 等需要 apply；显式安装的会话 Git shim 将一次原生 Git 调用视为用户的执行请求。

`ops.plan/verify` 是显式有凭据的只读观察，不是纯静态计划；不会自动加载。`package.verify` 读取用户指定候选目录。不要把所有 read/plan 都理解为零 I/O。只有 schema 和参数拒绝保证在配置/凭据之前完成。

## 新的客户端 home

默认 `~/.agsx/`，可用 `AGSX_HOME` 指定。它不与服务用户的 `~/.ags/` 混用，也不扫描 `~/.ags-cli/`。

```text
config.json                 当前唯一配置 schema
secrets/<context>.token     可选，客户端拥有的凭据
operations/<uuid>.json      有界请求身份和结果，不保存正文/凭据
workloads/<digest>.json      有界短期委派凭据，敏感、owner-only
device/<context>.json       待完成的 OAuth device flow
shims/                      仅显式 bootstrap 创建
```

```json
{
  "schema": "agsx.config.v1",
  "defaultContext": "local",
  "journalLimit": 128,
  "contexts": {
    "local": {
      "endpoint": "http://127.0.0.1:6666",
      "instanceId": "development",
      "auth": {
        "kind": "human",
        "credential": { "file": "secrets/local.token" }
      }
    }
  }
}
```

Human 不需要 `workload`。`instanceId` 是操作者明确绑定的 AGS 实例身份，不从主机名猜测。endpoint 必须是不带 userinfo、路径、query 或 fragment 的 HTTP(S) origin。HTTP 只默认允许 loopback；私网 HTTP 也需要显式 `allowHttp: true`。

跨机器访问可以声明 `aliases`。同一个 origin 不能属于两个 Context。`context.show` 在仓库内观察 origin，不读取 token；在仓库外显示明确/默认 Context。`--repo` 可与 `--context` 明确选择另一仓库；原生 Git 始终以实际远端为准，不能用 Context 参数把同一个 push 改投其他实例。

可选 `publicUrls` 只改变返回数据中的人类可见 URL origin，不改变认证目标、provider coordinate 或合并权威。可选 `proxy` 为明确 HTTP(S) proxy；HTTPS 使用 CONNECT 并保留证书校验。`caFile` 相对客户端 home 解析，不支持关闭 TLS 校验。

## 凭据与调用者

- `human`：Context 明确引用文件或专用环境变量；`/api/v3/user` 必须返回 Human。
- `service`：相同机制，但要求真实服务/Agent 身份，不能拿 Human token 假装服务账号。
- `workload`：只有存在显式 Multica adapter 信任时才成立，不读取 Human credential。

```json
{
  "endpoint": "https://primary.example.test",
  "instanceId": "work",
  "auth": { "kind": "service", "credential": { "env": "BUILD_AGS_TOKEN" } },
  "workload": {
    "adapter": "multica",
    "endpoint": "https://tasks.example.test",
    "issuerInstanceId": "issuer-instance",
    "workspaces": ["example-workspace"]
  }
}
```

文件引用与环境变量名是配置，值不是；不接受 `--token <raw>`。用户也不应把 token 写进 `--input`。`auth.import` 使用 owner-only 单 token 文件，先向 AGS 核验身份，再写入客户端自己的 secret。`auth.logout` 只是解除本机引用，输出明确说明没有隐式撤销服务端令牌。

`MULTICA_TOKEN` 存在时采用 workload 模式；`MULTICA_SERVER_URL` 不能与配置相冲突，workspace/agent/task 坐标与服务器 grant/session 回执逐项绑定。issuer 使用 grant source 的 **instance ID**，不是任意显示名称或 URI。管理员 effect 角色只有明确 `AGSX_ACCESS_ROLE=maintainer|admin` 可请求，最后仍由服务器授权。

设备登录使用两步，适合 Agent 显示授权 URL 给 Human，不自动打开浏览器：

```bash
node dist/cli.js auth device-start --context local --apply
node dist/cli.js auth device-finish --context local --wait --apply
```

## Git、PR 与 CI

```bash
node dist/cli.js git run --args '["clone","https://primary.example.test/sample/project.git","./project"]' --apply
node dist/cli.js pr create --repo sample/project --head feature --base main --title 'A change' --apply
node dist/cli.js pr view --repo sample/project --number 12
node dist/cli.js ci checks --repo sample/project --number 12 --watch --wait-ms 60000
node dist/cli.js pr merge --repo sample/project --number 12 --expected-head aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --method fast-forward-only --apply
```

clone 参数要求 URL、目标目录在前；fetch/pull/push 要明确 `origin`。不接受执行器配置、alternate remote、URL rewrite、任意 shell alias。每次临时 helper 都限定 protocol+host+repo，退出删除，系统和 provider 凭据不进入该 Git 子进程。已有 URL-scoped Edge 地址解析可继续由 Git 使用；CLI 不复制 Edge 缓存/调度逻辑。

PR create 支持 body-file、fill、draft 和分支 SHA 预检；返回 AGS 创建事实，不把 provider 暂时未完成当作未创建。CI 的 required 事实由服务器提供，缺失则明确 unsupported。`run.logs --failed-only` 仅在观察到该 run 失败/取消时读取日志，不猜一个独立 provider run ID。

`pr.update-branch --rebase` 使用真实 Git 与 exact lease。调用者无需手工维护一个临时 worktree；冲突时不会 push，临时数据会清理。普通编辑/关闭的 head 检查只是请求前检查；只有服务器支持原子条件或 Git lease 的操作才声称原子保障。

## 显式运维

参见 [operator.example.json](../examples/operator.example.json)。manifest 自身须 owner-only；任何 provider 凭据文件同样受边界检查。

```bash
node dist/cli.js ops plan --manifest /private/operator.json
node dist/cli.js ops verify --manifest /private/operator.json
node dist/cli.js ops apply --manifest /private/operator.json --expected-plan <observed-plan-hash> --apply
```

provider 仓库/branch policy/hook/labels、主站 mapping、service restart 是分开的阶段。apply 不承诺跨服务原子事务；中途失败后重新观察，不重发未知写入。未声明的审核/CI字段不覆盖。新项目不提供原来的数据库后门、主站Git目录回推或私有主机 registry。

## 包与本地开发

```bash
node scripts/task.mjs build
node dist/cli.js package verify --directory .test-build/candidate
node dist/cli.js package install --directory .test-build/candidate --prefix /private/agsx-current --expected-digest <verified-digest> --apply
```

目标必须为空目录或同一安装器已拥有的当前槽。不会写全局 bin，不会接管 npm，不会切换旧 ags-cli。manifest 自签 hash 只证明字节一致，不证明发行者身份。正式签名和发布尚未进行。
