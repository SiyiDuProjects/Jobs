import { useState } from "react";
import { Button, Chip, Modal, buttonVariants } from "@heroui/react";
import { safe, names, type Job, type UndoTarget } from "./job-board-model";
import type { JobKind } from "./JobWorkspace";
import { JobList } from "./JobList";
import { ActionMenu, type MenuAction } from "./ListControls";
import { listDate as date } from "./list-date";
const sources = (job: Job) =>
  job.sources.map((source) => names[source] || source).join(" · ");
function ScreeningBadge({ job }: { job: Job }) {
  if (job.status === "submitted")
    return (
      <span className="text-success job-badge" aria-label="已投递">
        ✓ 已投递
      </span>
    );
  if (job.review?.manual_keep || !["pending", "review"].includes(job.screening))
    return null;
  return (
    <Chip
      size="sm"
      variant="soft"
      color={job.screening === "review" ? "warning" : "default"}
      className="job-badge"
      title={job.review?.detail}
    >
      <Chip.Label>
        {job.screening === "pending" ? "待初筛" : "待核实"}
      </Chip.Label>
    </Chip>
  );
}
export function JobTable({
  data,
  trash,
  kind,
  saving,
  restore,
  submission,
  undoSubmission,
  open,
}: {
  data: { jobs: Job[] };
  trash: boolean;
  kind: JobKind;
  saving: boolean;
  restore: (job: Job) => unknown;
  submission: (job: Job) => unknown;
  undoSubmission: (job: UndoTarget) => unknown;
  open: (type: "trash", job: Job) => unknown;
}) {
  const [detail, setDetail] = useState<Job | null>(null);
  const rows = data.jobs.map((job) => {
    const items: MenuAction[] = [
      { id: "details", label: "查看详情", onAction: () => setDetail(job) },
    ];
    if (job.status !== "submitted")
      items.push({
        id: "submitted",
        label: "标记已投递",
        disabled: saving,
        onAction: () => {
          void submission(job);
        },
      });
    else if (job.can_undo_submission)
      items.push({
        id: "undo",
        label: "撤销",
        disabled: saving,
        onAction: () => {
          void undoSubmission({ id: job.id, version: job.application_version });
        },
      });
    items.push({
      id: "delete",
      label: "删除",
      danger: true,
      disabled: saving,
      onAction: () => open("trash", job),
    });
    return {
      id: job.id,
      company: job.company,
      title: job.title,
      locations: job.locations,
      date: date(job.added_at),
      source: `来源：${sources(job)}`,
      badge: trash ? undefined : <ScreeningBadge job={job} />,
      extra: trash ? (
        <span title={job.review?.detail}>{job.review?.detail || "已删除"}</span>
      ) : undefined,
      onOpen: () => setDetail(job),
      actions: trash ? (
        <Button
          size="sm"
          variant="secondary"
          isDisabled={saving}
          onPress={() => {
            void restore(job);
          }}
        >
          恢复
        </Button>
      ) : (
        <>
          {job.status !== "submitted" &&
            safe(job.apply_url || job.source_url) && (
              <a
                data-jobs-id={job.id}
                data-jobs-kind={kind === "internship" ? "intern" : "newgrad"}
                className={buttonVariants({ size: "sm", variant: "secondary" })}
                href={safe(job.apply_url || job.source_url)}
                target="_blank"
                rel="noreferrer"
              >
                投递
              </a>
            )}
          <ActionMenu label={`更多操作：${job.title}`} items={items} />
        </>
      ),
    };
  });
  return (
    <section>
      <JobList
        rows={rows}
        label={
          trash
            ? "回收站岗位列表"
            : kind === "newgrad"
              ? "全职岗位列表"
              : "实习岗位列表"
        }
        dateLabel="收录日期"
        extraLabel={trash ? "删除原因" : undefined}
        empty={trash ? "回收站暂无岗位" : "当前筛选下没有岗位"}
      />
      <Modal.Backdrop
        isOpen={!!detail}
        onOpenChange={(open) => {
          if (!open) setDetail(null);
        }}
      >
        <Modal.Container>
          <Modal.Dialog className="sm:max-w-lg">
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>岗位详情</Modal.Heading>
            </Modal.Header>
            {detail && (
              <Modal.Body className="space-y-4 break-words">
                <div>
                  <p className="text-sm text-muted">{detail.company}</p>
                  <h2 className="mt-1 font-semibold">{detail.title}</h2>
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 text-sm">
                  <dt className="text-muted">地点</dt>
                  <dd>{detail.locations.join(" · ") || "地点待核实"}</dd>
                  <dt className="text-muted">来源</dt>
                  <dd>
                    {sources(detail)}
                    {detail.group === "faang" ? " · FAANG+" : ""}
                  </dd>
                  <dt className="text-muted">收录日期</dt>
                  <dd>{date(detail.added_at)}</dd>
                  <dt className="text-muted">发布日期</dt>
                  <dd>{date(detail.posted_at)}</dd>
                </dl>
                {detail.review?.detail && (
                  <p className="text-sm text-muted">{detail.review.detail}</p>
                )}
                {trash && (
                  <p className="text-sm text-muted">
                    剩余{" "}
                    {Math.max(
                      0,
                      Math.ceil(
                        ((detail.review?.expires_at || 0) - Date.now() / 1000) /
                          3600,
                      ),
                    )}{" "}
                    小时可恢复
                  </p>
                )}
                {detail.review?.evidence?.map((e, i) => (
                  <a
                    key={i}
                    className="block text-sm text-accent"
                    title={e.quote}
                    href={safe(e.url)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    依据 {i + 1} ↗
                  </a>
                ))}
              </Modal.Body>
            )}
            <Modal.Footer>
              <Button variant="secondary" onPress={() => setDetail(null)}>
                关闭
              </Button>
              {detail && safe(detail.apply_url || detail.source_url) && (
                <a
                  data-jobs-id={detail.id}
                  data-jobs-kind={kind === "internship" ? "intern" : "newgrad"}
                  className={buttonVariants({ variant: "primary" })}
                  href={safe(detail.apply_url || detail.source_url)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {detail.status === "submitted" || trash ? "查看岗位" : "投递"}
                </a>
              )}
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </section>
  );
}
