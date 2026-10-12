import type { ReactNode } from "react";
import { Accordion, Button, Table, Tooltip } from "@heroui/react";

export type JobListRow = {
  id: string;
  company: string;
  title: string;
  locations: string[];
  date: string;
  badge?: ReactNode;
  extra?: ReactNode;
  details?: ReactNode;
  source?: string;
  actions: ReactNode;
  onOpen?: () => void;
};

function Location({ locations }: { locations: string[] }) {
  return (
    <span className="job-location" title={locations.join(" · ")}>
      <span className="truncate">{locations[0] || "地点待核实"}</span>
      {locations.length > 1 && (
        <span className="shrink-0 text-muted">+{locations.length - 1}</span>
      )}
    </span>
  );
}

// All three views share column geometry, typography and mobile disclosure.
export function JobList({
  rows,
  label,
  dateLabel,
  extraLabel,
  empty,
}: {
  rows: JobListRow[];
  label: string;
  dateLabel: string;
  extraLabel?: string;
  empty: string;
}) {
  return (
    <section className="job-list" aria-label={label}>
      <div className="job-list-desktop">
        <Table className="job-table">
          <Table.Content aria-label={label} className="job-table-content">
            <Table.Header>
              <Table.Column
                id="company"
                className="job-company-column"
                isRowHeader
              >
                公司
              </Table.Column>
              <Table.Column id="title">岗位</Table.Column>
              <Table.Column id="location" className="job-location-column">
                地点
              </Table.Column>
              <Table.Column id="date" className="job-date-column">
                {dateLabel}
              </Table.Column>
              {extraLabel ? (
                <Table.Column id="extra" className="job-extra-column">
                  {extraLabel}
                </Table.Column>
              ) : null}
              <Table.Column id="actions" className="job-actions-column">
                操作
              </Table.Column>
            </Table.Header>
            <Table.Body items={rows} renderEmptyState={() => empty}>
              {(row) => (
                <Table.Row id={row.id}>
                  <Table.Cell>
                    <span
                      className="block truncate font-medium"
                      title={row.company}
                    >
                      {row.company}
                    </span>
                  </Table.Cell>
                  <Table.Cell>
                    <div className="job-title-cell">
                      <Tooltip delay={300}>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="job-title-button"
                          onPress={row.onOpen}
                          aria-label={`查看岗位详情：${row.title}`}
                        >
                          <span className="truncate">{row.title}</span>
                        </Button>
                        <Tooltip.Content className="max-w-sm whitespace-normal">
                          <p>{row.title}</p>
                          {row.source && (
                            <p className="mt-1 text-muted">{row.source}</p>
                          )}
                        </Tooltip.Content>
                      </Tooltip>
                      {row.badge}
                    </div>
                  </Table.Cell>
                  <Table.Cell>
                    <Location locations={row.locations} />
                  </Table.Cell>
                  <Table.Cell>
                    <span className="job-date">{row.date}</span>
                  </Table.Cell>
                  {extraLabel ? (
                    <Table.Cell>
                      <div className="job-extra">{row.extra}</div>
                    </Table.Cell>
                  ) : null}
                  <Table.Cell>
                    <div className="job-row-actions">{row.actions}</div>
                  </Table.Cell>
                </Table.Row>
              )}
            </Table.Body>
          </Table.Content>
        </Table>
      </div>
      <div className="job-list-mobile">
        {!rows.length && <p className="list-empty">{empty}</p>}
        <Accordion aria-label={label} className="job-mobile-items">
          {rows.map((row) => (
            <Accordion.Item id={row.id} key={row.id}>
              <Accordion.Heading>
                <Accordion.Trigger
                  className="job-mobile-trigger"
                  aria-label={`${row.company} · ${row.title}`}
                >
                  <span className="job-mobile-lines">
                    <span className="job-mobile-title">
                      <strong>{row.company}</strong>
                      <span aria-hidden="true">·</span>
                      <span className="truncate">{row.title}</span>
                    </span>
                    <span className="job-mobile-meta">
                      <Location locations={row.locations} />
                      <span aria-hidden="true">·</span>
                      <span className="job-date">{row.date}</span>
                      {row.badge}
                      {row.extra && (
                        <span className="job-mobile-extra">{row.extra}</span>
                      )}
                    </span>
                  </span>
                  <Accordion.Indicator />
                </Accordion.Trigger>
              </Accordion.Heading>
              <Accordion.Panel>
                <Accordion.Body className="job-mobile-detail">
                  <p className="font-medium">{row.title}</p>
                  {row.locations.length > 1 && (
                    <p className="text-muted">{row.locations.join(" · ")}</p>
                  )}
                  {row.source && <p className="text-muted">{row.source}</p>}
                  {row.details}
                  <div className="job-row-actions">{row.actions}</div>
                </Accordion.Body>
              </Accordion.Panel>
            </Accordion.Item>
          ))}
        </Accordion>
      </div>
    </section>
  );
}
