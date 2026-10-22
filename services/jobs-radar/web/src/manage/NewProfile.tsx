import { useEffect, useRef, useState } from "react";
import { Button, Card } from "@heroui/react";
import { Choice, Field, Upload } from "./components";
import { assertProfile, defaultProfile, same, type Profile } from "./model";
import { store, useManagement } from "./store";

export function NewProfile() {
  const [id] = useState(() => crypto.randomUUID());
  const [base] = useState<Profile>(() => ({
    ...structuredClone(defaultProfile),
    profileName: "",
  }));
  const [p, setP] = useState(base),
    [source, setSource] = useState("");
  const edits = useRef(0),
    active = useRef(true);
  const { profiles, pending, unsaved } = useManagement();
  const change = (value: Profile) => {
    edits.current++;
    store.setDraftDirty(!same(value, base));
    setP(value);
  };
  useEffect(() => {
    active.current = true;
    const before = (e: BeforeUnloadEvent) => {
      if (store.state.draftDirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", before);
    return () => {
      active.current = false;
      store.setDraftDirty(false);
      window.removeEventListener("beforeunload", before);
    };
  }, []);
  const importProfile = async (load: () => Promise<Profile>) => {
    const revision = ++edits.current;
    const value = await load();
    assertProfile(value);
    if (!active.current || edits.current !== revision) return;
    change(value);
  };
  const create = async () => {
    try {
      if (!p.profileName.trim()) throw Error("请填写资料名称");
      await store.saveProfile(
        { ...p, profileName: p.profileName.trim() },
        null,
        id,
      );
      store.setDraftDirty(false);
      location.hash = "/settings";
    } catch (e) {
      store.report(e);
    }
  };
  return (
    <div className="max-w-2xl space-y-5">
      <h1 className="text-base font-semibold">新建资料</h1>
      <Card>
        <Card.Content className="gap-4">
          <Field
            label="资料名称"
            value={p.profileName}
            onChange={(v) => change({ ...p, profileName: v })}
          />
          <div className="grid sm:grid-cols-2 gap-4">
            <Field
              label="名"
              value={p.nameData.firstName}
              onChange={(v) =>
                change({ ...p, nameData: { ...p.nameData, firstName: v } })
              }
            />
            <Field
              label="姓"
              value={p.nameData.lastName}
              onChange={(v) =>
                change({ ...p, nameData: { ...p.nameData, lastName: v } })
              }
            />
          </div>
          <details>
            <summary className="text-sm text-muted cursor-pointer">
              从现有资料开始
            </summary>
            <div className="space-y-3 mt-3">
              <Choice
                label="复制已有资料"
                value={source}
                options={Object.fromEntries(
                  profiles.map((v) => [v.id, v.profileName]),
                )}
                onChange={setSource}
              />
              <Button
                variant="secondary"
                isDisabled={!source || pending > 0}
                onPress={async () => {
                  try {
                    await importProfile(async () => {
                      const row = await store.profileAPI(
                        "/" + encodeURIComponent(source),
                      );
                      return {
                        ...row.profile,
                        profileName: row.profile.profileName + " 副本",
                      };
                    });
                  } catch (e) {
                    store.report(e);
                  }
                }}
              >
                复制
              </Button>
              <Upload
                label="导入资料 JSON"
                accept=".json"
                onFile={(file) =>
                  importProfile(async () => JSON.parse(await file.text()))
                }
              />
            </div>
          </details>
        </Card.Content>
        <Card.Footer className="gap-3">
          <Button isPending={pending > 0} onPress={create}>
            创建资料
          </Button>
          <Button
            variant="secondary"
            isDisabled={pending > 0 || unsaved > 0}
            onPress={() => {
              edits.current++;
              store.setDraftDirty(false);
              location.hash = "/settings";
            }}
          >
            放弃并返回
          </Button>
        </Card.Footer>
      </Card>
    </div>
  );
}
