import React, { useState } from "react";
import {
  Button,
  Chip,
  Dropdown,
  Label,
  Modal,
  Table,
  Tooltip,
  buttonVariants,
} from "@heroui/react";
import {
  date,
  safe,
  names,
  type Job,
  type UndoTarget,
} from "./job-board-model";
import type { JobKind } from "./JobWorkspace";

const sources = (job: Job) =>
  job.sources.map((source) => names[source] || source).join(" · ");

function JobStatus({ job }: { job: Job }) {
  if (job.status === "submitted")
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-success">
        <span aria-hidden="true">✓</span>已投递
      </span>
    );
  if (job.review?.manual_keep || !["pending", "review"].includes(job.screening))
    return null;
  return (
    <Chip
      size="sm"
      variant="soft"
      color={job.screening === "review" ? "warning" : "default"}
      className="whitespace-nowrap"
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
  filters,
  saving,
  restore,
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
  submission: (job: Job) => unknown;
  undoSubmission: (job: UndoTarget) => unknown;
  open: (type: "trash", job: Job) => unknown;
}) {
  const [detail, setDetail] = useState<Job | null>(null);
  return (
    <section className="job-list mb-5" aria-label="岗位列表">
      <p className="job-list-scroll-hint mb-2 text-xs text-muted">
        左右滑动查看完整岗位
      </p>
      <Table className="job-table">
        <Table.ScrollContainer aria-label="岗位表格，可左右滚动" tabIndex={0}>
          <Table.Content
            aria-label={
              trash
                ? "回收站岗位列表"
                : kind === "newgrad"
                  ? "全职岗位列表"
                  : "实习岗位列表"
            }
            className="job-table-content"
          >
            <Table.Header>
              <Table.Column
                id="company"
                className="job-company-column"
                isRowHeader
              >
                公司
              </Table.Column>
              <Table.Column id="role" className="job-title-column">
                标题
              </Table.Column>
              <Table.Column id="location" className="job-location-column">
                地点
              </Table.Column>
              <Table.Column id="date" className="job-date-column">
                {filters.added_date ? "收录日期" : "发布日期"}
              </Table.Column>
              <Table.Column id="state" className="job-state-column">
                {trash ? "删除原因" : "状态"}
              </Table.Column>
              <Table.Column id="actions" className="job-actions-column">
                操作
              </Table.Column>
            </Table.Header>
            <Table.Body items={data.jobs}>
              {(job) => (
                <Table.Row id={job.id}>
                  <Table.Cell>
                    <strong
                      className="block truncate font-medium"
                      title={job.company}
                    >
                      {job.company}
                    </strong>
                  </Table.Cell>
                  <Table.Cell>
                    <Tooltip delay={350}>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="job-title-button w-full min-w-0 justify-start px-0"
                        onPress={() => setDetail(job)}
                        aria-label={`查看岗位详情：${job.title}`}
                      >
                        <span className="truncate">{job.title}</span>
                      </Button>
                      <Tooltip.Content className="max-w-sm whitespace-normal break-normal">
                        <p className="font-medium">{job.title}</p>
                        <p className="mt-1 text-muted">
                          来源：{sources(job)}
                          {job.group === "faang" ? " · FAANG+" : ""}
                        </p>
                      </Tooltip.Content>
                    </Tooltip>
                  </Table.Cell>
                  <Table.Cell>
                    <Tooltip delay={350}>
                      <Tooltip.Trigger
                        className="flex w-full min-w-0 items-center gap-1"
                        role={undefined}
                        tabIndex={0}
                      >
                        <span className="truncate">
                          {job.locations[0] || "地点待核实"}
                        </span>
                        {job.locations.length > 1 && (
                          <span className="shrink-0 text-xs tabular-nums text-muted">
                            +{job.locations.length - 1}
                          </span>
                        )}
                      </Tooltip.Trigger>
                      <Tooltip.Content className="max-w-sm whitespace-normal break-normal">
                        {job.locations.join(" · ") || "地点待核实"}
                      </Tooltip.Content>
                    </Tooltip>
                  </Table.Cell>
                  <Table.Cell>
                    <span className="text-xs tabular-nums text-muted">
                      {date(filters.added_date ? job.added_at : job.posted_at)}
                    </span>
                  </Table.Cell>
                  <Table.Cell>
                    {trash ? (
                      <span
                        className="block truncate text-xs text-muted"
                        title={job.review?.detail}
                      >
                        {job.review?.detail || "已删除"}
                      </span>
                    ) : (
                      <JobStatus job={job} />
                    )}
                  </Table.Cell>
                  <Table.Cell>
                    <div className="flex items-center justify-end gap-1">
                      {!trash &&
                        job.status !== "submitted" &&
                        safe(job.apply_url || job.source_url) && (
                          <a
                            data-jobs-id={job.id}
                            data-jobs-kind={
                              kind === "internship" ? "intern" : "newgrad"
                            }
                            className={buttonVariants({
                              size: "sm",
                              variant: "primary",
                            })}
                            href={safe(job.apply_url || job.source_url)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            申请
                          </a>
                        )}
                      <Tooltip>
                        <Dropdown>
                          <Button
                            size="sm"
                            variant="ghost"
                            isIconOnly
                            aria-label={`${job.company} · ${job.title}：更多操作`}
                          >
                            <span
                              aria-hidden="true"
                              className="text-xl leading-none"
                            >
                              ⋯
                            </span>
                          </Button>
                          <Dropdown.Popover placement="bottom end">
                            <Dropdown.Menu
                              aria-label="岗位操作"
                              onAction={(key) => {
                                if (key === "details") setDetail(job);
                                if (key === "submit") submission(job);
                                if (key === "undo")
                                  undoSubmission({
                                    id: job.id,
                                    version: job.application_version,
                                  });
                                if (key === "trash") open("trash", job);
                                if (key === "restore") restore(job);
                              }}
                            >
                              <Dropdown.Item id="details" textValue="岗位详情">
                                <Label>岗位详情</Label>
                              </Dropdown.Item>
                              {trash ? (
                                <Dropdown.Item
                                  id="restore"
                                  textValue="恢复"
                                  isDisabled={saving}
                                >
                                  <Label>恢复</Label>
                                </Dropdown.Item>
                              ) : (
                                <>
                                  {job.status !== "submitted" && (
                                    <Dropdown.Item
                                      id="submit"
                                      textValue="标记已投递"
                                      isDisabled={saving}
                                    >
                                      <Label>标记已投递</Label>
                                    </Dropdown.Item>
                                  )}
                                  {job.can_undo_submission && (
                                    <Dropdown.Item
                                      id="undo"
                                      textValue="撤销"
                                      isDisabled={saving}
                                    >
                                      <Label>撤销</Label>
                                    </Dropdown.Item>
                                  )}
                                  {job.status === "not_started" && (
                                    <Dropdown.Item
                                      id="trash"
                                      textValue="删除"
                                      variant="danger"
                                      isDisabled={saving}
                                    >
                                      <Label>删除</Label>
                                    </Dropdown.Item>
                                  )}
                                </>
                              )}
                            </Dropdown.Menu>
                          </Dropdown.Popover>
                        </Dropdown>
                        <Tooltip.Content>更多操作</Tooltip.Content>
                      </Tooltip>
                    </div>
                  </Table.Cell>
                </Table.Row>
              )}
            </Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>
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
                  {detail.status === "submitted" || trash ? "查看岗位" : "申请"}
                </a>
              )}
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </section>
  );
}
