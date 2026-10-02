import { useCallback, useEffect, useState, type ComponentType } from "react";
import { Button, Spinner } from "@heroui/react";
import brand from "../../config/brand.json";
import { ErrorBoundary, Management } from "./manage/main";
import { useManagement } from "./manage/store";
import { CLIENT_PROTOCOL_HEADERS } from "./client-protocol";

// Old extension links enter the same website and retain their requested view.
if (
  location.pathname === "/manage" ||
  location.pathname.startsWith("/manage/")
) {
  const previous = location.hash.slice(1);
  history.replaceState(
    null,
    "",
    "/" +
      location.search +
      "#" +
      (previous && previous !== "/" ? previous : "/applications"),
  );
}

export function SiteApp({ Board }: { Board: ComponentType }) {
  const { pending } = useManagement();
  const [route, setRoute] = useState(
    location.hash.slice(1).split("?")[0] || "/",
  );
  const [session, setSession] = useState<{
    authenticated: boolean;
    request_id?: string;
  }>();
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const connect = useCallback(async () => {
    try {
      const response = await fetch("/api/session", {
        credentials: "same-origin",
        headers: CLIENT_PROTOCOL_HEADERS,
      });
      if (!response.ok) throw Error("暂时无法连接，请重试");
      setSession(await response.json());
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    const update = () => setRoute(location.hash.slice(1).split("?")[0] || "/");
    window.addEventListener("hashchange", update);
    void connect();
    return () => window.removeEventListener("hashchange", update);
  }, [connect]);
  useEffect(() => {
    if (session?.authenticated === false) {
      const timer = setInterval(connect, 5000);
      return () => clearInterval(timer);
    }
  }, [session?.authenticated, connect]);
  const trash = location.pathname === "/trash";
  const links = [
    ["/", "岗位列表"],
    ["/applications", "投递记录"],
    ["/profile", "个人资料"],
    ["/settings/autofill", "设置"],
  ];
  return (
    <div className="workspace">
      <header className="header flex-wrap">
        <a href={trash ? "/" : "#/"} className="brand">
          {brand.name}
        </a>
        <nav
          aria-label="jobs 主导航"
          className="flex flex-wrap items-center gap-1"
        >
          {links.map(([path, label]) => {
            const selected =
              !trash &&
              (path === "/"
                ? route === "/"
                : route.startsWith(path.split("/").slice(0, 2).join("/")));
            return (
              <Button
                key={path}
                variant={selected ? "secondary" : "ghost"}
                size="sm"
                isDisabled={pending > 0}
                aria-current={selected ? "page" : undefined}
                onPress={() => {
                  if (trash) location.href = "/#" + path;
                  else location.hash = path;
                }}
              >
                {label}
              </Button>
            );
          })}
        </nav>
        <a className={"recycle " + (trash ? "current" : "")} href="/trash">
          回收站
        </a>
      </header>
      <main>
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
        {!session ? (
          <div className="py-20 flex justify-center">
            <Spinner aria-label="正在连接 jobs" />
          </div>
        ) : !session.authenticated ? (
          <section className="login">
            <h1>连接你的 jobs</h1>
            <p className="text-muted">
              把连接码发给已连接 {brand.name}{" "}
              的助手，批准这个浏览器。岗位、投递记录和个人资料共用这次登录。
            </p>
            <code>{session.request_id || "正在连接…"}</code>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                onPress={async () => {
                  try {
                    await navigator.clipboard.writeText(
                      session.request_id || "",
                    );
                    setCopied(true);
                  } catch {
                    setError("请选中连接码复制");
                  }
                }}
              >
                {copied ? "已复制" : "复制连接码"}
              </Button>
              <Button onPress={connect}>已批准，进入</Button>
            </div>
          </section>
        ) : (
          <ErrorBoundary>
            {route === "/" || trash ? <Board /> : <Management route={route} />}
          </ErrorBoundary>
        )}
      </main>
    </div>
  );
}
