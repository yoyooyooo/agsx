# 配套组件的边界

## 目标

正常代码协作使用未经修改的官方 Git/gh。根据仓库 origin 和官方 gh 的主机认证配置选择 GitHub 或 AGS，不需要逐命令的 GH_HOST/GH_REPO、包装前缀或 PATH shim。

Git 托管、PR 投影、CI 后端与 merge authority 是独立选择。AGS 提供标准接口、后端适配与政策执行；这里不复制 Forgejo API、required CI 判定或第二套 PR 命令模型。

## 模块

```text
src/domain        少量附属命令的 Schema、结构化错误、上下文标识
src/platform      Node HTTP、进程、输入、文件权限与原子写入
src/application   setup / doctor / session / association
src/packaging     本地候选包核验、单槽安装与中断恢复
```

Effect Context/Layer 拥有可替换资源边界。HTTP、进程和输入均有截止时间、取消、输出上限与作用域释放；不将一个大 Promise 包进 Effect 冒充资源管理。Node 是运行时，Bun 只负责精确 catalog/lock 安装。

## 官方 gh 的配置是主机权威

setup 不创建第二份 Context 注册表。它读取官方 gh 配置，仅修改显式 AGS 主机，保留其他主机和用户条目。先检查凭据文件权限和旧配置摘要，联网验证原生账号，然后用本组件锁及写前指纹核对提交。官方 gh 自己不遵守本组件锁，因此维护者必须避免并发执行其他 gh auth 配置写入；这里不承诺跨进程生态的原子 CAS。

`doctor` 使用官方 gh 解释实际访问结果，配置诊断只输出主机、账号、覆盖变量名称和结果，不复制 token 或原始 subprocess 错误。

## 任务启动，不是命令代理

session.start 在任务开始时，使用官方 gh 中该主机的原生账号创建有界运行凭据。它生成独立的 GH_CONFIG_DIR 和标准 Git URL-scoped credential helper 配置。启动器应用一次环境清单，之后直接运行官方 Git/gh；本组件不接收、解析或代跑那些业务命令。

Git credential helper 是 Git 的标准协议扩展点，不是同名 git 可执行文件。它只响应精确协议/主机/仓库范围内的凭据请求，支持 Git 重复的认证协商 metadata，不接受重复的目标字段。它不执行 shell 用户片段或 Git 命令，不向其他主机给出 token。

## 认证与关联

原生账号决定权限和 PR 作者。source/Agent/Task/Run 只补充上下文；自报值标为 provisional，空值 unlinked。可选 source 校验由 AGS 的固定 connector 完成；验证后仍必须绑定当前原生账号，不能将任意 metadata 当成换身份或授权的依据。

一个任务 session 可承接 gh 的整组查询和 mutation，不是 per-operation grant。并发任务各有令牌和 gh 配置，不能靠“最近的 task”猜归属。撤销与到期继续拒绝访问，运行令牌不允许读取/生成长期账号凭据。

已有 mat-only 工作负载接入不被这个组件静默复活。任务启动器需要已有原生 AGS Agent 身份；如何由运行平台安全预配该身份属于明确部署接入，不以 Human fallback 代替。

## 未知结果与留存

创建前分配客户端 UUID，并写 starting receipt。POST 结果未知时保留 unknown；相同目录拒绝重新创建。end 使用原账号按 UUID 撤销，不能靠重复 POST 取回秘密。

结束只清理本 session 的确切凭据文件，留下小型 ended receipt。不递归清空调用者目录。生命周期由任务启动器负责，没有隐藏 daemon、无限版本归档或后台自动发版。安装目标仅一个当前槽，产物哈希只证明字节一致，不冒充发行签名。
