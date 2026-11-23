import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { api } from "./api";

export interface Me {
  id: string;
  email: string;
}
interface Auth {
  state: "loading" | "anon" | "user";
  user: Me | null;
  allowSignup: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}
const Ctx = createContext<Auth>({
  state: "loading",
  user: null,
  allowSignup: true,
  refresh: async () => undefined,
  signOut: async () => undefined,
});
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Auth["state"]>("loading");
  const [user, setUser] = useState<Me | null>(null);
  const [allowSignup, setAllowSignup] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [me, pub] = await Promise.all([
        api<{ authenticated: boolean; user?: Me }>("GET", "/auth/me"),
        api<{ allowSignup: boolean }>("GET", "/public").catch(() => ({
          allowSignup: true,
        })),
      ]);
      setAllowSignup(pub.allowSignup);
      setUser(me.authenticated && me.user ? me.user : null);
      setState(me.authenticated ? "user" : "anon");
    } catch {
      setUser(null);
      setState("anon");
    }
  }, []);
  useEffect(() => {
    void refresh();
    // any request that comes back 401 means the session ended: fall back to the signed-out state
    const onExpired = () => void refresh();
    window.addEventListener("portage:session-expired", onExpired);
    return () =>
      window.removeEventListener("portage:session-expired", onExpired);
  }, [refresh]);

  const signOut = useCallback(async () => {
    await api("POST", "/auth/logout").catch(() => undefined);
    setUser(null);
    setState("anon");
    window.location.hash = "#/";
  }, []);

  const value = useMemo(
    () => ({ state, user, allowSignup, refresh, signOut }),
    [state, user, allowSignup, refresh, signOut],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
