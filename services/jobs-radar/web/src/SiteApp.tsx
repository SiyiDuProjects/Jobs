import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
} from "react";
import { Button, Spinner } from "@heroui/react";
import { Segment } from "@heroui-pro/react";
import {
  JobWorkspace,
  readKind,
  type BoardProps,
  type JobKind,
} from "./JobWorkspace";
import brand from "../../config/brand.json";
import { ErrorBoundary, Management } from "./manage/main";
import { store, useManagement } from "./manage/store";
import { CLIENT_PROTOCOL_HEADERS } from "./client-protocol";
import { profileForKind } from "./manage/kind-profiles";

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

export function SiteApp({ Board }: { Board: ComponentType<BoardProps> }) {
  const { draftDirty, pending, unsaved, docs, current, profiles, loading } =
    useManagement();
  const [kind, setKind] = useState<JobKind>(readKind);
  const [query, setQuery] = useState("");
  const [route, setRoute] = useState(
    location.hash.slice(1).split("?")[0] ||
      (location.pathname === "/trash" ? "/trash" : "/"),
  );
  const activeRoute = useRef(route);
  activeRoute.current = route;
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
    const update = () => {
      const next = location.hash.slice(1).split("?")[0] || "/";
      if (store.state.draftDirty && next !== activeRoute.current) {
        history.replaceState(null, "", "#" + activeRoute.current);
        store.report(Error("请先保存或撤销资料更改"));
        return;
      }
      setRoute(next);
    };
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
  useEffect(() => {
    if (!session?.authenticated) return;
    void store.start(
      { authenticated: true },
      ["/applied", "/applications"].includes(activeRoute.current),
      kind,
    );
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
  }, [session?.authenticated]);
  useEffect(() => {
    store.setApplicationsVisible(["/applied", "/applications"].includes(route));
  }, [route]);
  const boundProfileId = profileForKind(
    kind,
    profiles,
    docs.jobsKindProfiles?.value,
  );
  useEffect(() => {
    localStorage.setItem("radar-kind", kind);
    if (loading || pending || unsaved || draftDirty) return;
    if (boundProfileId !== current?.id)
      void store.selectProfile(boundProfileId).catch(store.report);
  }, [
    kind,
    loading,
    boundProfileId,
    current?.id,
    pending,
    unsaved,
    draftDirty,
  ]);
  const links = [
    ["/", "岗位"],
    ["/profile", "资料"],
    ["/settings", "设置"],
  ];
  return (
    <div className="site-shell mx-auto max-w-[1440px] px-4 py-5 sm:px-8 sm:py-6">
      <header className="site-header">
        <a href="#/" className="text-xl font-semibold tracking-tight">
          {brand.name}
        </a>
        <nav
          aria-label="jobs 主导航"
          className="site-nav"
        >
          {links.map(([path, label]) => {
            const selected =
              path === "/"
                ? ["/", "/applied", "/applications", "/trash"].includes(route)
                : route.startsWith(path.split("/").slice(0, 2).join("/"));
            return (
              <Button
                key={path}
                variant={selected ? "secondary" : "ghost"}
                size="sm"
                isDisabled={pending > 0 || draftDirty}
                aria-current={selected ? "page" : undefined}
                onPress={() => {
                  location.hash = path;
                }}
              >
                {label}
              </Button>
            );
          })}
        </nav>
        {session?.authenticated && (
          <Segment
            aria-label="岗位类型"
            selectedKey={kind}
            isDisabled={pending > 0 || store.state.unsaved > 0 || draftDirty}
            onSelectionChange={(v) => {
              if (v === "newgrad" || v === "internship") setKind(v);
            }}
          >
            <Segment.Item id="newgrad">全职</Segment.Item>
            <Segment.Item id="internship">实习</Segment.Item>
          </Segment>
        )}
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
          <section className="mx-auto my-16 flex max-w-md flex-col gap-5">
            <h1>连接你的 jobs</h1>
            <p className="text-muted">
              把连接码发给有服务器访问权限的助手，批准这次浏览器登录。
              岗位、投递记录和个人资料共用这次登录。
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
            {["/", "/applied", "/applications", "/trash"].includes(route) ? (
              <JobWorkspace
                Board={Board}
                kind={kind}
                route={route}
                query={query}
                setQuery={setQuery}
              />
            ) : (
              <Management route={route} kind={kind} />
            )}
          </ErrorBoundary>
        )}
      </main>
    </div>
  );
}
