import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { AuthDialog } from "./AuthDialog";
import { AuthProvider, useAuth } from "./auth";
import { Logo } from "./brand";
import { Dashboard } from "./Dashboard";
import { Docs } from "./Docs";
import { Landing } from "./Landing";
import { NewMigration } from "./NewMigration";
import { RunPage } from "./RunPage";
import { go, useRoute } from "./router";
import { Settings } from "./Settings";
import { Frame } from "./Shell";
import { ThemeProvider } from "./theme";
import { ToastProvider } from "./toast";

function Splash() {
  return (
    <div
      style={{
        display: "grid",
        placeItems: "center",
        minHeight: "100dvh",
        gap: "1rem",
      }}
      role="status"
      aria-label="Loading Portage"
    >
      <div style={{ display: "grid", justifyItems: "center", gap: "1rem" }}>
        <Logo size={40} />
        <Loader2 className="spin" size={20} aria-hidden="true" />
      </div>
    </div>
  );
}

function Router() {
  const route = useRoute();
  const { state } = useAuth();
  const [dialog, setDialog] = useState<null | "signin" | "signup">(null);

  // a visitor who opens a private address is asked to sign in, then lands where they were heading
  const privatePage = route.page !== "home" && route.page !== "docs";
  useEffect(() => {
    if (state === "anon" && privatePage) setDialog("signin");
  }, [state, privatePage]);
  useEffect(() => {
    document.title =
      route.page === "docs"
        ? "Docs · Portage"
        : "Portage: move your Coolify projects to Dokploy";
  }, [route.page]);

  if (state === "loading") return <Splash />;

  const authDialog = (
    <AuthDialog
      open={dialog !== null}
      mode={dialog ?? "signin"}
      onMode={setDialog}
      onClose={() => setDialog(null)}
      onDone={() => {
        setDialog(null);
        if (route.page === "home" || route.page === "docs")
          go({ page: "home" });
      }}
    />
  );

  if (state === "anon") {
    if (route.page === "docs") {
      return (
        <>
          <Frame route={route} onSignIn={() => setDialog("signin")}>
            <Docs slug={route.slug} />
          </Frame>
          {authDialog}
        </>
      );
    }
    return (
      <>
        <Landing
          onStart={() => setDialog("signup")}
          onSignIn={() => setDialog("signin")}
        />
        {authDialog}
      </>
    );
  }

  switch (route.page) {
    case "docs":
      return (
        <Frame route={route}>
          <Docs slug={route.slug} />
        </Frame>
      );
    case "settings":
      return (
        <Frame route={route}>
          <Settings tab={route.tab} />
        </Frame>
      );
    case "new":
      return (
        <Frame route={route}>
          <NewMigration />
        </Frame>
      );
    case "run":
      return (
        <RunPage
          key={route.id}
          id={route.id}
          stage={route.stage}
          frame={(flow, body) => (
            <Frame route={route} flow={flow}>
              {body}
            </Frame>
          )}
        />
      );
    default:
      return (
        <Frame route={route}>
          <Dashboard />
        </Frame>
      );
  }
}

export function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <ToastProvider>
          <Router />
        </ToastProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
