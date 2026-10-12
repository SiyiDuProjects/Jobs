import { useEffect, useState } from "react";
import { Button, Card, Spinner, Tabs } from "@heroui/react";
import type { JobKind } from "../JobWorkspace";
import { kindLabel, profileForKind } from "./kind-profiles";
import { store, useManagement } from "./store";
import {
  blankEducation,
  blankJob,
  same,
  type Profile as ProfileData,
} from "./model";
import { Dialog, Field, Menu, Upload, Toggle, download } from "./components";
import { Tags } from "./ProfileWidgets";
import { HistoryFields, readResume } from "./ProfileEditors";
import { ProfilePersonal, ProfilePreferences } from "./ProfilePreferences";
export { NewProfile } from "./NewProfile";
export { SaveField } from "./ProfileWidgets";
const missingPaths = [
  "nameData.firstName",
  "nameData.lastName",
  "contactData.email",
  "contactData.phoneNumber",
  "addressData.country",
  "addressData.city",
  "employmentData.citizenships",
  "applicationData.visaStatus",
  "applicationData.sponsorshipNow",
  "applicationData.sponsorshipFuture",
  "applicationData.earliestStartDate",
];
export function missingProfileFields(p: ProfileData) {
  return missingPaths.filter((path) => {
    const [group, key] = path.split(".");
    const value = (p as any)[group]?.[key];
    return (
      value === undefined ||
      value === "" ||
      (Array.isArray(value) && !value.length)
    );
  }).length;
}
export function Profile({ kind }: { kind: JobKind }) {
  const { current, docs, profiles, pending } = useManagement();
  const id = profileForKind(kind, profiles, docs.jobsKindProfiles?.value);
  if (!id)
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-base font-semibold">
            {kindLabel(kind)}资料（未设置）
          </h1>
          <Menu
            label="更多"
            items={[
              {
                id: "new",
                label: "新建资料",
                action: () => {
                  location.hash = "/profile/new";
                },
              },
            ]}
          />
        </div>
        <p>请在设置中选择{kindLabel(kind)}使用的资料。</p>
        <Button
          onPress={() => {
            location.hash = "/settings";
          }}
        >
          设置资料对应
        </Button>
      </div>
    );
  if (current?.id !== id)
    return (
      <div className="py-20 flex justify-center">
        <Spinner aria-label={`正在读取${kindLabel(kind)}资料`} />
      </div>
    );
  return (
    <ProfileForm
      key={current.id}
      kind={kind}
      record={current}
      responses={docs["jobsResponses:" + current.id]?.value || []}
      busy={pending > 0}
    />
  );
}
function ProfileForm({
  record,
  responses,
  busy,
  kind,
}: {
  record: NonNullable<ReturnType<typeof useManagement>["current"]>;
  responses: any[];
  busy: boolean;
  kind: JobKind;
}) {
  const [dialog, setDialog] = useState<"rename" | "delete" | null>(null);
  const [name, setName] = useState("");
  const { profiles, unsaved } = useManagement();
  const [p, setP] = useState<ProfileData>(() =>
    structuredClone(record.profile),
  );
  const [base, setBase] = useState(record.profile);
  const dirty = !same(p, base);
  useEffect(() => {
    if (!dirty) {
      setP(structuredClone(record.profile));
      setBase(record.profile);
    }
  }, [record.last_sync]);
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, [dirty]);
  useEffect(() => {
    store.setDraftDirty(dirty);
    return () => store.setDraftDirty(false);
  }, [dirty]);
  const part = (key: keyof ProfileData, value: any) =>
    setP((old) => ({ ...old, [key]: value }));
  const textGroup = (
    group: "nameData" | "contactData" | "addressData" | "websiteData",
    fields: Record<string, string>,
  ) => (
    <div className="grid gap-4 sm:grid-cols-2">
      {Object.entries(fields).map(([key, label]) => (
        <Field
          key={key}
          label={label}
          value={(p[group] as any)[key]}
          onChange={(v) => part(group, { ...p[group], [key]: v })}
        />
      ))}
    </div>
  );
  const save = async () => {
    try {
      await store.saveProfile(p, { ...record, profile: base });
      const saved = store.state.current!.profile;
      setBase(saved);
      setP(structuredClone(saved));
    } catch (e) {
      store.report(e);
    }
  };
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-base font-semibold break-words">
            {kindLabel(kind)}资料（{p.profileName}）
          </h1>
          <p className="text-sm text-muted mt-1">
            常用资料还有 {missingProfileFields(p)} 项未填写
          </p>
        </div>
        <Menu
          label="更多"
          items={[
            {
              id: "new",
              label: "新建资料",
              disabled: dirty || busy || unsaved > 0,
              action: () => {
                location.hash = "/profile/new";
              },
            },
            {
              id: "rename",
              label: "重命名",
              disabled: dirty || busy || unsaved > 0,
              action: () => {
                setName(p.profileName);
                setDialog("rename");
              },
            },
            {
              id: "delete",
              label: "删除资料",
              danger: true,
              disabled: dirty || busy || unsaved > 0 || profiles.length < 2,
              action: () => setDialog("delete"),
            },
            {
              id: "export",
              label: "导出资料",
              action: () =>
                download(
                  "profile.json",
                  JSON.stringify(p, null, 2),
                  "application/json",
                ),
            },
            {
              id: "responses",
              label: "导出旧回答",
              action: () =>
                download(
                  "saved-responses.json",
                  JSON.stringify(responses, null, 2),
                  "application/json",
                ),
            },
          ]}
        />
      </div>
      <Tabs defaultSelectedKey="experience">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 bg-background py-3">
          <Tabs.ListContainer className="w-fit">
            <Tabs.List aria-label="资料分区">
              {[
                ["experience", "经历"],
                ["personal", "个人"],
                ["preferences", "偏好"],
              ].map(([id, label]) => (
                <Tabs.Tab key={id} id={id}>
                  {label}
                  <Tabs.Indicator />
                </Tabs.Tab>
              ))}
            </Tabs.List>
          </Tabs.ListContainer>
          {dirty && (
            <Button
              size="sm"
              className="ml-auto"
              isPending={busy}
              onPress={save}
            >
              保存更改
            </Button>
          )}
        </div>
        <Tabs.Panel
          id="experience"
          shouldForceMount
          className="data-[inert=true]:hidden"
        >
          <Card id="experience">
            <Card.Content className="gap-6">
              {(["jobData", "educationData"] as const).map((kind) => (
                <section key={kind} className="space-y-4">
                  <div className="flex justify-between">
                    <h3 className="font-medium">
                      {kind === "jobData" ? "工作经历" : "教育经历"}
                    </h3>
                    <Button
                      size="sm"
                      variant="secondary"
                      onPress={() =>
                        part(kind, [
                          ...p[kind],
                          structuredClone(
                            kind === "jobData" ? blankJob : blankEducation,
                          ),
                        ])
                      }
                    >
                      添加
                    </Button>
                  </div>
                  {p[kind].map((item, i) => (
                    <div
                      key={i}
                      className="border-b border-separator pb-4 space-y-2"
                    >
                      <HistoryFields
                        kind={kind}
                        item={item}
                        onChange={(v) =>
                          part(
                            kind,
                            p[kind].map((old, n) => (n === i ? v : old)),
                          )
                        }
                      />
                      <Button
                        size="sm"
                        variant="secondary"
                        onPress={() =>
                          part(
                            kind,
                            p[kind].filter((_, n) => n !== i),
                          )
                        }
                      >
                        移除这条经历
                      </Button>
                    </div>
                  ))}
                </section>
              ))}
              <section className="space-y-4">
                <div className="flex justify-between">
                  <h3 className="font-medium">项目经历</h3>
                  <Button
                    size="sm"
                    variant="secondary"
                    onPress={() =>
                      part("projectData", [
                        ...(p.projectData || []),
                        {
                          name: "",
                          link: "",
                          startDate: "",
                          endDate: "",
                          description: "",
                        },
                      ])
                    }
                  >
                    添加项目
                  </Button>
                </div>
                {(p.projectData || []).map((project, i) => (
                  <div
                    key={i}
                    className="grid gap-4 sm:grid-cols-2 border-b border-separator pb-4"
                  >
                    {Object.entries({
                      name: "名称",
                      link: "链接",
                      startDate: "开始月份",
                      endDate: "结束月份",
                      description: "描述",
                    }).map(([key, label]) => (
                      <div
                        key={key}
                        className={
                          key === "description" ? "sm:col-span-2" : "min-w-0"
                        }
                      >
                        <Field
                          label={label}
                          type={key.endsWith("Date") ? "month" : "text"}
                          multiline={key === "description"}
                          value={(project as any)[key]}
                          onChange={(v) =>
                            part(
                              "projectData",
                              p.projectData!.map((old, n) =>
                                n === i ? { ...old, [key]: v } : old,
                              ),
                            )
                          }
                        />
                      </div>
                    ))}
                    <Button
                      size="sm"
                      variant="secondary"
                      onPress={() =>
                        part(
                          "projectData",
                          p.projectData!.filter((_, n) => n !== i),
                        )
                      }
                    >
                      移除项目
                    </Button>
                  </div>
                ))}
              </section>
              <Tags
                label="技能"
                value={p.skillsData || []}
                onChange={(v) => part("skillsData", v)}
                limit={25}
              />
              <section className="space-y-3">
                <h3 className="font-medium">语言</h3>
                {p.languageData.map((item, i) => (
                  <div className="grid grid-cols-2 items-end gap-4" key={i}>
                    <Field
                      label="语言"
                      value={item.language}
                      onChange={(v) =>
                        part(
                          "languageData",
                          p.languageData.map((old, n) =>
                            n === i ? { ...old, language: v } : old,
                          ),
                        )
                      }
                    />
                    <Field
                      label="熟练程度"
                      value={item.proficiency}
                      onChange={(v) =>
                        part(
                          "languageData",
                          p.languageData.map((old, n) =>
                            n === i ? { ...old, proficiency: v } : old,
                          ),
                        )
                      }
                    />
                    <Toggle
                      label="流利"
                      value={!!item.fluent}
                      onChange={(v) =>
                        part(
                          "languageData",
                          p.languageData.map((old, n) =>
                            n === i ? { ...old, fluent: v } : old,
                          ),
                        )
                      }
                    />
                    <Button
                      size="sm"
                      variant="secondary"
                      onPress={() =>
                        part(
                          "languageData",
                          p.languageData.filter((_, n) => n !== i),
                        )
                      }
                    >
                      移除
                    </Button>
                  </div>
                ))}
                <Button
                  size="sm"
                  variant="secondary"
                  onPress={() =>
                    part("languageData", [
                      ...p.languageData,
                      { language: "", proficiency: "" },
                    ])
                  }
                >
                  添加语言
                </Button>
              </section>
              {textGroup("websiteData", {
                linkedin: "LinkedIn",
                github: "GitHub",
                portfolio: "作品集",
              })}
              <Tags
                label="其他链接"
                value={p.websiteData.websites || []}
                onChange={(v) =>
                  part("websiteData", { ...p.websiteData, websites: v })
                }
              />
              <section className="space-y-2">
                <h3 className="font-medium">简历</h3>
                <p className="text-sm text-muted">
                  {p.resumeData.fileName || "未上传"}
                </p>
                <Upload
                  label="上传 PDF"
                  accept=".pdf"
                  onFile={async (f) => part("resumeData", await readResume(f))}
                />
              </section>
            </Card.Content>
          </Card>
        </Tabs.Panel>
        <Tabs.Panel
          id="personal"
          shouldForceMount
          className="data-[inert=true]:hidden"
        >
          <Card id="personal">
            <Card.Content className="gap-5">
              {textGroup("nameData", {
                firstName: "名",
                middleName: "中间名",
                lastName: "姓",
                prefix: "称谓",
                suffix: "姓名后缀",
                preferredFirstName: "常用名",
                preferredMiddleName: "常用中间名",
                preferredLastName: "常用姓",
              })}
              <Toggle
                label="使用常用名"
                value={!!p.nameData.preferredName}
                onChange={(v) =>
                  part("nameData", { ...p.nameData, preferredName: v })
                }
              />
              {textGroup("contactData", {
                email: "邮箱",
                phoneCountryCode: "电话国家代码",
                phoneNumber: "电话",
                phoneDeviceType: "电话类型",
              })}
              {textGroup("addressData", {
                line1: "街道地址",
                line2: "公寓或门牌补充",
                city: "城市",
                state: "州或省",
                postalCode: "邮编",
                country: "国家",
              })}
              <ProfilePersonal p={p} onChange={setP} />
            </Card.Content>
          </Card>
        </Tabs.Panel>
        <Tabs.Panel
          id="preferences"
          shouldForceMount
          className="data-[inert=true]:hidden"
        >
          <Card id="preferences">
            <Card.Content>
              <ProfilePreferences p={p} onChange={setP} />
            </Card.Content>
          </Card>
        </Tabs.Panel>
      </Tabs>
      {dialog === "rename" && (
        <Dialog
          title="重命名资料"
          onClose={() => setDialog(null)}
          onSave={async () => {
            if (!name.trim()) throw Error("请填写资料名称");
            await store.saveProfile({ ...p, profileName: name.trim() }, record);
          }}
        >
          <Field label="资料名称" value={name} onChange={setName} required />
        </Dialog>
      )}
      {dialog === "delete" && (
        <Dialog
          title="删除资料"
          danger
          saveLabel="删除资料"
          onClose={() => setDialog(null)}
          onSave={() => store.deleteProfile(record.id)}
        >
          <p>
            删除“{p.profileName}
            ”后，使用它的岗位类型需要在设置中重新选择资料。已有投递记录会保留。
          </p>
        </Dialog>
      )}
      {dirty && (
        <div className="flex justify-end gap-3">
          <Button
            variant="secondary"
            isDisabled={busy}
            onPress={() => {
              setP(structuredClone(base));
            }}
          >
            撤销未保存更改
          </Button>
          <Button isPending={busy} onPress={save}>
            保存更改
          </Button>
        </div>
      )}
    </div>
  );
}
