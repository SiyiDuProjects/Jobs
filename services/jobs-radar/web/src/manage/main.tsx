import { Component, type ReactNode } from "react";
import { Button, Card, Spinner } from "@heroui/react";
import type { JobKind } from "../JobWorkspace";
import { NewProfile, Profile } from "./Profile";
import { Settings } from "./Settings";
import { store, useManagement } from "./store";

export function Management({ route, kind }: { route: string; kind: JobKind }) {
  const state = useManagement();
  return (
    <>
      {state.authenticated && (state.pending > 0 || state.unsaved > 0) && (
        <div className="pb-6 flex flex-wrap items-center gap-4 text-sm">
          <span role="status" className="text-muted">
            {state.pending ? "正在保存…" : ""}
          </span>
          {state.unsaved > 0 && (
            <Button
              variant="secondary"
              isDisabled={state.pending > 0}
              onPress={() => {
                void store.retryFailed().catch(store.report);
              }}
            >
              重试未保存更改
            </Button>
          )}
        </div>
      )}
      <section className="space-y-6" aria-label="投递管理">
        {state.error && (
          <Card>
            <Card.Content>
              <div
                role="alert"
                className="flex justify-between items-start gap-4 text-danger"
              >
                <p>{state.error}</p>
                <Button variant="ghost" onPress={store.clearError}>
                  关闭
                </Button>
              </div>
            </Card.Content>
          </Card>
        )}
        {state.loading ? (
          <div className="py-20 flex justify-center">
            <Spinner aria-label="正在读取资料" />
          </div>
        ) : !state.authenticated ? (
          <Card>
            <Card.Content>
              请先在{" "}
              <a href="/" className="text-accent">
                jobs 岗位页
              </a>{" "}
              登录，再打开投递管理。
            </Card.Content>
          </Card>
        ) : route === "/profile/new" ? (
          <NewProfile />
        ) : route.startsWith("/profile") ? (
          <Profile kind={kind} />
        ) : route.startsWith("/settings") ? (
          <Settings
            route={route === "/settings" ? "/settings/autofill" : route}
          />
        ) : (
          <Profile kind={kind} />
        )}
      </section>
    </>
  );
}
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: boolean }
> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? (
      <main className="max-w-xl mx-auto p-8">
        <Card>
          <Card.Header>
            <Card.Title>页面加载失败</Card.Title>
          </Card.Header>
          <Card.Content>服务器上的数据未更改。请刷新后重试。</Card.Content>
          <Card.Footer>
            <Button onPress={() => location.reload()}>刷新</Button>
          </Card.Footer>
        </Card>
      </main>
    ) : (
      this.props.children
    );
  }
}
