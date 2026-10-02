# Jobs 浏览器插件

自有 Manifest V3 源码。30 个 ATS 适配器与共享控件、规则、页面流程通过标准 ES 模块组合，npm 负责依赖；运行时不依赖旧发行包、代码补丁或网站管理界面。

浏览器加载目录为当前主 checkout 下的 `extensions/speedyapply-local/dist`，不要套用其他机器的绝对路径。`dist/` 和 `.private/` 均不进入 Git；新机器需要先准备本地连接配置、npm 依赖及服务的 Python 虚拟环境，再在此目录运行 `npm run update`。检查成功后，在 Chromium 浏览器的扩展管理页开启开发者模式，选择“加载已解压的扩展程序”并选中 `dist`；已有安装则点击重新加载。macOS 的目录选择框可用 `⌘⇧G` 输入当前机器上的完整路径。

弹窗入口为 `src/custom/popup.jsx`，使用 HeroUI 的按钮、输入框和链接，以及 HeroUI Pro 的 Segment / EmptyState。Pro 包复用网站已有的 `services/jobs-radar/web/vendor/heroui-pro-react-1.0.0-beta.8.tgz`；两端直接使用 HeroUI 默认蓝色主题，不再覆盖为紫色。`scripts/build-popup.mjs` 将 React 和 CSS 全部打包到插件本地。档案与岗位操作仍由现有后台接口处理。主列表不再注入“加入队列”，弹窗不再提供队列入口；已有队列记录和独立队列页面保留。

`scripts/verify-popup-browser.mjs <playwright-core path> <Chromium executable>` 在独立浏览器中验证打包后的弹窗、键盘选择、删除与撤销，以及网站蓝色主题和岗位操作文案；使用合成数据，不访问个人 Profile 或真实申请页。截图与结果写入工作区 `work/ui-blue-popup/`。

修复后的交付统一运行 **`npm run update`**：生成共享契约 → 全量行为测试、类型检查、结构检查 → 构建私人包 → 核对源码、包内容及安装目录未发生并发变化 → 更新固定 `dist` 并验证读回。失败保留原安装；成功保留 `artifacts/previous-dist` 供回退。随后提示用户重载 Jobs 扩展，已有申请页不要自动刷新。私人连接文件只在本地构建时读取，不进入源码。

多个 agent 可以并行修复，但应在改动汇总并稳定后由一个 agent 运行更新。旧候选包、未经检查的包、被改过的包和安装目录已被另一发布更新的包均拒绝替换；worktree 必须先整合回主 checkout。更新锁覆盖检查到安装的整个过程，不要删除其他进程的锁。源码发生变化则保留旧安装，重新运行同一个更新命令。此机制不自动合并源码冲突，参与修复的 agent 仍须确认改动都已整合。

`npm ci` 安装锁定依赖。`npm test`、`npm run typecheck`、`npm run format:check` 可单独检查。`npm run build` 仅用于明确需要候选包的调试，不能作为修复交付；旧 `npm run build -- --publish --personal` 入口转到完整更新流程。更新失败的自有候选包和测试自建候选包会清理，不清扫其他 agent 的目录或历史证据。

网站的 Profile、答案与投递记录是唯一数据源。浏览器按活动页面取固定版本的临时资料，最后一个相关页面结束后释放；后台不预取完整 Profile。已获服务器确认的个人答案随活动页面释放，未确认的编辑临时保留到同步成功，过期连接恢复时先核对原 Profile 身份。连接设置与尚未回传的结果独立保留。Profile 读取使用共享 schema；AI 请求只发送 Profile ID、版本和当前题目。所有写请求使用协议版本 2，旧客户端须升级。

已有安装可能仍保存旧版个人资料。普通启动检查已知缓存名称与大小，并有界检查旧设置补充内容；发现旧数据时暂停填写。弹窗中的独立迁移入口先备份并核验恢复、显示需要确认的资料差异，再按服务器许可逐项清理。源码、合成服务联调和隔离浏览器升级已实现验证，用户真实安装尚未迁移，不能视为 D6 现场验收完成。具体范围、恢复与停用安排见 [旧存储升级方案](source/STORAGE-UPGRADE.md)。

维护入口见 [填表结构](source/content/README.md)；故障证据保存、脱敏与重放见 [复现流程](source/REPRODUCTION.md)。职责大小检查为 `npm run check:structure`。扫描性能可用 `npm run measure:scanner` 在固定合成页面对照历史版本，原始次数与耗时保存到 `.qa/scanner-performance.json`。

本地测试、候选包构建、Chrome 重新加载、真实网站填入保持和最终提交是独立的验证层；本地检查通过不代表真实投递通过。原版迁移的来源与文件散列记录保留在 `upstream.json`，不参与当前构建。
