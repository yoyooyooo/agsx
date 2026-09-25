# 协议、失败语义与能力边界

## 输出

stdout 默认输出一个 JSON 对象：

```json
{
  "schema": "agsx.result.v1",
  "command": "pr.create",
  "status": "ok",
  "target": {
    "context": "work",
    "endpoint": "https://primary.example.test",
    "repository": "sample/project"
  },
  "invocation": "12345678-1234-4123-8123-123456789012",
  "data": { "replayed": false, "alreadyCompleted": false, "result": {} }
}
```

状态为 `ok/planned/pending/unknown/error`。未知写结果的错误包含 invocation ID，Agent 不需要从日志猜测。正文、凭据和低层异常不进入 journal；JSON字段投影只是展示，不改变请求。

| 退出码 | 含义                                                                |
| ------ | ------------------------------------------------------------------- |
| 0      | 请求完成或计划生成；必须同时读取 status/data，不将 planned 当已执行 |
| 1      | 观察到 CI 失败等业务失败                                            |
| 2      | 参数、schema 或输入不合法                                           |
| 3      | 配置或当前服务端能力缺口                                            |
| 4      | 认证/授权拒绝                                                       |
| 5      | 目标/版本/前置状态冲突或完整性错误                                  |
| 6      | 写结果未知，不得自动重放                                            |
| 7      | 网络、进程或服务依赖不可用                                          |
| 8      | pending，包括有界等待到期                                           |
| 130    | 用户取消，作用域资源已经释放                                        |

Git命令的原始 exit code 同时保留在 data；外层进程 exit 会约束在常规命令范围。显式 Git shim 保持 Git stdout/stderr，但错误仍不会包含其凭据。

## 请求所有权

普通 HTTP 只向 Context 指定的 AGS origin 请求。传输拒绝 HTTP 重定向，包括同源写重定向；HTTP 5xx 不换节点/身份/协议、不重放。代理必须显式声明，HTTPS CONNECT 仍验证目标证书，代理不会收到目标 Bearer 作为 CONNECT 认证。

Git 保留用户明确拥有的 URL-scoped地址解析，但清除会劫持此次调用的旧credential/helper/header/cookie设置。配置只对单次子进程生效；不会持久修改 GitHub 或团队全局凭据。helper限定protocol+host+repo；无法匹配时不返回任何秘密。

主站真正允许的权限、保护分支、review/required CI、provider mapping和merge effect都归AGS。客户端的格式校验、预检与确认条件不是第二套授权。

## 写入生命周期

```text
严格输入校验
  → 原生目标/身份观察
  → 刷入本地 invocation intent
  → 一次业务写请求
  → 校验结果归属
  → 保存 completed / rejected / unknown
```

少数调用者身份交换本身有独立协议：device-code、grant、transport-session按服务器合同执行，不把源 token 写入通用 journal。任何此类交换都不自动切换Human/provider身份。

本地 journal防止同一invocation在本客户端被盲重放，不提供跨机器分布式exactly-once保证。terminal记录达到上限可回收；所有unknown都保留，空间不够时拒绝新写入，不能静默丢掉待核对意图。

创建仓库/PR的unknown可以按精确locator读回；同一desired state存在只证明当前状态，输出attribution=current_state_only，不冒充因果证明。workload merge若有server invocation，则严格匹配id、grant、repo和expected head。无法证明的评论/审查/Gitpush保持unknown，不为了体验而自动再写。

## 精确 head 与 TOCTOU

- PR普通编辑、关闭/重开：expectedHead是请求前观察，当前服务器没有该PATCH的原子CAS，客户端不声称它是原子事务。
- review：同时传commit_id，绑定所审查提交；服务器仍决定是否允许。
- update-branch merge：原生PUT支持expected_head_sha。
- rebase：重新读取base分支的当前SHA，临时仓库计算，再用`--force-with-lease=ref:oldsha`原子保护目标Git ref。服务器原receive-pack授权与分支保护仍执行。
- provider merge：准确mapping、expected head与服务器effect。
- 纯原生merge：当前固定服务端的PUT没有expected-head输入，因此新客户端明确unsupported。没有provider时不制造默认绑定，更不把失败的provider merge改投原生endpoint。

## 工作负载信任

Context的可选adapter拥有issuerInstanceId、source endpoint及workspace allowlist。grant会逐项校验仓库、target instance、有效期、state、actor/executor与source。transport-session必须有当前合同版本、active状态、正确target/resource/operation/string constraints、父grantauthority revision与correlation，以及相同的workspace/agent/task/run等来源。

Session的实际principal是grant executor，不是仅凭actor显示名推测。普通API请求只获得该操作的短期session；merge使用grant的effect接口，不走generic session。

## CI与projection

provider evidence必须带有允许的correlation receipt、准确AGS PR、provider坐标、head、请求principal及workload来源。run logs也必须证明属于该PR/run/身份，不是拿一个裸run ID直接访问provider。

`required`不是客户端默认值。服务器未提供完整政策事实时返回unsupported；不能把所有checks当required，也不能把字段缺失解读为没有必需检查。无CI provider、投影pending、CI执行pending、CI失败和权限拒绝分开表达。

## 安装与schema演进

当前只有config v1、result v1、operation v1等显式schema；不存在扫描旧profile、导入旧current selector或猜测私人部署的fallback。切换旧用户时，需要另外批准的一次性迁移，而不是保留两套常驻解析器。

单槽安装需明确candidate digest和owned destination。文件、manifest、license均校验；中断标记阻止运行半套程序，允许用同一候选恢复。候选下载/解包不是历史版本库。当前本地hash验证不等价于远端签名/attestation，正式发布前必须另外建立发行信任。

## 验证声明

默认检查使用真实本地HTTP/TLS/Git/进程/文件系统，以及server-shaped的provider/workload协议fixture。固定Release的可选兼容检查进一步使用真实Go主站和全新数据库，运行在无外网network namespace。

生产provider、任务身份、Linux/macOS服务管理与最终发行渠道未在当前重建阶段部署验收。不将旧CLI曾经通过的生产验证继承为新实现的证据。
