import { Monitor, Moon, Sun } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type ThemePref = "system" | "light" | "dark";
const KEY = "portage-theme";
const Ctx = createContext<{ pref: ThemePref; set: (p: ThemePref) => void }>({
  pref: "system",
  set: () => undefined,
});
export const useTheme = () => useContext(Ctx);

const read = (): ThemePref => {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system"; // storage can be blocked (private windows); the system setting still works
  }
};

/** Light, Dark, or follow the system. The choice is remembered on this device only. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPref] = useState<ThemePref>(read);
  const set = useCallback((p: ThemePref) => {
    setPref(p);
    try {
      if (p === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, p);
    } catch {
      // ignore: the choice still applies for this visit
    }
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    if (pref === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", pref);
  }, [pref]);
  const value = useMemo(() => ({ pref, set }), [pref, set]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

const OPTIONS = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "system", label: "System", Icon: Monitor },
  { value: "dark", label: "Dark", Icon: Moon },
] as const;

export function ThemeSwitch() {
  const { pref, set } = useTheme();
  return (
    <div className="theme-switch" role="group" aria-label="Colour theme">
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          aria-pressed={pref === value}
          aria-label={`${label} theme`}
          title={`${label} theme`}
          onClick={() => set(value)}
        >
          <Icon size={15} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
