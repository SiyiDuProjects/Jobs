import { useEffect, useState } from "react";
import { Button } from "@heroui/react";
import { api, store, useManagement } from "./store";
import {
  localDay,
  safeHref,
  statuses,
  progressLabel,
  nextStages,
  chineseProgress,
  type Application,
  type AppRow,
} from "./model";
import { Choice, Dialog, Field } from "./components";

export function ApplicationEditor({
  row,
  kind,
  profiles,
  profileId,
  onClose,
}: {
  row?: AppRow;
  kind: 'newgrad' | 'internship';
  profiles: { id: string; profileName: string }[];
  profileId?: string;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(
      row || {
        kind,
        jobTitle: "",
        jobLink: "",
        companyName: "",
        companyLink: "",
        date: new Date().toISOString(),
        status: "applied",
        profileName:
          profiles.find((p) => p.id === profileId)?.profileName || "Default",
      },
    ),
    [profile, setProfile] = useState(profileId || profiles[0]?.id || "");
  const update = (key: string, value: string) =>
    setDraft((d) => ({ ...d, [key]: value }));
  return (
    <Dialog
      title={row ? "编辑投递" : "手动补录"}
      onClose={onClose}
      saveLabel={row ? "保存" : "添加"}
      onSave={async () => {
        if (!draft.jobTitle.trim()) throw Error("请填写岗位名称");
        for (const key of ["jobLink", "companyLink"] as const)
          if (draft[key] && !safeHref(draft[key]))
            throw Error("请填写有效的 HTTP 或 HTTPS 链接");
        const value = { ...draft };
        delete (value as any).key;
        await store.mutateApplications([
          row
            ? {
                action: "update",
                application_id: row.id,
                expected_version: row.version,
                value,
              }
            : {
                action: "create",
                value: {
                  ...value,
                  profileName:
                    profiles.find((p) => p.id === profile)?.profileName ||
                    "Default",
                },
              },
        ]);
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {(["jobTitle", "companyName", "jobLink", "companyLink"] as const).map(
          (key, i) => (
            <Field
              key={key}
              label={["岗位名称", "公司名称", "岗位链接", "公司链接"][i]}
              value={draft[key]}
              onChange={(v) => update(key, v)}
              required={key === "jobTitle"}
            />
          ),
        )}
        <Field
          label="投递日期"
          type="date"
          value={localDay(new Date(draft.date))}
          onChange={(v) => {
            if (v) update("date", new Date(v + "T12:00:00").toISOString());
          }}
        />
        {!row && (
          <>
            <Choice
              label="进展"
              value={draft.status}
              options={statuses}
              onChange={(v) => update("status", v)}
            />
            <Choice
              label="资料"
              value={profile}
              options={Object.fromEntries(
                profiles.map((p) => [p.id, p.profileName]),
              )}
              onChange={setProfile}
            />
          </>
        )}
      </div>
    </Dialog>
  );
}
export function ProgressEditor({
  row,
  onClose,
}: {
  row: AppRow;
  onClose: () => void;
}) {
  const [choice, setChoice] = useState(""),
    [more, setMore] = useState(false),
    [correction, setCorrection] = useState(false);
  const [round, setRound] = useState(""),
    [final, setFinal] = useState("unknown"),
    [summary, setSummary] = useState("");
  const [assessmentType, setAssessmentType] = useState<string>(
    row.progress?.assessment_type || "unknown",
  );
  const [history, setHistory] = useState<any[]>([]),
    [historyError, setHistoryError] = useState("");
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [key] = useState(() => crypto.randomUUID());
  useEffect(() => {
    let active = true;
    api(
      "/api/manage/progress?application_id=" + encodeURIComponent(row.id || ""),
    )
      .then((value) => {
        if (active) setHistory(value.applications[0]?.history || []);
      })
      .catch((error) => {
        if (active) setHistoryError(String(error));
      })
      .finally(() => {
        if (active) setLoadingHistory(false);
      });
    return () => {
      active = false;
    };
  }, [row.id]);
  const stage = choice === "next_interview" ? "interview" : choice;
  const options =
    more || correction
      ? {
          ...statuses,
          ...(row.status === "interview"
            ? { next_interview: "下一轮面试" }
            : {}),
        }
      : nextStages(row);
  return (
    <Dialog
      title="申请进度"
      onClose={onClose}
      saveLabel={choice ? "保存进度" : "关闭"}
      onSave={async () => {
        if (!choice) return;
        if (choice === "next_interview" && !row.progress?.round && !round)
          throw Error("上一轮轮次未知，请填写本轮的实际轮次");
        const number = round ? Number(round) : undefined;
        if (
          number !== undefined &&
          (!Number.isInteger(number) || number < 1 || number > 99)
        )
          throw Error("请填写 1–99 的整数轮次");
        await store.updateProgress(
          row,
          {
            stage,
            action: correction
              ? "correct"
              : choice === "next_interview"
                ? "next_interview"
                : "set",
            summary:
              summary.trim() ||
              `手动更新：${choice === "next_interview" ? "下一轮面试" : statuses[stage] || stage}`,
            ...(stage === "interview"
              ? {
                  interview_round: number,
                  is_final: final === "unknown" ? undefined : final === "yes",
                }
              : {}),
            ...(stage === "assessment"
              ? { assessment_type: assessmentType }
              : {}),
          },
          key,
        );
      }}
    >
      <p className="font-medium">
        {row.companyName} · {row.jobTitle}
      </p>
      <p>当前：{progressLabel(row)}</p>
      {row.progress?.summary && (
        <p className="text-sm text-muted">
          {row.progress.summary}
        </p>
      )}
      {!!Object.keys(options).length && (
        <Choice
          label={correction ? "修正为" : "下一步"}
          value={choice}
          options={options}
          onChange={setChoice}
        />
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="ghost"
          onPress={() => {
            setMore((v) => !v);
            setChoice("");
          }}
        >
          {more ? "常用阶段" : "更多阶段"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onPress={() => {
            setCorrection((v) => !v);
            setChoice("");
          }}
        >
          {correction ? "取消修正" : "修正已记录状态"}
        </Button>
      </div>
      {stage === "interview" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="本轮轮次（不确定可留空）"
            type="number"
            value={round}
            onChange={setRound}
            description={
              choice === "next_interview" && row.progress?.round
                ? `留空将记录第 ${row.progress.round + 1} 轮`
                : "仅在明确知道时填写"
            }
          />
          <Choice
            label="是否终面"
            value={final}
            options={{ unknown: "未说明", no: "普通面试", yes: "终面" }}
            onChange={setFinal}
          />
        </div>
      )}
      {stage === "assessment" && (
        <div className="space-y-2">
          <Choice
            label="测评邀请"
            value={assessmentType}
            onChange={setAssessmentType}
            options={{
              unknown: "待确认 · 暂不计入推进",
              automatic: "自动发放 · 不计入推进",
              screened: "筛选后发放 · 计入推进",
              owner_confirmed: "已核对 · 计入推进",
            }}
          />
          <p className="text-sm text-muted">
            在线笔试、游戏和录播题统一记为在线测评；自动发放不计入有效推进。HR 沟通记为 HR 面试，其他面试按轮次记录。
          </p>
        </div>
      )}
      {!!choice && (
        <Field
          label="备注（可选）"
          value={summary}
          maxLength={300}
          onChange={setSummary}
        />
      )}
      <div className="space-y-3">
        <p className="font-medium">变更历史</p>
        {historyError && (
          <p className="text-danger">历史暂时无法读取，请重新打开。</p>
        )}
        {loadingHistory && <p className="text-muted">正在读取变更历史…</p>}
        {!loadingHistory && !history.length && !historyError && (
          <p className="text-muted">
            尚无后续变更记录。已有状态保留，未推断面试轮次。
          </p>
        )}
        {[...history].reverse().map((event, i) => (
          <div key={i} className="border-b border-separator py-2 text-sm">
            <p>
              {chineseProgress(event.from_label || event.from)} → {chineseProgress(event.to_label || event.to)}
              {!event.applied ? "（仅保留记录，未改变当前状态）" : ""}
            </p>
            <p className="text-muted">
              {event.observed_at
                ? new Date(event.observed_at * 1000).toLocaleString("zh-CN")
                : "时间未记录"}{" "}
              · {event.source === "email" ? "邮件" : "手动更新"}
            </p>
            {event.summary && <p>{event.summary}</p>}
          </div>
        ))}
      </div>
    </Dialog>
  );
}
