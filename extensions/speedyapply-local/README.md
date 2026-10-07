# Jobs 浏览器插件

自有 Manifest V3 扩展：30 个 ATS 适配器共用控件、答案规则和页面流程，通过 ES 模块构建。插件辅助填写、上传与审核，当前由本人检查并点击最终提交；全职和实习分别绑定服务器 Profile。

## 安装与交付

在当前主 checkout 的本目录准备 npm 依赖及服务的 Python 虚拟环境后运行：

```sh
npm ci
npm run update
```

浏览器加载本目录的 `dist`：首次在扩展管理页选择“加载已解压的扩展程序”，已有安装则重新加载。macOS 目录选择框可用 `⌘⇧G` 输入当前机器的完整路径。`dist/` 和 `.private/` 不进入 Git；构建不再读取或嵌入连接令牌。已有配对保留在浏览器存储中，新安装通过网站配对。

插件面板的「填写设置 → Workday 自动填写技能」默认关闭，包括升级后的已有安装。关闭时跳过技能逐项搜索、Profile/已保存答案补填和 AI 补填，保留已选技能；必填技能仍需手动处理。开关仅保存在当前浏览器，从下一次填写运行开始生效，不会重启正在进行的填写。

`update` 依次生成契约、运行全量行为测试及类型/结构/格式检查、构建本机安装包、验证源码与安装未被并发改动，再替换并读回固定 `dist`。失败保留原安装，成功保留 `artifacts/previous-dist`。多个修复汇总稳定后由一次更新交付；不要删除更新锁、复制旧候选包或直接改 `dist`。更新器核实旧进程已退出后可回收遗留锁，进程仍在或锁信息不明时保持停止。worktree 改动须先整合回主 checkout。`npm run build` 只生成调试候选包。

磁盘交付、浏览器重载和真实页面验收分别记录。重载前保留正在填写的页面，不自动刷新表单。接回只读取网站保留的值并恢复审核，不能把旧版缺失的审核标记当作已确认答案。

## 日常入口与数据

点击工具栏图标打开 Chrome 原生侧边栏，集中查看当前窗口活动标签页的进度、审核、档案、账号和岗位操作；待确认答案显示 `!` 徽标。入口源码为 `src/custom/popup.jsx`，包内沿用 `popup.html` 路径。界面使用本地打包的 HeroUI，Pro 包与网站共用，不从远程加载界面代码。页面不再注入进度/审核浮窗；已有队列记录和独立队列页面保留。

服务器 Profile、已保存答案和投递记录是唯一数据源。活动页面读取固定版本的临时资料；相关页面结束后释放已确认资料，未同步的编辑与回执保留到同步完成。AI 只接收 Profile ID、版本和当前题目。后台不预取完整 Profile，审核答案从原申请文档按需读取。变更请求要求协议版本 2。

发现旧版个人缓存时暂停填写，通过独立迁移入口先备份和核验，再处理差异。机制与恢复边界见[存储升级](source/STORAGE-UPGRADE.md)，历史验收不代表每一台新安装均已迁移。

## 开发与验证

`npm run develop` 生成无生产 key、无私人连接的 `artifacts/development`。只在独立 Chrome profile 加载并配置测试连接，不复制日常连接。设置页提示运行版与磁盘版不一致，不自动重载浏览器。

| 检查 | 命令或脚本 |
| --- | --- |
| 行为、类型、格式、职责边界 | `npm test`、`npm run typecheck`、`npm run format:check`、`npm run check:structure` |
| 扫描与页面流程性能 | `npm run measure:scanner`、`npm run measure:page`；可传已保存源码作对比基线，结果在 `.qa/` |
| 隔离浏览器侧边栏布局、草稿和切页 | `node scripts/verify-panel-browser.mjs <playwright-core路径> <Chrome可执行文件>` |
| 隔离浏览器接回、保值、审核与推进边界 | `node scripts/verify-recovery-browser.mjs <playwright-core路径> <Chrome可执行文件>` |

浏览器脚本使用合成资料和独立实例，不访问日常扩展或真实申请。合成速度和本地检查不能替代雇主页面验收。旧 `verify-popup-browser.mjs` 保留包内设置界面验证，原生侧边栏以 panel 脚本为入口。

填表职责见[页面结构](source/content/README.md)，故障捕获与脱敏重放见[复现流程](source/REPRODUCTION.md)。未解决问题集中在[平台索引](../../notes/ats-platform-status.md)。原版来源散列保存在 `upstream.json`，不参与当前构建。
