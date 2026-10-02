# Profile 兼容接口部署记录

> 脱敏工程候选（尚未替换原件、需逐文件审定）：本文件不得作为个人事实、答案或投递台账。标为 synthetic 的示例均为虚构；保留的测试数量、故障机制与待验边界沿用原记录，不代表新增真实成功。原始私人证据仅在已核验的受限备份中保留。

## 后续修复：local.8 私人版直连

用户明确要求去掉手动配对：现已为私人插件签发独立设备凭证，保存在扩展 Git 忽略的 `.private/connection.json`，构建时只写入本地后台资源。扩展启动直接加载凭证并同步，不需要网站授权操作；原服务器权限隔离不变。凭证沿用 180 天期限，原版会员/AI 服务没有改变。

当时已分别检查服务健康、接口认证边界、设备/Profile 权限和受保护申请表 hash；不保留个人库存计数。部署检查不能代替用户浏览器中的完整 Profile 同步。

当时已分别检查服务健康、接口认证边界、设备/Profile 权限和受保护申请表 hash；不保留个人库存计数。部署检查不能代替用户浏览器中的完整 Profile 同步。

插件整页回归复现了原账号初始化/远端列表阻塞新建页；local.8 去除这些页面阻塞，保留后台请求与错误提示。49 项插件检查通过。网站静态资源发布改为内容版本参数，备份资源为 `/data/backups/pre-profile-autoconnect-20260917.sqlite`、镜像 `jobs-radar:pre-profile-autoconnect-20260917` 和 `.profile-autoconnect-20260917/previous/jobs_radar/`。浏览器里重新加载后的真实 Profile 同步仍需单独验证。

2026-09-17，插件版本 `2.28.0-local.6`。目标是复用原插件 Profile 界面、CRUD、选择与本地缓存，通过兼容接口改接自己的服务器。

## 接口与数据

- 网站登录后 `/api/extension/connect` 显式携带 `profiles: true` 才签发独立 `profile_token`。投递回执令牌不能访问 Profile，Profile 令牌也不能读取岗位看板。设备撤销后两种权限失效。
- `POST /api/extension/profiles` 接收 `{path, method, body}`，兼容原 `/api/ext/sync/profile` 及 `/api/ext/sync/profile/list` 的获取、列表、新建、更新、删除响应。
- SQLite 表 `owner_profiles`、`owner_profile_revisions`、`profile_grants` 保存资料、修订及令牌哈希。删除为软删除，不能删除最后一份资料。
- 更新携带 `expected_sync`；冲突返回 409，不覆盖云端版本。相同内容重试幂等。客户端保留待发送修改，目前没有冲突合并界面。
- 首次迁移先保存 `jobsProfileBeforeMigration` 本地备份，再使用持久迁移 ID 上传当前资料。部署未读取或上传真实浏览器资料。
- Saved Responses 不在本次云迁移内。原第三方 AI 服务未改接。原第三方账号下其他云功能与新 Profile ID 的组合未验证。

## 部署与验证

仅上传 `jobs_radar/web.py`、`jobs_radar/profiles.py` 和部署脚本至现有服务器，重建 `mcp` 服务。部署完成后健康检查正常；采集定时器恢复为 active；Profile 接口无令牌 POST 返回 401。线上两份文件 SHA256 与本地发布清单一致。

当时已分别检查服务健康、接口认证边界、设备/Profile 权限和受保护申请表 hash；不保留个人库存计数。部署检查不能代替用户浏览器中的完整 Profile 同步。

本地验证：43 项插件测试、202 项服务端测试通过；插件构建通过。测试包括实际原函数的适配调用、CRUD、本地备份、断网恢复、冲突和权限。浏览器扩展管理页受工具策略限制，尚未执行用户已安装插件中的真实 Profile 同步闭环；需用户重新加载 `extensions/speedyapply-local/dist` 并刷新已登录网站后验证。

## 回滚资源

- 数据库备份（容器内）：`/data/backups/pre-profile-cloud-20260917.sqlite`
- 部署前状态：`/data/backups/pre-profile-cloud-20260917-state.json`
- 旧代码：`/home/ubuntu/siyi/jobs-radar/.profile-cloud-20260917/previous/jobs_radar/`
- 本地发布清单：`.qa/profile-cloud-20260917/manifest.json`
〔此处个人记录已移除；不作为事实、答案或当前投递状态来源。〕

回滚代码时优先保留当前数据库，避免丢失部署后的投递或资料修改； 不要直接覆盖为旧备份。
