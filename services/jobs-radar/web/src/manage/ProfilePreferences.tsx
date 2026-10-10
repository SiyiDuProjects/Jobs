import { Choice, Field, Toggle } from "./components";
import { Tags } from "./ProfileWidgets";
import type { Profile } from "./model";
import schema from "../../../jobs_radar/profile.schema.json";
import options from "./profile-options.json";
export const boolChoices = { "": "未填写", true: "是", false: "否" };
export function ProfilePersonal({
  p,
  onChange,
}: {
  p: Profile;
  onChange: (p: Profile) => void;
}) {
  const emp = p.employmentData,
    app = p.applicationData || {};
  const set = (
    group: "employmentData" | "applicationData",
    key: string,
    value: any,
  ) => {
    const data: Record<string, any> = { ...p[group], [key]: value };
    if (value === undefined) delete data[key];
    onChange({ ...p, [group]: data });
  };
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Choice
          label="签证或身份"
          value={app.visaStatus}
          options={{
            ...(app.visaStatus ? {[app.visaStatus]: app.visaStatus} : {}),
            "": "未填写",
            ...Object.fromEntries(
              schema.properties.applicationData.properties.visaStatus["x-legacyEnum"]
                .filter(Boolean)
                .map((v) => [
                  v,
                  (
                    {
                      "US citizen": "美国公民",
                      "Green card": "绿卡",
                      Other: "其他",
                    } as Record<string, string>
                  )[v] || v,
                ]),
            ),
          }}
          onChange={(v) => set("applicationData", "visaStatus", v)}
        />
        <Field
          label="年龄"
          type="number"
          value={emp.age}
          onChange={(v) => set("employmentData", "age", v ? Number(v) : "")}
        />
        {(
          [
            ["employmentData", "eligibilityUS", "目前有美国工作许可"],
            ["applicationData", "sponsorshipNow", "现在需要雇主担保"],
            ["applicationData", "sponsorshipFuture", "未来需要雇主担保"],
          ] as const
        ).map(([group, key, label]) => (
          <Choice
            key={key}
            label={label}
            options={boolChoices}
            value={
              (p[group] as any)?.[key] === undefined
                ? ""
                : String((p[group] as any)?.[key])
            }
            onChange={(v) =>
              set(group, key, v === "" ? undefined : v === "true")
            }
          />
        ))}
      </div>
      <Tags
        label="国籍（国家名称）"
        value={emp.citizenships || []}
        onChange={(v) => set("employmentData", "citizenships", v)}
      />
      <h3 className="font-medium">自愿披露</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        {(
          [
            ["gender", "性别", options.genders],
            ["ethnicity", "族裔", options.ethnicities],
          ] as const
        ).map(([key, label, choices]) => (
          <Choice
            key={key}
            label={label}
            value={emp[key]}
            options={{
              "": "未填写",
              ...Object.fromEntries(choices.map((v) => [v, v])),
            }}
            onChange={(v) => set("employmentData", key, v)}
          />
        ))}
        {[
          ["hispanicOrLatino", "西班牙裔或拉丁裔"],
          ["disability", "目前存在残疾"],
          ["veteran", "退伍军人"],
        ].map(([key, label]) => (
          <Choice
            key={key}
            label={label}
            options={{ ...boolChoices, undisclosed: "不披露" }}
            value={emp[key] === undefined ? "" : String(emp[key])}
            onChange={(v) =>
              set(
                "employmentData",
                key,
                v === "" ? undefined : v === "undisclosed" ? v : v === "true",
              )
            }
          />
        ))}
        <Choice
          label="性别认同与性取向"
          value={emp.identityDefaults}
          options={{
            "": "不设置",
            cis_heterosexual: "性别认同同性别、非跨性别、异性恋、非 LGBTQ+",
            undisclosed: "不披露",
          }}
          onChange={(v) => set("employmentData", "identityDefaults", v)}
        />
        <Field
          label="代词"
          value={app.pronouns}
          onChange={(v) => set("applicationData", "pronouns", v)}
        />
      </div>
      <div className="border-t border-separator pt-5 space-y-3">
        <h3 className="font-medium">默认答案</h3>
        <p className="text-sm text-muted">
          启用的类别在资料和同题旧回答都没有答案时使用，可逐类关闭。
        </p>
        {Object.entries(schema["x-defaultAnswers"]).map(([key, label]) => (
          <div key={key}>
            <Toggle
              label={label}
              value={app.defaultAnswers?.includes(key as any) || false}
              onChange={(enabled) =>
                set(
                  "applicationData",
                  "defaultAnswers",
                  enabled
                    ? [...(app.defaultAnswers || []), key]
                    : (app.defaultAnswers || []).filter((v) => v !== key),
                )
              }
            />
          </div>
        ))}
      </div>
    </div>
  );
}
export function ProfilePreferences({
  p,
  onChange,
}: {
  p: Profile;
  onChange: (p: Profile) => void;
}) {
  const app = p.applicationData || {};
  const set = (key: string, value: any) => {
    const next: Record<string, any> = { ...app, [key]: value };
    if (value === undefined) delete next[key];
    onChange({ ...p, applicationData: next });
  };
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {[
        ["willingToRelocate", "愿意搬迁"],
        ["willingToWorkOnsite", "愿意到办公室工作"],
        ["willingToTravel", "愿意出差或为面试出行"],
        ["hasRelatedPeopleAtWork", "存在需披露的关系人任职"],
      ].map(([key, label]) => (
        <Choice
          key={key}
          label={label}
          value={
            (app as any)[key] === undefined ? "" : String((app as any)[key])
          }
          options={boolChoices}
          onChange={(v) => set(key, v === "" ? undefined : v === "true")}
        />
      ))}
      <Field
        label="最早到岗日期"
        type="date"
        value={app.earliestStartDate}
        onChange={(v) => set("earliestStartDate", v)}
      />
      <Field
        label="可工作至"
        type="date"
        value={app.availableUntil}
        onChange={(v) => set("availableUntil", v)}
      />
      <Choice
        label="每周可工作时长"
        value={app.weeklyHours}
        options={{
          "": "未填写",
          ...Object.fromEntries(
            [10, 15, 20, 25, 30, 35, 40].map((n) => [n, `${n} 小时`]),
          ),
        }}
        onChange={(v) => set("weeklyHours", v)}
      />
      <Choice
        label="已取得最高学历"
        value={app.highestCompletedEducation}
        options={{
          "": "未填写",
          none: "尚未取得学历",
          ...Object.fromEntries(options.degrees.map((v) => [v, v])),
        }}
        onChange={(v) => set("highestCompletedEducation", v)}
      />
      <Choice
        label="薪资要求"
        value={app.salaryPreference}
        options={{
          "": "未填写",
          posted_range: "接受岗位公布范围",
          negotiable: "可协商",
          custom: "指定金额或范围",
        }}
        onChange={(v) => set("salaryPreference", v)}
      />
      {app.salaryPreference === "custom" && (
        <>
          <Field
            label="金额或下限"
            value={app.salaryMin}
            onChange={(v) => set("salaryMin", v)}
          />
          <Field
            label="上限（可选）"
            value={app.salaryMax}
            onChange={(v) => set("salaryMax", v)}
          />
          <Field
            label="货币代码"
            value={app.salaryCurrency}
            onChange={(v) => set("salaryCurrency", v.toUpperCase())}
          />
          <Choice
            label="薪资口径"
            value={app.salaryPeriod}
            options={{
              "": "未填写",
              hourly: "时薪",
              annual_base: "年基本工资",
              annual_total: "年总包",
            }}
            onChange={(v) => set("salaryPeriod", v)}
          />
        </>
      )}
      <Field
        label="首选面试编程语言"
        value={app.interviewLanguage}
        onChange={(v) => set("interviewLanguage", v)}
      />
      <Field
        label="得知职位的渠道"
        value={app.defaultSource}
        onChange={(v) => set("defaultSource", v)}
      />
    </div>
  );
}
