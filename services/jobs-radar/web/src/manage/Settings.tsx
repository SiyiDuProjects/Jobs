import { useEffect, useState } from "react";
import { Button, Card } from "@heroui/react";
import { store, useManagement } from "./store";
import { act, Choice, Toggle, Dialog } from "./components";
import { defaultKindProfiles, type KindProfiles } from "./kind-profiles";
import { same } from "./model";
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
      <h1 className="text-base font-semibold">设置</h1>
      <ProfileBindings />
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
      <Button
        variant="secondary"
        onPress={async () => {
          await fetch("/api/session", {
            method: "DELETE",
            credentials: "same-origin",
          });
          location.reload();
        }}
      >
        退出
      </Button>
    </div>
  );
}

function ProfileBindings() {
  const { profiles, docs, pending, unsaved } = useManagement();
  const [editing, setEditing] = useState(false);
  const saved = docs.jobsKindProfiles?.value || {};
  const effective = defaultKindProfiles(profiles, saved);
  const [draft, setDraft] = useState<{
    value: KindProfiles;
    base: KindProfiles;
  }>();
  const value = draft?.value || effective;
  const options = Object.fromEntries(
    profiles.map((p) => [p.id, p.profileName]),
  );
  const valid = Object.values(value).every((id) => id && options[id]);
  return (
    <Card>
      <Card.Header>
        <Card.Title>投递资料对应</Card.Title>
        <Card.Description>
          顶部切换全职 / 实习时，查看和投递均使用对应资料。
        </Card.Description>
      </Card.Header>
      <Card.Content className="grid gap-3 sm:grid-cols-2">
        <p>全职 · {options[effective.newgrad || ""] || "未设置"}</p>
        <p>实习 · {options[effective.intern || ""] || "未设置"}</p>
      </Card.Content>
      <Card.Footer>
        <Button
          variant="secondary"
          isDisabled={pending > 0 || unsaved > 0}
          onPress={() => setEditing(true)}
        >
          设置对应
        </Button>
      </Card.Footer>
      {editing && (
        <Dialog
          title="投递资料对应"
          onClose={() => {
            setEditing(false);
            setDraft(undefined);
          }}
          onSave={async () => {
            if (!valid) throw Error("请选择全职与实习对应的资料");
            if (!same(value, saved))
              await store.write(
                { jobsKindProfiles: value },
                { jobsKindProfiles: draft?.base || saved },
              );
            setDraft(undefined);
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            {(
              [
                ["newgrad", "全职资料"],
                ["intern", "实习资料"],
              ] as const
            ).map(([key, label]) => (
              <div key={key} className="min-w-0 space-y-2">
                <Choice
                  label={label}
                  value={options[value[key] || ""] ? value[key] : undefined}
                  options={options}
                  disabled={pending > 0 || unsaved > 0}
                  onChange={(id) =>
                    setDraft({
                      value: { ...value, [key]: id },
                      base: draft?.base || structuredClone(saved),
                    })
                  }
                />
                {!options[value[key] || ""] && (
                  <p className="text-sm text-muted">请选择对应资料。</p>
                )}
              </div>
            ))}
          </div>
        </Dialog>
      )}
    </Card>
  );
}
