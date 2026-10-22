import { useState } from "react";
import { Button } from "@heroui/react";
import { Choice, Dialog, Field } from "./components";
import { dateLabel } from "./application-format";
import { safeHref, type Application, type ProgressReview } from "./model";
import { store } from "./store";

export function ProgressReviews({
  reviews,
  applications,
  onClose,
}: {
  reviews: ProgressReview[];
  applications: Application[];
  onClose: () => void;
}) {
  const [review, setReview] = useState<ProgressReview | null>(null);
  const [selected, setSelected] = useState("");
  const [search, setSearch] = useState("");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const candidateIds = new Set(review?.candidates?.map((row) => row.id) || []);
  const matching = applications.filter(
    (row) =>
      row.id &&
      (row.id === selected ||
        candidateIds.has(row.id) ||
        (search.trim() &&
          `${row.companyName} ${row.jobTitle}`
            .toLowerCase()
            .includes(search.trim().toLowerCase()))),
  );
  return (
    <Dialog
      title="待确认的招聘进展"
      onClose={onClose}
      saveLabel="确认对应申请"
      onSave={
        review
          ? async () => {
              const row = applications.find((row) => row.id === selected);
              if (!row) throw Error("请选择这封邮件对应的申请");
              await store.resolveProgressReview(review.job_id, row, key);
            }
          : undefined
      }
    >
      {review ? (
        <>
          <div className="space-y-2">
            <p className="font-medium">
              {review.companyName || "公司未标明"} ·{" "}
              {review.label || review.stage}
            </p>
            <p>{review.summary || "邮件中未记录摘要"}</p>
            <p className="text-sm text-muted">
              收到时间：
              {dateLabel(new Date(review.received_at * 1000).toISOString())}
            </p>
            {safeHref(review.email_url || "") && (
              <a
                className="text-accent"
                href={safeHref(review.email_url || "")!}
                target="_blank"
                rel="noreferrer"
              >
                查看原邮件
              </a>
            )}
          </div>
          <p className="text-sm text-muted">
            核对邮件与申请后确认。系统会保留原邮件来源和收到时间。
          </p>
          <Field label="搜索其他申请" value={search} onChange={setSearch} />
          <Choice
            label="对应申请"
            value={selected}
            onChange={setSelected}
            options={Object.fromEntries(
              matching.map((row) => [
                row.id!,
                `${row.companyName} · ${row.jobTitle}（${row.kind === "newgrad" ? "全职" : row.kind === "internship" ? "实习" : "未分类"}，${dateLabel(row.date)}）`,
              ]),
            )}
          />
          {!matching.length && (
            <p className="text-muted">没有候选申请，请按公司或岗位搜索。</p>
          )}
          <Button
            variant="ghost"
            onPress={() => {
              setReview(null);
              setSelected("");
              setSearch("");
            }}
          >
            返回待确认列表
          </Button>
        </>
      ) : (
        <div className="space-y-3">
          {!reviews.length && <p>没有待确认的招聘进展。</p>}
          {reviews.map((item) => (
            <div
              className="flex items-start justify-between gap-4 border-b border-separator pb-3"
              key={item.job_id}
            >
              <div>
                <p>
                  {item.companyName || "公司未标明"} ·{" "}
                  {item.label || item.stage}
                </p>
                <p className="text-sm text-muted">{item.summary}</p>
              </div>
              <Button
                size="sm"
                variant="secondary"
                onPress={() => {
                  setReview(item);
                  setSelected("");
                  setSearch("");
                  setKey(crypto.randomUUID());
                }}
              >
                核对
              </Button>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}
