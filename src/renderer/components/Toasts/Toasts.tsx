import { useSyncExternalStore } from "react";
import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import "./Toasts.scss";

export interface ToastItem {
  id: number;
  title: string;
  description?: string;
  type: "info" | "success" | "error";
}

const DURATION = 4000;
let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * Show a short notification at the bottom of the window.
 */
export function toast(title: string, opts?: { description?: string; type?: ToastItem["type"] }): void {
  const item: ToastItem = { id: nextId++, title, description: opts?.description, type: opts?.type ?? "info" };
  items = [...items.slice(-3), item];
  emit();
  window.setTimeout(() => dismiss(item.id), opts?.type === "error" ? DURATION * 1.75 : DURATION);
}

function dismiss(id: number): void {
  items = items.filter((t) => t.id !== id);
  emit();
}

const ICONS = { info: Info, success: CircleCheck, error: CircleAlert };

export default function Toasts() {
  const list = useSyncExternalStore((l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  }, () => items);

  return (
    <div className="bb-toasts" role="status" aria-live="polite">
      {list.map((item) => {
        const Icon = ICONS[item.type];
        return (
          <div key={item.id} className={`bb-toast bb-toast--${item.type}`}>
            <Icon size={18} className="bb-toast__icon" />
            <div className="bb-toast__text">
              <strong>{item.title}</strong>
              {item.description && <span>{item.description}</span>}
            </div>
            <button className="bb-toast__close" onClick={() => dismiss(item.id)} aria-label="Dismiss">
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
