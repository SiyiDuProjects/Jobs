import { useState } from "react";
import { Button, Card } from "@heroui/react";
import { Choice, Dialog, Field } from "./components";
import { store } from "./store";
import type { ApplicationDetails, ProfileRecord } from "./model";
import options from "./profile-options.json";

const yesNo = { "": "未填写", true: "是", false: "否" };
const weeklyHours = {
  "": "未填写",
  ...Object.fromEntries(
    [10, 15, 20, 25, 30, 35, 40].map((hours) => [
      String(hours),
      `${hours} 小时／周`,
    ]),
  ),
};
const salaryPreferences = {
  "": "未填写",
  posted_range: "接受岗位公布范围",
  negotiable: "可协商",
  custom: "指定金额或范围",
};
const salaryPeriods = {
  "": "未填写",
  hourly: "时薪",
  annual_base: "年基本工资",
  annual_total: "年总包",
};
const degrees = {
  "": "未填写",
  none: "尚未取得学历",
  ...Object.fromEntries(options.degrees.map((v) => [v, v])),
};
const boolLabel = (v: boolean | undefined) =>
  v === undefined ? "未填写" : v ? "是" : "否";
const workFacts = [
  ["willingToRelocate", "愿意搬迁"],
  ["willingToWorkOnsite", "愿意到办公室工作"],
  ["willingToTravel", "愿意出差或为面试出行"],
  ["hasRelatedPeopleAtWork", "存在需披露的关系人任职"],
] as const;
type BooleanDetail =
  | "sponsorshipNow"
  | "sponsorshipFuture"
  | (typeof workFacts)[number][0];

export function ApplicationDetailsCard({ record }: { record: ProfileRecord }) {
  const [editing, setEditing] = useState(false);
  const d = record.profile.applicationData || {};
  const values = [
    ["最早到岗日期", d.earliestStartDate],
    ["每周可工作时长", d.weeklyHours ? `${d.weeklyHours} 小时／周` : undefined],
    [
      "已取得的最高学历",
      d.highestCompletedEducation === "none"
        ? "尚未取得学历"
        : d.highestCompletedEducation,
    ],
    ["签证／身份类型", d.visaStatus],
    ["现在需要赞助", boolLabel(d.sponsorshipNow)],
    ["未来需要赞助", boolLabel(d.sponsorshipFuture)],
    ...workFacts.map(([key, label]) => [label, boolLabel(d[key])]),
    [
      "期望薪资",
      d.salaryPreference === "custom"
        ? [
            d.salaryMin,
            d.salaryMax ? `– ${d.salaryMax}` : "",
            d.salaryCurrency,
            salaryPeriods[d.salaryPeriod || ""],
          ]
            .filter(Boolean)
            .join(" ")
        : salaryPreferences[d.salaryPreference || ""],
    ],
    ["代词", d.pronouns],
    ["首选面试编程语言", d.interviewLanguage],
  ];
  return (
    <>
      <Card>
        <Card.Header className="flex-row justify-between items-start">
          <div>
            <Card.Title>申请补充资料</Card.Title>
            <Card.Description>
              按当前个人资料分别保存；不确定的项目可以留空。
            </Card.Description>
          </div>
          <Button variant="secondary" onPress={() => setEditing(true)}>
            编辑申请资料
          </Button>
        </Card.Header>
        <Card.Content className="space-y-6">
          <dl className="grid gap-4 sm:grid-cols-2">
            {values.map(([label, value]) => (
              <div key={label}>
                <dt className="text-muted text-sm">{label}</dt>
                <dd>{value || "未填写"}</dd>
              </div>
            ))}
          </dl>
          <div>
            <p className="text-muted text-sm">AI 补充说明</p>
            <p className="whitespace-pre-wrap">{d.aiNotes || "未填写"}</p>
          </div>
        </Card.Content>
      </Card>
      {editing && (
        <ApplicationDetailsEditor
          record={record}
          onClose={() => setEditing(false)}
        />
      )}
    </>
  );
}

export function ApplicationDetailsEditor({
  record,
  onClose,
}: {
  record: ProfileRecord;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<ApplicationDetails>(
    structuredClone(record.profile.applicationData || {}),
  );
  const set = <K extends keyof ApplicationDetails>(
    key: K,
    value: ApplicationDetails[K],
  ) => setDraft((old) => ({ ...old, [key]: value }));
  const setBool = (key: BooleanDetail, value: string) =>
    set(key, value === "" ? undefined : value === "true");
  return (
    <Dialog
      wide
      title="申请补充资料"
      onClose={onClose}
      onSave={() => {
        const details = { ...draft };
        if (details.salaryPreference !== "custom")
          for (const key of [
            "salaryMin",
            "salaryMax",
            "salaryCurrency",
            "salaryPeriod",
          ] as const)
            delete details[key];
        return store.saveProfile(
          { ...record.profile, applicationData: details },
          record,
        );
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="最早到岗日期"
          type="date"
          value={draft.earliestStartDate}
          onChange={(v) => set("earliestStartDate", v)}
        />
        <Choice
          label="每周可工作时长"
          options={weeklyHours}
          value={draft.weeklyHours}
          onChange={(v) =>
            set(
              "weeklyHours",
              (v || undefined) as ApplicationDetails["weeklyHours"],
            )
          }
        />
        <Choice
          label="已取得的最高学历"
          options={degrees}
          value={draft.highestCompletedEducation}
          onChange={(v) => set("highestCompletedEducation", v)}
        />
        <Field
          label="签证／身份类型"
          value={draft.visaStatus}
          maxLength={200}
          onChange={(v) => set("visaStatus", v)}
        />
        <Choice
          label="现在需要赞助"
          options={yesNo}
          value={
            draft.sponsorshipNow === undefined
              ? ""
              : String(draft.sponsorshipNow)
          }
          onChange={(v) => setBool("sponsorshipNow", v)}
        />
        <Choice
          label="未来需要赞助"
          options={yesNo}
          value={
            draft.sponsorshipFuture === undefined
              ? ""
              : String(draft.sponsorshipFuture)
          }
          onChange={(v) => setBool("sponsorshipFuture", v)}
        />
        {workFacts.map(([key, label]) => (
          <Choice
            key={key}
            label={label}
            options={yesNo}
            value={draft[key] === undefined ? "" : String(draft[key])}
            onChange={(value) => setBool(key, value)}
          />
        ))}
        <Choice
          label="薪资要求"
          options={salaryPreferences}
          value={draft.salaryPreference}
          onChange={(v) =>
            set("salaryPreference", v as ApplicationDetails["salaryPreference"])
          }
        />
        {draft.salaryPreference === "custom" && (
          <>
            <Field
              label="期望金额／下限"
              value={draft.salaryMin}
              onChange={(v) => set("salaryMin", v)}
            />
            <Field
              label="范围上限（可选）"
              value={draft.salaryMax}
              onChange={(v) => set("salaryMax", v)}
            />
            <Field
              label="币种（如 USD）"
              value={draft.salaryCurrency}
              maxLength={3}
              onChange={(v) => set("salaryCurrency", v.toUpperCase())}
            />
            <Choice
              label="计薪方式"
              options={salaryPeriods}
              value={draft.salaryPeriod}
              onChange={(v) =>
                set("salaryPeriod", v as ApplicationDetails["salaryPeriod"])
              }
            />
          </>
        )}
        <Field
          label="代词"
          value={draft.pronouns}
          maxLength={200}
          description="可填写自己的代词，或不愿回答。"
          onChange={(v) => set("pronouns", v)}
        />
        <Field
          label="首选面试编程语言"
          value={draft.interviewLanguage}
          maxLength={200}
          onChange={(v) => set("interviewLanguage", v)}
        />
        <div className="sm:col-span-2">
          <Field
            label="AI 补充说明"
            value={draft.aiNotes}
            multiline
            maxLength={8000}
            description="可写明可实习的起止日期、学期与假期安排，以及其他已确认的补充事实。"
            onChange={(v) => set("aiNotes", v)}
          />
        </div>
      </div>
    </Dialog>
  );
}
