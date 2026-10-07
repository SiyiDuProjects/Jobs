import React, { useEffect, useRef, useState } from "react";
import { Button, Card, Chip } from "@heroui/react";
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
    <section className="popup-section" aria-label="投递进度">
      <Card variant="secondary">
        <Card.Header className="panel-progress-heading">
          <Card.Title>投递进度</Card.Title>
          {state.review && (
            <Chip size="sm" color="accent">
              待确认
            </Chip>
          )}
        </Card.Header>
        <Card.Content>
          <p id="jobs-panel-status" role="status" className="popup-detail">
            {state.text}
          </p>
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
                variant="ghost"
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
