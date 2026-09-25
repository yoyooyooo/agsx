# 重建架构与约束

## 决策

独立仓库、单个 TypeScript 包、Node.js 运行。Bun 仅安装，Effect v4 beta.107 与 Node 平台包同版本精确 catalog 固定。`workspaces.packages=[]` 仅承载 catalog，不把服务端移入多包工程。开发命令 `agsx` 和 `AGSX_HOME` 不覆盖当前 ags-cli。

未选择原样复制旧 bundle：它把个人默认、工作负载身份、运维和双平台 gh engine 绑在一起。未选择全 Go 重写：用户选择 TS/Effect，原生日常 API 也不需要完整 gh。未选择插件平台：目前用三个明确的身份实现足够，未来真实需求再扩展。

## 使用面

默认 JSON envelope。`schema` 无文件／网络／凭据 I/O，提供每条命令的参数、输入 JSON Schema、风险、结果与必需身份。`--input <file|->` 提供完整结构化输入，常用标量有严格命名参数，未知参数或重复选择在 I/O 前失败。写操作需 `--apply`；默认生成 plan，并不把 dry-run 当服务端授权。

主要命令族：context、auth、repo、pr、ci、run、git、grant、invocation、ops、package。不保留历史 gh flag/alias parser，也不捆绑定制 gh engine。原先 gh 支持的 list/status/update-branch 等功能用同一原生 AGS transport 重建。机器 schema 是文档与测试的同一来源。

## 类型与所有者

- ConfigStore：单一版本的 config.json、明确 Context、唯一 endpoint/alias、原子写入、有限当前记录。不读取旧 profile、Agent Kit、全局 GitHub token、主站 runtime。
- SecretStore：只读取 Context 明确引用的 owner-only 文件或命名环境变量；常规错误不得包含值。Human 与服务账号独立；Multica 是 opt-in adapter。
- ProcessRunner：argv-only、绝不 shell 拼接，取消和超时终止子进程、限制捕获输出。Git remote 仍由 Git 拥有，客户端校验远端再提供准确域凭据。
- HttpTransport：只请求同一声明 endpoint，拒绝认证重定向，支持明确 CA、代理配置；响应有大小与时间上限；写入无自动重试。网络错误后 outcome_unknown 与普通 rejection 分开。
- Identity：Human/service 向选定 AGS 核验 user_kind；Multica 使用原生 AGS access-grant/transport-session 协议，不读取 Human Secret。repo/operation/head 绑定逐次保留。
- AgsClient：使用 server-owned 原生 REST 与 provider-evidence；不复制 provider merge/required-check 规则，不在失败时改用宽权限通道。仓库本身的 provider 配置事实从 AGS 获取，未知不能当未配置。
- OperationJournal：仅存 request fingerprint、invocation ID、精确目标、状态与结果摘要，不存凭据／正文。相同 invocation 重复调用不重复发写请求；未知结果显式 reconcile。
- Operator：单独模块、显式 operator manifest 和 provider credential，plan/observe/apply 受精确前置摘要保护。不会由普通调用隐式加载机器清单，不运行 provider 数据库后门或 SSH 磁盘回推。
- Packaging：构建来源／文件清单／hash；单槽安装并保留事务暂存，不保留 releases/current/previous 的历史版本集合。当前仓库 private=true，禁止真实发布。

Effect Context/Layer 注入上述边界；Effect.gen 组织业务，类型化错误保留故障阶段，Scope/finalizer 释放进程、网络、锁和临时凭据。测试替换边界，不把真实应用换成一堆响应 fixture。

## 失败语义

stdout 一个 versioned JSON envelope；stderr 不输出秘密。退出码：0=完成，2=输入错误，3=配置/能力缺口，4=认证/授权拒绝，5=目标冲突，6=结果未知，7=网络/依赖不可用，8=待处理，130=取消。分页返回 cursor 或显式 truncated，不把部分数据冒充全量。

创建的未知结果按准确分支／PR／仓库读回；merge 按 invocation/exact head 观察。没有服务器幂等支持时，journal 只阻止本客户端重放，不能声称分布式 exactly-once。写前必须先把 intent 刷到磁盘，否则不发请求。

## 权限与发布边界

当前迭代只改独立项目。现有 AGS、CLI、团队部署和远端发布不变。缺失 server capability 作为明确限制，而非改造用户生产服务。通用代码采用 Apache-2.0；旧项目代码/二进制不直接复制。个人 endpoint、账号、workspace、主机路径不进入公共示例、测试或发行物。
