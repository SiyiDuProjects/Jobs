import { useState } from "react";
import { Button, Card, Separator } from "@heroui/react";
import { store, useManagement } from "./store";
import { defaultSettings } from "./model";
import { act, Dialog, Field, Menu, Toggle } from "./components";
import { SaveField } from "./Profile";

export function Settings({ route }: { route: string }) {
  const { docs } = useManagement(),
    settings = docs.settings?.value || defaultSettings,
    configs: any[] = docs.configList?.value || [defaultSettings],
    goal = docs.dailyGoal?.value || 10;
  const [dialog, setDialog] = useState(""),
    [name, setName] = useState("");
  const update = (fields: Record<string, any>) =>
    store.write({
      settings: { ...settings, ...fields, configName: undefined },
    });
  const links = [
    ["/settings/autofill", "Autofill"],
    ["/settings/premium", "AI 回答"],
    ["/settings/subscription", "服务"],
  ];
  const flags = [
    [
      "saveApplications",
      "Save Applications",
      "Submitted applications are saved on the Applications page.",
    ],
    [
      "autoClickNextPage",
      "Auto-Click Next Page",
      "Autofill automatically moves to the next page of an application.",
    ],
    [
      "autoSubmit",
      "Auto-Submit",
      "Autofill automatically submits after filling out the application.",
    ],
    [
      "saveResponses",
      "Save Responses",
      "Answers are saved for future applications.",
    ],
  ];
  return (
    <>
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
        <Menu
          label={settings.configName || "Save settings…"}
          items={[
            {
              id: "save",
              label: "Save as new configuration",
              action: () => setDialog("save"),
            },
            ...configs.map((config, i) => ({
              id: "config-" + i,
              label: config.configName,
              action: () => act(store.write({ settings: config })),
            })),
            {
              id: "delete",
              label: "Delete configuration",
              danger: true,
              disabled:
                !settings.configName || settings.configName === "Default",
              action: () => setDialog("delete"),
            },
          ]}
        />
      </div>
      <div className="grid gap-6 md:grid-cols-4 md:gap-12">
        <nav className="flex flex-col gap-2">
          {links.map(([path, label]) => (
            <Button
              key={path}
              variant={route === path ? "secondary" : "ghost"}
              className="justify-start"
              onPress={() => {
                location.hash = path;
              }}
            >
              {label}
            </Button>
          ))}
          <Separator />
          <a className="text-muted text-sm px-3 py-2" href="/">
            岗位列表
          </a>
        </nav>
        <div className="md:col-span-3 space-y-6">
          {route.endsWith("/premium") ? (
            <>
              <h2 className="text-lg font-medium">AI 回答</h2>
              <Card>
                <Card.Content>
                  <p>
                    AI 使用当前申请绑定的
                    Profile。个人事实和答题偏好请保存在对应资料的 AI
                    补充说明中。
                  </p>
                  <a className="text-accent underline" href="#/profile">
                    个人资料
                  </a>
                  {settings.premiumSettings?.responseContext && (
                    <p className="text-muted text-sm mt-3">
                      旧版补充内容已保留，完成迁移核对后再使用。
                    </p>
                  )}
                </Card.Content>
              </Card>
            </>
          ) : route.endsWith("/subscription") ? (
            <Card>
              <Card.Header>
                <Card.Title>jobs 服务</Card.Title>
              </Card.Header>
              <Card.Content>
                <p>
                  此私人版使用 jobs 服务器。AI 回答接入 Luna，无需原版订阅。
                </p>
              </Card.Content>
            </Card>
          ) : (
            <>
              <h2 className="text-lg font-medium">Autofill Options</h2>
              <Card>
                <Card.Content className="gap-5">
                  {flags.map(([key, label, description], i) => (
                    <div key={key} className="space-y-5">
                      {i > 0 && <Separator />}
                      <Toggle
                        label={label}
                        description={description}
                        value={!!settings.autofillSettings?.[key]}
                        onChange={(value) =>
                          act(
                            update({
                              autofillSettings: {
                                ...settings.autofillSettings,
                                [key]: value,
                              },
                            }),
                          )
                        }
                      />
                    </div>
                  ))}
                  <Separator />
                  <SaveField
                    key={String(goal)}
                    label="Daily Application Goal"
                    value={String(goal)}
                    onSave={(value) => {
                      const n = Number(value);
                      if (!Number.isInteger(n) || n < 1 || n > 999)
                        throw Error("Enter a goal between 1 and 999");
                      return store.write({ dailyGoal: n });
                    }}
                  />
                </Card.Content>
              </Card>
              <p className="text-muted text-sm">
                申请网站的账户密码保留在本机插件中，不上传至网站。
              </p>
            </>
          )}
        </div>
      </div>
      {dialog === "save" && (
        <Dialog
          title="Save Configuration"
          onClose={() => setDialog("")}
          saveLabel="Save"
          onSave={() => {
            const trimmed = name.trim();
            if (!trimmed || configs.some((c) => c.configName === trimmed))
              throw Error("Choose a unique configuration name");
            const config = { ...settings, configName: trimmed };
            return store.write({
              settings: config,
              configList: [...configs, config],
            });
          }}
        >
          <Field
            label="Configuration Name"
            value={name}
            onChange={setName}
            required
          />
        </Dialog>
      )}
      {dialog === "delete" && (
        <Dialog
          title="Delete configuration?"
          danger
          saveLabel="Delete"
          onClose={() => setDialog("")}
          onSave={() =>
            store.write({
              settings: defaultSettings,
              configList: configs.filter(
                (c) => c.configName !== settings.configName,
              ),
            })
          }
        >
          <p>{settings.configName}</p>
        </Dialog>
      )}
    </>
  );
}
