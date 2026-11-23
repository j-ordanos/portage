import { CheckCircle2, Info, XCircle } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

type Tone = "ok" | "bad" | "info";
interface ToastItem {
  id: number;
  tone: Tone;
  message: string;
}
const Ctx = createContext<(message: string, tone?: Tone) => void>(
  () => undefined,
);
export const useToast = () => useContext(Ctx);

/** Confirmations for things that happen out of sight (saved, copied, deleted). Polite live region, auto-dismiss. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((message: string, tone: Tone = "ok") => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev.slice(-3), { id, tone, message }]);
    setTimeout(
      () => setItems((prev) => prev.filter((t) => t.id !== id)),
      tone === "bad" ? 7000 : 3800,
    );
  }, []);
  const value = useMemo(() => push, [push]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>
            {t.tone === "ok" ? (
              <CheckCircle2 size={18} aria-hidden="true" />
            ) : t.tone === "bad" ? (
              <XCircle size={18} aria-hidden="true" />
            ) : (
              <Info size={18} aria-hidden="true" />
            )}
            {t.message}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
