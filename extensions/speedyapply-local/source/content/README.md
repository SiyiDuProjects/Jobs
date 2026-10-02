# 填表源码

`source/entries/content.js` 和 `background.js` 是真实构建入口。`scripts/build.mjs` 用 esbuild 打包具名 ES 模块，并从服务生成 Profile、答案政策、回答合约、品牌与岗位身份规则。构建输出包括输入模块清单，便于核对依赖。

| 层                                                            | 责任                                             |
| ------------------------------------------------------------- | ------------------------------------------------ |
| `content/shell.js`、`routing.js`                              | 本地启动、ATS 选择和状态界面                     |
| `content/adapters/`                                           | 30 个平台的结构动作与字段声明                    |
| `src/custom/platform-config.js`                               | 表单范围、导航、成功标记与结构规则               |
| `src/custom/control-content.js` (`JobsPageSession`)           | 单一页面阶段、Profile 版本、文档新鲜度与远程指令 |
| `automatic-fill.js`、`form-pipeline.js`                       | 一轮填写、单字段 ledger、确认、导航与唯一写入口  |
| `profile-answers.js`、`answer-resolver.js`、`option-match.js` | 主题识别、Profile/精确保存答案政策与选项匹配     |
| `control-fields.js`、`*-controls.js`                          | 注册控件、结构缓存、候选与提交后读回             |
| `answer-memory.js`                                            | 人的输入与确认答案的唯一捕获入口                 |
| `submission-background.js`、`sync.js`                         | 持久提交保护、事件回执及服务同步                 |

Adapter 每步调用一次 `JobsAutomatic.advance({fill})`。每条绑定和后续答案都通过 `JobsFormPipeline.write`，保留页面已有值；关联拒答控件可用 `whenEmpty` 声明依赖字段为空，是否为空由公共读取器核对。选项事务只有 `chooseSpec → chooseFrom` 一条路径，trace 记录请求、候选、选择、匹配方式与实际读回。

控件结构稳定时复用发现结果，值与校验状态每次重新读取；DOM 条件变化立即失效，页面停止后释放缓存。每个新平台或组件都要有真实模块的行为测试；合成答案矩阵保存明确期望，不执行原始发行代码。
