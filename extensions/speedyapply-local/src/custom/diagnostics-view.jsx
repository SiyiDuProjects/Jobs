import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Button, Card, Dropdown, Label } from "@heroui/react";
import { NativeSelect } from "@heroui-pro/react";

function More({ items, label }) {
  return (
    <Dropdown>
      <Button size="sm" variant="secondary" isIconOnly aria-label={label}>
        ⋯
      </Button>
      <Dropdown.Popover>
        <Dropdown.Menu
          aria-label={label}
          onAction={(key) => document.getElementById(String(key))?.click()}
        >
          {items.map(([id, text]) => (
            <Dropdown.Item key={id} id={id} textValue={text}>
              <Label>{text}</Label>
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
function Select({ id, label, placeholder }) {
  return (
    <NativeSelect variant="secondary" fullWidth>
      <Label htmlFor={id}>{label}</Label>
      <NativeSelect.Trigger id={id}>
        <NativeSelect.Option value="">{placeholder}</NativeSelect.Option>
      </NativeSelect.Trigger>
      <NativeSelect.Indicator />
    </NativeSelect>
  );
}
export function mountDiagnosticsView() {
  const root = createRoot(document.getElementById("root"));
  flushSync(() =>
    root.render(
      <main className="diagnostics-page">
        <header className="diagnostics-heading">
          <h1>填写记录</h1>
          <Button id="reload" size="sm" variant="secondary">
            重新读取
          </Button>
        </header>
        <p className="diagnostics-muted">
          查看控件识别、填写结果与页面反馈。读取不会填写或提交，导出内容使用脱敏证据。
        </p>
        <p id="sync" role="status" className="diagnostics-muted" />
        <Card>
          <Card.Content>
            <div className="diagnostics-tools">
              <Select id="pages" label="投递页面" placeholder="尚无记录" />
              <Button id="inspect">读取当前状态</Button>
              <More label="诊断更多操作" items={[["export", "导出事件日志"]]} />
            </div>
            <p id="message" role="status" />
            <p id="overview" />
          </Card.Content>
        </Card>
        <Card>
          <Card.Header>
            <Card.Title>失败题库页面</Card.Title>
            <Card.Description>
              页面结构只在题库存一份，失败标记关联本次事件。解决标记不会删除题库页面。
            </Card.Description>
          </Card.Header>
          <Card.Content>
            <div className="diagnostics-tools">
              <Select id="cases" label="已标记页面" placeholder="尚无标记" />
              <Button id="capture-case">标记当前页面失败</Button>
              <More
                label="案例更多操作"
                items={[
                  ["export-case", "导出题库页面"],
                  ["resolve-case", "标记已验证解决"],
                  ["reopen-case", "重新标记失败"],
                ]}
              />
            </div>
            <p id="case-message" role="status" />
          </Card.Content>
        </Card>
        <Card>
          <Card.Header>
            <Card.Title>页面控件与填写结果</Card.Title>
            <Card.Description>
              页面有值不代表网站已接受；未尝试表示未观察到填写动作。
            </Card.Description>
          </Card.Header>
          <Card.Content>
            <div className="diagnostics-table-scroll">
              <table className="table__content">
                <thead className="table__header">
                  <tr>
                    {[
                      "控件",
                      "题目",
                      "类型",
                      "状态",
                      "填写结局",
                      "答案匹配",
                      "动作 / 事件",
                    ].map((label) => (
                      <th key={label} className="table__column">
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody id="fields" />
              </table>
            </div>
          </Card.Content>
        </Card>
        <Card>
          <Card.Header>
            <Card.Title>时间线</Card.Title>
            <Card.Description>
              事件按发生顺序展示，序号用于识别证据缺口。
            </Card.Description>
          </Card.Header>
          <Card.Content>
            <ol id="events" />
          </Card.Content>
        </Card>
        <div hidden>
          {["export", "export-case", "resolve-case", "reopen-case"].map(
            (id) => (
              <Button
                key={id}
                id={id}
                variant="secondary"
                isDisabled={id === "export-case"}
              >
                {id}
              </Button>
            ),
          )}
        </div>
      </main>,
    ),
  );
}
