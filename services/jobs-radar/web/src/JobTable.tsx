import React, { useState } from "react";
import { useManagement } from "./manage/store";
import { appRows, progressLabel, type AppRow } from "./manage/model";
import { ProgressEditor } from "./manage/application-editors";
import { Button, Chip, Table } from "@heroui/react";
import {
  date,
  safe,
  statusColor,
  names,
  screenings,
  type Job,
  type Recent,
  type UndoTarget,
} from "./job-board-model";
import type { JobKind } from "./JobWorkspace";
export function JobTable({
  data,
  trash,
  kind,
  filters,
  saving,
  restore,
  trackOpened,
  submission,
  undoSubmission,
  open,
}: {
  data: { jobs: Job[] };
  trash: boolean;
  kind: JobKind;
  filters: { added_date: string };
  saving: boolean;
  restore: (job: Job) => unknown;
  trackOpened: (job: Recent, dismiss?: boolean) => unknown;
  submission: (job: Recent) => unknown;
  undoSubmission: (job: UndoTarget) => unknown;
  open: (type: "trash", job: Job) => unknown;
}) {
  const { docs } = useManagement();
  const applications = appRows(docs.appliedList?.value || []);
  const rows = data.jobs.map(job => ({...job, record: applications.find(r => r.job_id === job.id || r.job?.id === job.id)}));
  const [progress, setProgress] = useState<AppRow | null>(null);
  return (
    <section className="job-section" aria-label="岗位列表">
      <Table>
        <Table.ScrollContainer>
          <Table.Content
            aria-label={
              trash
                ? "回收站岗位列表"
                : kind === "newgrad"
                  ? "全职岗位列表"
                  : "实习岗位列表"
            }
            className="job-table"
          >
            <Table.Header>
              <Table.Column id="company" isRowHeader>
                公司
              </Table.Column>
              <Table.Column id="role">岗位</Table.Column>
              <Table.Column id="location">地点</Table.Column>
              <Table.Column id="date">
                {filters.added_date ? "收录" : "发布"}
              </Table.Column>
              <Table.Column id="state">
                {trash ? "删除原因" : "状态"}
              </Table.Column>
              <Table.Column id="actions">操作</Table.Column>
            </Table.Header>
            <Table.Body items={rows}>
              {(job) => (
                <Table.Row
                  id={job.id}
                  className={
                    job.status === "submitted" ? "job-submitted" : undefined
                  }
                >
                  <Table.Cell>
                    <strong>
                      {job.group === "faang" && (
                        <span
                          className="company-fire"
                          role="img"
                          aria-label="来源标记 FAANG+"
                          title="来源标记 FAANG+；重点地区筛选中美国境内不限州"
                        >
                          🔥
                        </span>
                      )}
                      {job.company}
                    </strong>
                  </Table.Cell>
                  <Table.Cell>
                    <div className="role">{job.title}</div>
                    <div className="source text-muted">
                      {job.sources.map((s) => names[s] || s).join(" · ")}
                    </div>
                  </Table.Cell>
                  <Table.Cell>
                    <div
                      className="locations"
                      title={job.locations.join(" · ")}
                    >
                      {job.locations.slice(0, 2).join(" · ") || "地点待核实"}
                      {job.locations.length > 2
                        ? " +" + (job.locations.length - 2)
                        : ""}
                    </div>
                  </Table.Cell>
                  <Table.Cell>
                    <span className="date">
                      {date(filters.added_date ? job.added_at : job.posted_at)}
                    </span>
                  </Table.Cell>
                  <Table.Cell>
                    {trash ? (
                      <>
                        <div>{job.review?.detail}</div>
                        <small className="text-muted">
                          剩余{" "}
                          {Math.max(
                            0,
                            Math.ceil(
                              ((job.review?.expires_at || 0) -
                                Date.now() / 1000) /
                                3600,
                            ),
                          )}{" "}
                          小时
                        </small>
                        {job.review?.evidence?.map((e, i) => (
                          <a
                            className="evidence"
                            key={i}
                            title={e.quote}
                            href={safe(e.url)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            依据 ↗
                          </a>
                        ))}
                      </>
                    ) : (
                      <>
                        {job.record ? (
                          <Button size="sm" variant="ghost" className="application-status" onPress={() => setProgress(job.record!)}>
                            {progressLabel(job.record!)}
                          </Button>
                        ) : <Chip
                          size="sm"
                          variant="soft"
                          className="application-status"
                          color={statusColor(job)}
                        >
                          <span aria-hidden="true">
                            {job.status === "submitted" ? "✓" : ""}
                          </span>
                          <Chip.Label>
                            {job.status === "submitted" ? "已投递" : "未投递"}
                          </Chip.Label>
                        </Chip>}
                        <div
                          className="screening text-muted"
                          title={job.review?.detail}
                        >
                          {job.review?.manual_keep
                            ? "人工保留"
                            : screenings[job.screening]}
                        </div>
                      </>
                    )}
                  </Table.Cell>
                  <Table.Cell>
                    <div className="actions">
                      {trash ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          isDisabled={saving}
                          onPress={() => restore(job)}
                        >
                          恢复
                        </Button>
                      ) : (
                        <>
                          {safe(job.apply_url || job.source_url) && (
                            <a
                              data-jobs-id={job.id}
                              data-jobs-kind={
                                kind === "internship" ? "intern" : "newgrad"
                              }
                              className={
                                "apply " +
                                (job.status === "submitted"
                                  ? "apply-completed"
                                  : "")
                              }
                              href={safe(job.apply_url || job.source_url)}
                              target="_blank"
                              rel="noreferrer"
                              onClick={() => {
                                if (job.status !== "submitted")
                                  void trackOpened(job);
                              }}
                              onAuxClick={(e) => {
                                if (
                                  e.button === 1 &&
                                  job.status !== "submitted"
                                )
                                  void trackOpened(job);
                              }}
                            >
                              {job.status === "submitted" ? "查看岗位" : "申请"}{" "}
                              ↗
                            </a>
                          )}
                          {job.status !== "submitted" && (
                            <Button
                              size="sm"
                              variant="secondary"
                              isDisabled={saving}
                              onPress={() => submission(job)}
                            >
                              标记已投递
                            </Button>
                          )}
                          {job.can_undo_submission && (
                            <Button
                              size="sm"
                              variant="ghost"
                              isDisabled={saving}
                              onPress={() =>
                                undoSubmission({
                                  id: job.id,
                                  version: job.application_version,
                                })
                              }
                            >
                              撤销
                            </Button>
                          )}
                          {job.status === "not_started" && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="delete-job"
                              onPress={() => open("trash", job)}
                            >
                              删除
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  </Table.Cell>
                </Table.Row>
              )}
            </Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>
      {progress && <ProgressEditor row={progress} onClose={() => setProgress(null)} />}
    </section>
  );
}
