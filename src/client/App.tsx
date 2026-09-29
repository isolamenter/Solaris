import { useCallback, useEffect, useMemo, useState } from "react";
import type { SessionDto } from "../shared/contracts.js";
import { SolarisApi } from "./api.js";
import { useConnectionCatalog } from "./catalog.js";
import { Connections } from "./Connections.js";
import { ServicesContext, type Services } from "./context.js";
import { describeError, isAuthRequired } from "./display.js";
import { History } from "./History.js";
import { ServerAddress } from "./ServerAddress.js";
import { createSessionProvider, type AppDependencies } from "./session.js";
import { Workspace } from "./Workspace.js";

type Page = "workspace" | "connections" | "history";

const navigation: { id: Page; label: string; index: string }[] = [
  { id: "workspace", label: "Workspace", index: "01" },
  { id: "connections", label: "Connections", index: "02" },
  { id: "history", label: "Run history", index: "03" },
];

/** What this device says about the Server address before anything else runs. */
type StoredServer = { kind: "configured"; origin: string } | { kind: "unset" } | { kind: "unusable"; message: string };

/**
 * Shell. The Server address decides everything below it: one `ServerApp` per
 * configured origin, so switching Server (or account) starts from that Server's
 * own stored session and local scope and never renders the previous one's
 * records.
 */
export function App({ deps }: { deps: AppDependencies }) {
  const [stored, setStored] = useState<StoredServer>(() => readStoredServer(deps));

  // An unusable stored address is never papered over with the build's default:
  // it is shown where it can be corrected.
  const origin =
    stored.kind === "configured" ? stored.origin : stored.kind === "unset" ? deps.defaultServerOrigin : null;
  const problem = stored.kind === "unusable" ? stored.message : null;

  if (origin === null) {
    return (
      <main className="signin">
        <div className="card stack">
          <Brand />
          <h3>Which Server?</h3>
          <p>
            This build has no Server address yet. Enter the absolute address of the Solaris Server this device should talk
            to.
          </p>
          <ServerAddress
            settings={deps.settings}
            current={null}
            defaultOrigin={deps.defaultServerOrigin}
            problem={problem}
            onSaved={(next) => setStored({ kind: "configured", origin: next })}
            onUseDefault={() => setStored({ kind: "unset" })}
          />
        </div>
      </main>
    );
  }

  return (
    <ServerApp
      key={origin}
      deps={deps}
      origin={origin}
      developmentDefault={stored.kind === "unset"}
      problem={problem}
      onChangeServer={(next) => setStored({ kind: "configured", origin: next })}
      onUseDefault={() => setStored({ kind: "unset" })}
    />
  );
}

function readStoredServer(deps: AppDependencies): StoredServer {
  try {
    const origin = deps.settings.read();
    return origin === null ? { kind: "unset" } : { kind: "configured", origin };
  } catch (error) {
    return { kind: "unusable", message: describeError(error) };
  }
}

/**
 * One Server: its stored session, its typed client and its sign-in flow.
 *
 * The session is read from the device before the shell renders, written when a
 * sign-in succeeds, and cleared when it ends or the Server rejects the token.
 */
function ServerApp({
  deps,
  origin,
  developmentDefault,
  problem,
  onChangeServer,
  onUseDefault,
}: {
  deps: AppDependencies;
  origin: string;
  developmentDefault: boolean;
  problem: string | null;
  onChangeServer: (origin: string) => void;
  onUseDefault: () => void;
}) {
  const sessionProvider = useMemo(
    () => createSessionProvider({ localStore: deps.localStore, serverOrigin: origin }),
    [deps.localStore, origin],
  );
  /** undefined until the device's stored session has been read. */
  const [session, setSession] = useState<SessionDto | null | undefined>(undefined);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void sessionProvider
      .restore()
      .then((restored) => {
        if (active) setSession(restored);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setNotice(`The stored session could not be read: ${describeError(error)}`);
        setSession(null);
      });
    return () => {
      active = false;
    };
  }, [sessionProvider]);

  const api = useMemo(
    () => new SolarisApi({ baseUrl: origin, getToken: () => session?.token ?? null }),
    [origin, session],
  );

  const fail = useCallback(
    (error: unknown) => {
      // An expired or revoked session is not a page error: the device forgets a
      // token the Server has already rejected and returns to sign-in.
      if (isAuthRequired(error)) {
        setSession(null);
        setNotice("The Solaris session is no longer valid. Sign in again.");
        void sessionProvider.persist(null).catch((thrown: unknown) => {
          setNotice(`The session expired, and the stored token could not be cleared: ${describeError(thrown)}`);
        });
        return;
      }
      setNotice(describeError(error));
    },
    [sessionProvider],
  );

  async function signIn() {
    setBusy(true);
    setNotice("");
    try {
      const deployment = await api.getDeployment();
      const { code, codeVerifier } = await deps.desktopLogin.authorize({
        authorizationEndpoint: deployment.auth.authorizationEndpoint,
      });
      const next = await api.exchangeDesktopCode({ code, codeVerifier });
      // The session counts as active only once the device has stored it.
      await sessionProvider.persist(next);
      setSession(next);
    } catch (error) {
      setNotice(`Sign-in failed: ${describeError(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    try {
      await sessionProvider.persist(null);
    } catch (error) {
      setNotice(`Sign-out failed: ${describeError(error)} This device still holds the session.`);
      return;
    }
    try {
      await api.logout();
    } catch {
      // The token is already gone from this device; revoking it on the Server is
      // best effort and the session expires on its own.
    }
    setNotice("");
    setSession(null);
  }

  if (session === undefined) {
    return (
      <main className="signin">
        <div className="card stack">
          <Brand />
          <h3>Restoring the session…</h3>
          <p className="muted">Reading this device&apos;s stored session for {origin}.</p>
        </div>
      </main>
    );
  }

  if (session === null) {
    return (
      <main className="signin">
        <div className="card stack">
          <Brand />
          <h3>Sign in to this Server</h3>
          <p>
            Solaris opens the system browser for authorization, receives the code on a loopback listener in this app, and
            exchanges it here for a Solaris session. No password is entered in this window, and a refused exchange leaves this
            device signed out.
          </p>
          <p className="muted">Server {origin}</p>
          <button className="primary" disabled={busy} onClick={() => void signIn()}>
            {busy ? "Waiting for the browser…" : "Sign in"}
          </button>
          {notice !== "" && <Notice text={notice} onDismiss={() => setNotice("")} />}
          {developmentDefault && <DefaultAddressNote origin={origin} />}
          <details>
            <summary>Server address</summary>
            <ServerAddress
              settings={deps.settings}
              current={origin}
              defaultOrigin={deps.defaultServerOrigin}
              problem={problem}
              onSaved={onChangeServer}
              onUseDefault={onUseDefault}
            />
          </details>
        </div>
      </main>
    );
  }

  return (
    <Shell
      api={api}
      deps={deps}
      origin={origin}
      developmentDefault={developmentDefault}
      problem={problem}
      fail={fail}
      notice={notice}
      onNotice={setNotice}
      onSignOut={() => void signOut()}
      onChangeServer={onChangeServer}
      onUseDefault={onUseDefault}
      session={session}
    />
  );
}

function Shell({
  api,
  deps,
  origin,
  developmentDefault,
  problem,
  fail,
  notice,
  onNotice,
  onSignOut,
  onChangeServer,
  onUseDefault,
  session,
}: {
  api: SolarisApi;
  deps: AppDependencies;
  origin: string;
  developmentDefault: boolean;
  problem: string | null;
  fail: (error: unknown) => void;
  notice: string;
  onNotice: (text: string) => void;
  onSignOut: () => void;
  onChangeServer: (origin: string) => void;
  onUseDefault: () => void;
  session: SessionDto;
}) {
  const [page, setPage] = useState<Page>("workspace");
  const [showServer, setShowServer] = useState(false);
  const notify = useCallback((text: string) => onNotice(text), [onNotice]);
  const catalog = useConnectionCatalog(api, fail);

  const services = useMemo<Services>(
    () => ({
      api,
      localStore: deps.localStore,
      scope: { serverOrigin: api.origin, userId: session.user.id },
      notify,
      fail,
    }),
    [api, deps.localStore, fail, notify, session.user.id],
  );

  const usableModels = catalog.models.filter((model) => model.enabled && model.adapted).length;
  const current = navigation.find((item) => item.id === page);

  return (
    <ServicesContext.Provider value={services}>
      <main className="shell">
        <aside className="sidebar">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              <i />
            </span>
            <div>
              <h1>Solaris</h1>
              <p>Single-image workspace</p>
            </div>
          </div>
          <nav aria-label="Primary navigation">
            {navigation.map((item) => (
              <button
                className={page === item.id ? "active" : ""}
                aria-current={page === item.id ? "page" : undefined}
                onClick={() => setPage(item.id)}
                key={item.id}
              >
                <span>{item.index}</span>
                {item.label}
              </button>
            ))}
          </nav>
          <div className="solar-rail" aria-hidden="true">
            <span className="solar-orb" />
          </div>
          <div className="local-state">
            <span className="pulse" />
            <div>
              <b>{session.user.displayName ?? session.user.id}</b>
              <small>{origin}</small>
            </div>
          </div>
        </aside>
        <div className="workspace">
          <header className="topbar">
            <div>
              <span className="eyebrow">{current?.index} / SOLARIS</span>
              <p>
                {catalog.connections.length} connection{catalog.connections.length === 1 ? "" : "s"} · {usableModels} usable
                model{usableModels === 1 ? "" : "s"}
              </p>
            </div>
            <div className="row">
              <span className="local">
                <i />
                Signed in
              </span>
              <button type="button" onClick={() => setShowServer((open) => !open)}>
                Server
              </button>
              <button type="button" onClick={onSignOut}>
                Sign out
              </button>
            </div>
          </header>
          {developmentDefault && <DefaultAddressNote origin={origin} />}
          {notice !== "" && <Notice text={notice} onDismiss={() => onNotice("")} />}
          {showServer && (
            <div className="card stack panel-block">
              <h3>Server address</h3>
              <ServerAddress
                settings={deps.settings}
                current={origin}
                defaultOrigin={deps.defaultServerOrigin}
                problem={problem}
                onSaved={(next) => {
                  setShowServer(false);
                  onChangeServer(next);
                }}
                onUseDefault={() => {
                  setShowServer(false);
                  onUseDefault();
                }}
              />
            </div>
          )}
          <div className="page-stage">
            {page === "workspace" && <Workspace catalog={catalog} />}
            {page === "connections" && <Connections catalog={catalog} />}
            {page === "history" && <History />}
          </div>
        </div>
      </main>
    </ServicesContext.Provider>
  );
}

function Brand() {
  return (
    <div className="brand brand-plain">
      <span className="brand-mark" aria-hidden="true">
        <i />
      </span>
      <div>
        <h1>Solaris</h1>
        <p>Single-image workspace</p>
      </div>
    </div>
  );
}

/**
 * The address in use was not configured; it is the address that served this page.
 * A packaged desktop build has no such default and never shows this.
 */
function DefaultAddressNote({ origin }: { origin: string }) {
  return (
    <p className="default-address" role="status">
      Development default: no Server address is stored on this device, so this build uses <b>{origin}</b>, the address that
      served this page. Set the Server address to keep it explicit.
    </p>
  );
}

function Notice({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  return (
    <div className="notice" role="status">
      <span>{text}</span>
      <button aria-label="Dismiss notice" onClick={onDismiss}>
        ×
      </button>
    </div>
  );
}
