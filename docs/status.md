# 当前状态

agsx 是官方 Git／gh 的独立附属组件。当前 0.2.0 源码保留 setup、doctor、session、association（含创建后链接收集）和 CI backend 查询；不复制普通 PR／CI 命令。

## 发行与安装

只通过 npm 发布和安装。没有内置 package/install/upgrade/release 命令，没有版本切换或自更新。根目录是使用 Bun catalog 的 private 开发工作区；`npm run build` 生成独立包，这个目录不是发布入口。`0.2.0` 是维护者本机的第一次发布。之后的版本由 annotated tag 触发 GitHub Actions，用 Trusted Publishing 发布构建产物。版本存在与否以 registry 实际结果为准，源码版本不冒充已发布版本。

运行使用 Node.js 22.18+；Bun 只负责 install。`npm test` 包含真实 npm pack 和隔离 global install，验证不依赖源码或开发 node_modules 即可运行。包不携带官方 gh、生产凭据或安装历史。

## 使用边界

官方 gh 创建 PR；`association.collect` 只 GET 已创建 PR 的映射，以明确限时方式返回 AGS／Forgejo 链接。pending、failed、unavailable 不重放创建；地址与 head 同步事实分开。

任务身份在启动边界准备一次，继承合法原生身份，不引入 per-command grants。关联可 provisional/unlinked，不因此阻断已授权的普通协作。没有后台续期，任务启动器负责结束会话。

软件安装不会切换 AGS 主站、修改 Git remote 或配置 provider 凭据。普通 gh 的兼容修复归服务端；真实 Multica 启动器迁移、全 provider 对等和机器部署完成都需要各自证据，不在源码测试中作完成声明。

## 验证

```bash
bun install --frozen-lockfile
npm test
npm run format:check
```
