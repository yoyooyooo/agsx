# 从完整替代 CLI 收缩为配套组件

完成度依据用户故事，不依据复刻命令数量。此前重建的 50 命令面不再作为产品要求。这个表给每一组实际能力一个归属，不维护两套日常操作核心。

| 旧能力                                                    | 当前归属                                      | 验证/说明                                                                |
| --------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------ |
| origin / GitHub vs AGS 选择                               | 官方 gh 的 remote 和按主机认证                | server 官方 gh netns 验收，不使用 GH_HOST/GH_REPO                        |
| Context add/use/import/export                             | 官方 gh 配置；附属 setup.plan/apply 和 doctor | 不复制 Context registry；只有显式主机配置，没有私人默认                  |
| Human / native service auth                               | 官方 gh 身份存储和 `/api/v3/user`             | 不要求 Multica；setup 先验证再写入                                       |
| 设备登录/多账号切换                                       | 官方 gh auth                                  | 不再复制 OAuth device 命令；服务端提供原有登录路由                       |
| Git clone/fetch/pull/push/commit                          | 系统 Git                                      | session 只配置标准 credential helper，不拦截 Git argv                    |
| Git/gh bootstrap shim                                     | 退役                                          | 不生成同名命令、不改 PATH                                                |
| repo create/list/view/ref                                 | 官方 gh / Git                                 | 服务端标准协议承担业务差异                                               |
| PR create/list/view/edit/comment/review/close/reopen/diff | 官方 gh                                       | server 修复 draft 与 HEAD 接入，不保留另一个 PR 命令树                   |
| PR update/rebase/merge                                    | 官方 gh 与 AGS 的实际政策接口                 | native merge 原子验证 head/base；provider authority 独立保留；不降级绕过 |
| CI checks / run list/view/log                             | 官方 gh；AGS 按配置选择 CI backend            | native/none/Forgejo/GitHub Actions；不是默认 Forgejo                     |
| provider projection/status 查询                           | association.show / ci.backend                 | 标准事实在服务端；补充跨系统关联，不直接取 provider 密钥                 |
| grant issue/renew/revoke 命令                             | 退役                                          | 新任务身份是原生账号的有界运行登录，不是逐命令授权票据                   |
| task/Agent/run 关联                                       | session.start/show/end + 服务端关联           | metadata 可以不完整；权限不来自自报上下文                                |
| mat-only bootstrap                                        | 不偷偷保留旧旁路                              | 需运行平台预配/接入合法原生 Agent 身份；没有 Human/管理员 fallback       |
| invocation 对所有写入的二次协议                           | 退役                                          | 仅 session setup 的未知结果使用 UUID 收口；不包裹普通 gh 输出            |
| required CI 本地猜测                                      | 禁止                                          | 服务端提供真实事实；未知不能变成空成功                                   |
| provider账户/SQL/docker/主站磁盘运维                      | 移出日常客户端                                | 不复制旧工具的机器控制台；由各服务明确运维入口负责                       |
| 独立安装与本地候选核验                                    | package.inspect/verify/install                | 单槽、有界临时产物，不维护 current/previous 多版本集合                   |
| JSON/schema/退出码                                        | 限于附属命令                                  | 不重写官方 gh 的成熟交互与 JSON 选择                                     |

## 两仓联合故事

1. 官方 gh 在 origin 对应的 AGS 上创建/读取 PR，没有目标环境变量、--repo 或 shim。
2. 同一个 AGS 依次选择 GitHub Actions 与真实 Forgejo wire-shape 的隔离后端，官方 gh 检查、run、日志可以复用；旧 run ID 不串到新后端。
3. companion 在任务开始时准备环境；系统 Git 按原 HTTP origin push，官方 gh 按同主机 HTTPS API 开 PR，AGS 记录对应 run。
4. 同一 native actor 的并发任务不共用 session；撤销一个不影响另一个。缺 source 元数据不撤销原生权限。
5. 原型代码不推送生产仓库、不修改团队安装、不自动发布；真实业务数据始终留在原环境。

附属组件本身不宣称全部 GitHub 平台兼容、所有 Forgejo 管理 API 存在、Mat-only 运行环境已自动迁移、或线上团队已经完成切换。
