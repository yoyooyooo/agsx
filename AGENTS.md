# AGS CLI rebuild

这是独立客户端重建，不是原有 AGS／Agent Kit 运行环境。不得修改现有安装、凭据、服务或远端仓库；未获新授权前，不发布 npm、不创建公共仓库、不切换团队客户端。

## 技术与边界

- TypeScript ESM；Node.js 22.18+ 是唯一运行时。Bun 只执行依赖安装，版本由根 package.json 的精确 catalog 和 bun.lock 拥有。
- 核心应用使用 Effect v4 beta 的 Effect、Context、Layer、Schema 和结构化错误。不要把一个 Promise 大函数包进 Effect 后声称完成迁移。
- 进程／HTTP／文件系统必须有明确边界、超时、取消和资源释放。测试默认无外网、无真实凭据、无主站数据库。
- 日常客户端只连接选定 AGS；provider 凭据、机器 SSH、主站数据路径不进入普通认证路径。Multica 是显式可选适配，不是 Human Context 前提。
- CLI 不推测权限或 required CI；server policy 是最终权威。HTTP 错误不改路由、不降权；未知写结果不盲重放。
- 默认 JSON 结果、可发现的命令 schema、明确 exit code。诊断不得输出 token、私钥、完整原始异常、认证 URL。
- 只重建实际能力，不复活被上游明确退役的空命令壳。旧能力必须在 docs/feature-parity.md 有唯一去向和验证证据；缺口不能标成完成。
- 不捆绑旧 CLI、旧二进制、真实机器／workspace 默认配置或 Agent Kit 文件路径。不维护 old/new 两套核心。
- 所有新功能先明确类型、接口、数据流、权属和失败语义；不要建立通用插件平台。

## 开发

`bun install --frozen-lockfile` 安装依赖。
`node scripts/task.mjs check` 执行类型、构建、Node 测试与边界检查。
`node dist/cli.js schema` 查看机器可读命令面；测试 CLI 名为 agsx，不覆盖 ags-cli。

本仓正文中文为主，公开示例仅使用 example.test／loopback／合成身份。操作证据放私有 .scratch，不进入发行物。Git 保持线性提交，不推送未审查内容。
