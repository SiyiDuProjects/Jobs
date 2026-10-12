import React, { useEffect, useRef, useState } from "react";
import { Button, Card, Chip, Switch } from "@heroui/react";
import { createPanelController } from "./panel-controller.js";
import { createReviewView } from "./review-view.js";

export function PanelProgress() {
  const [state, setState] = useState({ text: "正在读取投递状态…" });
  const [error, setError] = useState("");
  const container = useRef(null);
  useEffect(() => {
    const view = createReviewView();
    view.attach(container.current, container.current, () => {});
    const controller = createPanelController(chrome, (next) => {
      setState(next);
      setError("");
      view.show(next.review?.data || null, next.act);
    });
    void controller.start();
    return () => {
      controller.dispose();
      view.show(null);
    };
  }, []);
  async function act(action) {
    try {
      await state.statusAction?.(action);
    } catch (error) {
      setError(error.message);
    }
  }
  return (
    <section className="popup-section" aria-label="本页进度">
      <Card>
        <Card.Header className="panel-progress-heading">
          <Card.Title>本页进度</Card.Title>
          {state.review && (
            <Chip size="sm" color="accent">
              待确认
            </Chip>
          )}
        </Card.Header>
        <Card.Content>
          {state.operator && (
            <Switch
              isSelected={state.operator.mode !== "person"}
              onChange={(selected) =>
                void state
                  .setOperator(selected ? "agent" : "person")
                  .catch((error) => setError(error.message))
              }
            >
              <Switch.Content>
                AI 操作中
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch.Content>
            </Switch>
          )}
          {state.operator?.mode !== "person" && state.operator && (
            <p className="popup-detail">
              AI 填写的内容不会记为你的回答。亲自接手时关闭此开关。
            </p>
          )}
          <p id="jobs-panel-status" role="status" className="popup-detail">
            {state.text}
          </p>
          {state.status?.canFill && !state.review && (
            <Button
              size="sm"
              variant="secondary"
              onPress={() => void act("draft")}
            >
              准备本页回答
            </Button>
          )}
          {state.status?.dismissible && (
            <div className="panel-actions">
              {state.status.canRestore && (
                <Button
                  size="sm"
                  variant="secondary"
                  onPress={() => void act("restore")}
                >
                  恢复岗位
                </Button>
              )}
              <Button
                size="sm"
                variant="secondary"
                onPress={() => void act("dismiss")}
              >
                关闭提示
              </Button>
            </div>
          )}
          {error && (
            <p role="alert" className="popup-hint" data-error="true">
              {error}
            </p>
          )}
        </Card.Content>
      </Card>
      <div ref={container} id="jobs-panel-review" />
    </section>
  );
}
