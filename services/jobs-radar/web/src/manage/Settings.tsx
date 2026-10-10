import { useEffect, useState } from "react";
import { Button, Card } from "@heroui/react";
import { store, useManagement } from "./store";
import { act, Toggle } from "./components";
export function Settings({ route }: { route?: string }) {
  const { docs } = useManagement();
  const settings = docs.settings?.value || {};
  const flags = settings.autofillSettings || {};
  const [connection, setConnection] = useState<any>(null);
  const refresh = () =>
    window.postMessage({ type: "jobs:website-ready" }, location.origin);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.source === window &&
        event.origin === location.origin &&
        event.data?.type === "jobs:extension-status"
      )
        setConnection(event.data);
    };
    window.addEventListener("message", receive);
    refresh();
    return () => window.removeEventListener("message", receive);
  }, []);
  const update = (key: string, value: boolean) =>
    act(
      store.write({
        settings: {
          ...settings,
          autofillSettings: {
            ...flags,
            saveApplications: true,
            saveResponses: true,
            [key]: value,
          },
        },
      }),
    );
  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">设置</h1>
      <Card>
        <Card.Content className="gap-5">
          <Toggle
            label="自动下一页"
            description="当前页全部完成后继续。"
            value={flags.autoClickNextPage === true}
            onChange={(v) => update("autoClickNextPage", v)}
          />
          <Toggle
            label="自动提交"
            description="仍需先处理未完成题目和开放题草稿。"
            value={flags.autoSubmit === true}
            onChange={(v) => update("autoSubmit", v)}
          />
          <Toggle
            label="Workday 自动填写技能"
            description="默认关闭。已有技能会保留。"
            value={flags.workdaySkills === true}
            onChange={(v) => update("workdaySkills", v)}
          />
        </Card.Content>
      </Card>
      <Card>
        <Card.Header>
          <Card.Title>连接与诊断</Card.Title>
        </Card.Header>
        <Card.Content className="gap-3">
          <p>网站已连接</p>
          <p>
            {connection
              ? connection.connected
                ? "扩展已连接"
                : "扩展尚未连接"
              : "正在检测扩展；请确认已安装并启用。"}
          </p>
          {connection?.queued > 0 && <p>待同步投递 {connection.queued} 条</p>}
          {connection?.error && (
            <p className="text-danger" role="alert">
              {connection.error}
            </p>
          )}
          <p className="text-sm text-muted">
            详细诊断可从扩展的“诊断”入口查看。
          </p>
        </Card.Content>
        <Card.Footer>
          <Button variant="secondary" onPress={refresh}>
            重新检测
          </Button>
        </Card.Footer>
      </Card>
    </div>
  );
}
