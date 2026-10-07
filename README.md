# Jobs

私人求职工作区：Jobs Radar 管理岗位、Profile 和投递记录；浏览器插件负责识别表单、填写、上传和进度提示。当前使用方式是插件辅助填写，由本人检查并最终提交。全职和实习按岗位绑定各自的服务器 Profile，不共用一份默认答案或附件。

## 从哪里开始

| 工作 | 入口 |
| --- | --- |
| 安装、开发和更新浏览器插件 | [插件说明](extensions/speedyapply-local/README.md) |
| 服务、数据与接口 | [Jobs Radar](services/jobs-radar/README.md) |
| 服务发布和回滚 | [发布契约](services/jobs-radar/deploy/RELEASE.md) |
| 修改代码、保存故障证据的约定 | [AGENTS.md](AGENTS.md) |
| 当前故障与复验范围 | [平台问题索引](notes/ats-platform-status.md) |
| 原生工具与实际投递流程 | [接口说明](notes/jobs-radar.md)；实际投递使用已安装的 `jobs-apply` 技能 |

`notes/` 是本机工程证据，不进入 Git；在新的 checkout 中可能不存在。个人资料和附件从服务器 Profile 读取，工程记录不充当第二份个人档案或投递台账。

## 维护边界

- `extensions/speedyapply-local/`：共享控件、答案规则、30 个 ATS 适配器和本地安装流程。修复后运行 `npm run update`；浏览器重载与真实页面验证另行确认。
- `services/jobs-radar/`：采集、网站、MCP、Profile 和权威投递记录。服务部署只走提交后的发布流程。
- `scripts/`：仍在使用的管理和诊断工具。旧本地领岗/记账以及一次性改简历脚本已经退出运行入口。
- `notes/ats-bugs/`：按故障机制保存案例；`notes/archive/` 和 `services/jobs-radar/docs/archive/` 保存历史证据，不能当作当前操作说明。

开发扩展使用独立浏览器 profile；日常安装保留固定 `dist`。私人配置、数据库、附件、现有回滚包和未解决故障证据不按缓存处理。机器迁移时再查 [Mac 恢复记录](MAC-MIGRATION.md)。
