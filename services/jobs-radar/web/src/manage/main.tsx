import { Component, useEffect, type ReactNode } from "react";
import { Button, Card, Spinner } from "@heroui/react";
import { Applications } from "./Applications";
import { NewProfile, Profile } from "./Profile";
import { Settings } from "./Settings";
import { Choice } from "./components";
import { store, useManagement } from "./store";

export function Management({ route }: { route: string }) {
  const state = useManagement();
  useEffect(() => {
    void store.start({ authenticated: true });
    const before = (e: BeforeUnloadEvent) => {
      if (store.state.pending || store.state.unsaved) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", before);
    return () => {
      store.stop();
      window.removeEventListener("beforeunload", before);
    };
  }, []);
  return (
    <>
      {state.authenticated && (
        <div className="pb-6 flex flex-wrap items-center gap-4 text-sm">
          {state.profiles.length > 0 && (
            <div className="w-40">
              <Choice
                label="当前资料"
                hideLabel
                value={state.current?.id}
                disabled={state.pending > 0}
                options={Object.fromEntries(
                  state.profiles.map((p) => [p.id, p.profileName]),
                )}
                onChange={(id) => {
                  void store
                    .selectProfile(id)
                    .then(() => {
                      location.hash = "/profile";
                    })
                    .catch(store.report);
                }}
              />
            </div>
          )}
          <span role="status" className="text-muted">
            {state.pending ? "正在保存…" : state.notice}
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
                  Dismiss
                </Button>
              </div>
            </Card.Content>
          </Card>
        )}
        {state.loading ? (
          <div className="py-20 flex justify-center">
            <Spinner aria-label="Loading management" />
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
          <Profile key={state.current?.id} />
        ) : route.startsWith("/settings") ? (
          <Settings
            route={route === "/settings" ? "/settings/autofill" : route}
          />
        ) : (
          <Applications />
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
            <Button onPress={() => location.reload()}>Reload</Button>
          </Card.Footer>
        </Card>
      </main>
    ) : (
      this.props.children
    );
  }
}
