export var JobsApplicationQueue;
let initialized = false;
export function initializeApplicationQueue() {
  if (initialized) return;
  initialized = true;
  (() => {
    const terminal = new Set(["confirmed", "cancelled"]);
    const working = new Set(["opening", "entering", "filling"]);
    const text = (value) => String(value || "").slice(0, 500);
    const publicUrl = (value) => {
      const url = new URL(value);
      url.hash = "";
      for (const key of [...url.searchParams.keys()])
        if (
          !/^(?:gh_jid|job|jobid|job_id|jid|pid|requisitionid|reqid|id)$/i.test(
            key,
          )
        )
          url.searchParams.delete(key);
      return url.href;
    };
    function create(io) {
      let tail = Promise.resolve();
      const serial = (fn) => {
        const task = tail.then(fn);
        tail = task.catch(() => {});
        return task;
      };
      const save = (state) => io.save({ ...state, updatedAt: io.now() });
      async function load() {
        const session = await io.session();
        let state = await io.load();
        if (!state)
          state = {
            version: 1,
            session,
            enabled: false,
            mode: "fill",
            items: [],
          };
        if (state.version !== 1 || !Array.isArray(state.items))
          throw Error("队列版本无法读取，请保留数据并检查插件版本");
        if (state.session !== session) {
          state.session = session;
          state.enabled = false;
          for (const item of state.items) {
            if (!terminal.has(item.state) && item.state !== "queued") {
              item.paused = true;
              item.reason = "浏览器会话已变化，请打开原页面后继续";
              item.document = null;
              item.documents = {};
              item.ownerSession = null;
              if (item.intent?.action === "submit")
                item.state = "submission_uncertain";
            }
          }
          await save(state);
        }
        return state;
      }
      const owned = (state, tabId) =>
        state.items.find(
          (item) => item.tabId === tabId && item.ownerSession === state.session,
        );
      const permission = (state, item) => ({
        owned: !!item,
        allowed:
          !!item &&
          state.enabled &&
          !item.paused &&
          ![
            "ready",
            "submission_uncertain",
            "blocked",
            "cancelled",
            "confirmed",
          ].includes(item.state),
        mode: state.mode,
        itemId: item?.id,
        state: item?.state,
      });
      async function eligible(item) {
        const result = await io.resolve(item.url, item.jobId);
        if (
          result?.state !== "matched" ||
          !result.job_ids?.includes(item.jobId) ||
          result.queue?.version !== 1
        )
          throw Error("尚不能核对岗位状态，请先连接兼容的服务");
        if (!result.queue.allowed)
          throw Error("岗位当前不可自动开始：" + text(result.queue.reason));
        return result;
      }
      async function push(state, item) {
        if (item.tabId && item.ownerSession === state.session)
          await io.control(item.tabId, permission(state, item)).catch(() => {});
      }
      async function advance(state) {
        if (
          !state.enabled ||
          state.items.some((item) => working.has(item.state) && !item.paused)
        )
          return;
        const item = state.items.find(
          (item) => item.state === "queued" && !item.paused,
        );
        if (!item) return;
        try {
          await eligible(item);
          const tabs = await io.tabs();
          if (tabs.some((tab) => io.same(tab.url, item.url))) {
            item.state = "blocked";
            item.reason = "此岗位已有打开的页面，请先处理已有申请";
            await save(state);
            return;
          }
          // Persist a nonce before creating an inert extension tab. Recovery can
          // adopt that exact staging tab even if the create acknowledgement is lost.
          item.state = "opening";
          item.nonce = io.uuid();
          item.ownerSession = state.session;
          item.startedAt = io.now();
          item.reason = "";
          await save(state);
          const tab = await io.createTab(io.staging(item.nonce));
          item.tabId = tab.id;
          await save(state);
          item.state = "entering";
          await save(state);
          await io.navigate(tab.id, item.url);
        } catch (error) {
          // Once an open effect has started, leave its journal intact for tick.
          // A lost create/update reply is not permission to create another tab.
          if (item.state === "queued") {
            item.state = "blocked";
            item.reason = text(error.message);
            await save(state);
          } else {
            item.reason = "打开页面的结果待核对";
            await save(state);
          }
        }
      }
      async function tick() {
        return serial(async () => {
          const state = await load(),
            tabs = await io.tabs();
          for (const item of state.items) {
            if (
              terminal.has(item.state) ||
              !item.ownerSession ||
              item.ownerSession !== state.session
            )
              continue;
            let tab = tabs.find((tab) => tab.id === item.tabId);
            if (item.state === "opening" && !tab) {
              const staged = tabs.filter(
                (tab) => tab.url === io.staging(item.nonce),
              );
              if (staged.length === 1) {
                tab = staged[0];
                item.tabId = tab.id;
                await save(state);
              } else {
                item.state = "blocked";
                item.paused = true;
                item.reason = "打开操作中断，请核对页面后继续";
                await save(state);
                continue;
              }
            }
            if (!tab) {
              item.paused = true;
              item.reason = "申请页面已关闭；保留进度，等待处理";
              item.state =
                item.intent?.action === "submit"
                  ? "submission_uncertain"
                  : "blocked";
              await save(state);
              continue;
            }
            if (
              tab.url === io.staging(item.nonce) &&
              state.enabled &&
              !item.paused
            ) {
              // The inert staging page proves no application page was entered yet.
              await eligible(item)
                .then(async () => {
                  item.state = "entering";
                  await save(state);
                  await io.navigate(tab.id, item.url);
                })
                .catch(async (error) => {
                  item.state = "blocked";
                  item.reason = text(error.message);
                  await save(state);
                });
            } else if (
              working.has(item.state) &&
              io.now() - (item.progressAt || item.startedAt || item.createdAt) >
                120000
            ) {
              item.state = "waiting_input";
              item.reason = "页面没有继续报告进度，请打开查看登录或页面阻碍";
              await save(state);
            }
          }
          await advance(state);
          return state;
        });
      }
      async function command(action, args = {}) {
        return serial(async () => {
          const state = await load();
          if (action === "add") {
            if (!/^[a-f0-9]{24}$/.test(args.jobId || ""))
              throw Error("请从岗位列表加入队列");
            const url = new URL(args.url);
            if (
              url.protocol !== "https:" ||
              url.username ||
              url.password ||
              url.href.length > 2000
            )
              throw Error("不支持的岗位地址");
            for (const key of url.searchParams.keys())
              if (
                /^(?:token|access_token|password|code|email|auth|session|sessionid)$/i.test(
                  key,
                )
              )
                throw Error("请使用岗位列表的公开申请链接");
            const match = await eligible({ url: url.href, jobId: args.jobId });
            const previous = state.items.find(
              (item) =>
                item.jobId === match.job_id ||
                match.job_ids.includes(item.jobId) ||
                io.same(item.url, url.href),
            );
            if (previous) return state;
            state.items.push({
              id: io.uuid(),
              jobId: match.job_id,
              url: url.href,
              title: text(match.title),
              company: text(match.company),
              state: "queued",
              createdAt: io.now(),
              paused: false,
            });
          } else if (action === "start") {
            if (!["fill", "apply"].includes(args.mode))
              throw Error("请选择运行方式");
            if (
              state.items.some(
                (item) => working.has(item.state) && !item.paused,
              ) &&
              state.mode !== args.mode
            )
              throw Error("先暂停正在处理的岗位，再切换方式");
            if (args.mode === "apply" && !(await io.autoSubmit()))
              throw Error("自动提交尚未开启；请使用只填写方式");
            state.mode = args.mode;
            state.enabled = true;
          } else if (action === "pause") state.enabled = false;
          else if (
            ["resume", "cancel", "pause_item", "open"].includes(action)
          ) {
            const item = state.items.find((item) => item.id === args.id);
            if (!item) throw Error("岗位不在队列中");
            if (action === "open") {
              const tabs = await io.tabs(),
                matched = tabs.filter((tab) => io.same(tab.url, item.url));
              const tab =
                tabs.find(
                  (tab) =>
                    tab.id === item.tabId &&
                    item.ownerSession === state.session,
                ) || (matched.length === 1 ? matched[0] : null);
              if (
                !tab ||
                !(
                  io.same(tab.url, item.url) ||
                  (item.ownerSession === state.session &&
                    item.document?.url === publicUrl(tab.url))
                )
              )
                throw Error("原页面已关闭或改变；不会自动重开申请");
              await io.focus(tab.id);
              return state;
            }
            if (action === "pause_item") item.paused = true;
            if (action === "cancel") {
              if (item.state === "submission_uncertain")
                throw Error("提交结果待核实，不能清除尝试记录");
              item.state = "cancelled";
              item.paused = true;
            }
            if (action === "resume") {
              if (
                terminal.has(item.state) ||
                item.state === "submission_uncertain"
              )
                throw Error("该记录不能自动重试");
              const tabs = await io.tabs(),
                matched = tabs.filter((tab) => io.same(tab.url, item.url));
              const tab =
                tabs.find(
                  (tab) => tab.id === item.tabId && io.same(tab.url, item.url),
                ) || (matched.length === 1 ? matched[0] : null);
              if (!tab || !io.same(tab.url, item.url))
                throw Error(
                  "请保留并打开同一岗位的原页面；队列不会重建不确定的申请",
                );
              await eligible(item);
              item.tabId = tab.id;
              item.ownerSession = state.session;
              item.paused = false;
              item.state = "entering";
              item.reason = "";
              item.startedAt = io.now();
              state.enabled = true;
            }
          } else if (action !== "read") throw Error("未知队列操作");
          await save(state);
          for (const item of state.items) await push(state, item);
          await advance(state);
          return state;
        });
      }
      async function page(message, sender) {
        return serial(async () => {
          const state = await load();
          let item = owned(state, sender.tabId);
          if (!item) {
            if (
              state.items.some(
                (item) =>
                  item.ownerSession === state.session &&
                  item.previousTabs?.includes(sender.tabId),
              )
            )
              return {
                owned: true,
                allowed: false,
                state: "transferred",
                mode: state.mode,
              };
            const tab = await io.tab(sender.tabId),
              parent = owned(state, tab?.openerTabId);
            if (
              parent &&
              ["entry", "login"].includes(parent.intent?.action) &&
              io.now() - parent.intent.at < 120000 &&
              (io.same(message.url, parent.url) ||
                (
                  await io.resolve(message.url, parent.jobId)
                )?.job_ids?.includes(parent.jobId))
            ) {
              parent.previousTabs = [
                ...(parent.previousTabs || []),
                parent.tabId,
              ];
              parent.tabId = sender.tabId;
              parent.documents = {};
              parent.document = null;
              item = parent;
              await save(state);
            }
          }
          if (!item) {
            const held = state.items.find(
              (item) =>
                item.state !== "queued" && io.same(item.url, message.url),
            );
            // A restored page must not revert to ordinary automatic submission just
            // because storage.session (and hence ownership) was lost on restart.
            return held
              ? {
                  owned: true,
                  allowed: false,
                  state: held.state,
                  itemId: held.id,
                  recovery: true,
                  mode: state.mode,
                }
              : { owned: false, allowed: true };
          }
          const tab = await io.tab(sender.tabId);
          if (sender.lifecycle && sender.lifecycle !== "active")
            throw Error("页面已离开");
          if (
            typeof message.document !== "string" ||
            !message.document ||
            message.document.length > 80 ||
            !sender.browserDocumentId
          )
            throw Error("缺少当前文档身份");
          const frame = sender.frameId || 0;
          if (!frame && tab.url !== message.url) throw Error("页面地址已变化");
          const matches = async () =>
            io.same(message.url, item.url) ||
            (await io.resolve(message.url, item.jobId))?.job_ids?.includes(
              item.jobId,
            );
          if (message.type === "hello") {
            const matched = !!(await matches());
            if (!matched) {
              // Login pages lose the job id. Only a same-origin entry document may
              // be inspected for prefilled sign-in; it cannot claim a form/receipt.
              if (new URL(message.url).origin !== new URL(item.url).origin)
                throw Error("页面不属于队列岗位");
            }
            item.documents ||= {};
            item.documents[frame] = {
              id: message.document,
              browserId: sender.browserDocumentId,
              url: publicUrl(message.url),
              matched,
            };
            if (!frame) item.document = item.documents[frame];
            item.lastSeen = io.now();
            await save(state);
            return { ...permission(state, item), entryOnly: !matched };
          }
          const current = item.documents?.[frame];
          if (
            current?.id !== message.document ||
            current.browserId !== sender.browserDocumentId
          )
            throw Error("旧文档不能继续队列");
          if (current.url !== publicUrl(message.url))
            current.matched = !!(await matches());
          item.lastSeen = io.now();
          current.url = publicUrl(message.url);
          const pagePermission = () => ({
            ...permission(state, item),
            entryOnly: current.matched === false,
          });
          if (message.type === "intent") {
            if (!permission(state, item).allowed)
              throw Error("队列已暂停或等待核实");
            if (
              !["entry", "login", "next", "submit"].includes(message.action) ||
              typeof message.step !== "string" ||
              !message.step ||
              message.step.length > 4000
            )
              throw Error("无效页面步骤");
            if (item.intent?.action === "submit")
              throw Error("提交尝试不能重放");
            if (
              item.intent?.document === message.document &&
              item.intent.step === message.step
            )
              throw Error("此页面步骤已经尝试，等待页面变化");
            if (message.action === "submit") {
              if (state.mode !== "apply" || !(await io.autoSubmit()))
                throw Error("队列当前只填写，不提交");
              await eligible(item);
            }
            if (
              ["next", "submit"].includes(message.action) &&
              !(await matches())
            )
              throw Error("表单岗位身份无法核实");
            item.intent = {
              action: message.action,
              document: message.document,
              step: message.step,
              at: io.now(),
            };
            item.progressAt = io.now();
            if (message.action === "submit")
              item.state = "submission_uncertain";
            else
              item.state = message.action === "next" ? "filling" : "entering";
            await save(state);
            return { ok: true };
          }
          if (message.type === "status") {
            if (item.phase !== message.phase) {
              item.progressAt = io.now();
              item.phase = text(message.phase);
            }
            if (message.confirmed === true) {
              if (
                !(await matches()) &&
                !(
                  item.intent?.action === "submit" &&
                  new URL(message.url).origin === new URL(item.url).origin
                )
              )
                throw Error("无法核对收据所属岗位");
              item.state = "confirmed";
              item.reason = "ATS 已确认完成";
            } else if (
              !terminal.has(item.state) &&
              item.state !== "submission_uncertain" &&
              !item.paused &&
              state.enabled
            ) {
              if (message.blocker) {
                item.state = "waiting_input";
                item.reason = text(message.blocker);
              } else if (message.phase === "ai-review") {
                item.state = "waiting_input";
                item.reason = "等待回答／确认当前审核卡";
              } else if (
                current.matched !== false &&
                message.finalReady === true &&
                state.mode === "fill"
              ) {
                item.state = "ready";
                item.reason = "已填好，未提交";
              } else if (current.matched !== false && message.active === true) {
                item.state = "filling";
                item.reason = "";
              }
            }
            await save(state);
            await advance(state);
            return pagePermission();
          }
          if (message.type === "check") {
            await save(state);
            return pagePermission();
          }
          throw Error("未知页面消息");
        });
      }
      return Object.freeze({ command, page, tick });
    }
    JobsApplicationQueue = Object.freeze({ create });
  })();
}
