import { useState } from "react";
import { Choice, Field, Toggle } from "./components";
import type { Profile as ProfileData } from "./model";
import options from "./profile-options.json";
const names = (values: string[]) =>
  Object.fromEntries(values.map((v) => [v, v]));
export function HistoryFields({
  kind,
  item,
  onChange,
}: {
  kind: string;
  item: Record<string, any>;
  onChange: (v: Record<string, any>) => void;
}) {
  const [monthOnly, setMonthOnly] = useState(!item.graduationDate);
  const job = kind === "jobData",
    update = (key: string, v: any) => onChange({ ...item, [key]: v }),
    present = job ? "currentlyWorkHere" : "currentlyAttending";
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {Object.entries(
        job
          ? { jobTitle: "岗位名称", company: "公司", location: "地点" }
          : { school: "学校", fieldOfStudy: "专业", gpa: "GPA" },
      ).map(([key, label]) => (
        <Field
          key={key}
          label={label}
          required={["jobTitle", "company", "school"].includes(key)}
          value={item[key]}
          onChange={(v) => update(key, v)}
        />
      ))}
      {!job && (
        <Choice
          label="学历"
          value={item.degree}
          options={names(options.degrees)}
          onChange={(v) => update("degree", v)}
        />
      )}
      <Field
        label="开始月份"
        type="month"
        value={item.startDate?.slice(0, 7)}
        onChange={(v) => update("startDate", v)}
      />
      {job && !item[present] && (
        <Field
          label="结束月份"
          type="month"
          value={item.endDate?.slice(0, 7)}
          onChange={(v) => update("endDate", v)}
        />
      )}
      {!job && (
        <div className="space-y-2">
          <Field
            label="毕业日期"
            type={monthOnly ? "month" : "date"}
            value={monthOnly ? item.endDate?.slice(0, 7) : item.graduationDate}
            onChange={(v) =>
              onChange({
                ...item,
                endDate: v.slice(0, 7),
                graduationDate: monthOnly ? "" : v,
              })
            }
          />
          <Toggle
            label="只知道月份"
            value={monthOnly}
            onChange={(v) => {
              setMonthOnly(v);
              if (v) onChange({ ...item, graduationDate: "" });
            }}
          />
        </div>
      )}
      <div className="self-end pb-2">
        <Toggle
          label={job ? "目前在职" : "目前在读"}
          value={item[present]}
          onChange={(v) => update(present, v)}
        />
      </div>
      {job && (
        <div className="sm:col-span-2">
          <Field
            label="描述"
            value={item.description}
            onChange={(v) => update("description", v)}
            multiline
          />
        </div>
      )}
    </div>
  );
}
export async function readResume(f: File) {
  if (f.type !== "application/pdf" && !f.name.toLowerCase().endsWith(".pdf"))
    throw Error("请选择 PDF 简历");
  if (f.size > 1024 * 1024) throw Error("简历不能大于 1 MB");
  return new Promise<ProfileData["resumeData"]>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve({
        resumeBase64: String(reader.result).split(",")[1],
        fileName: f.name,
        fileSize: f.size / 1024,
        dateUploaded: new Date().toISOString(),
      });
    reader.onerror = () => reject(Error("无法读取文件"));
    reader.readAsDataURL(f);
  });
}
