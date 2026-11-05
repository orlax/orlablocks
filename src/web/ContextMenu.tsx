import { useLayoutEffect, useRef, useState } from "react";

export type ContextAction = { label: string; run: () => void; disabled?: string };
type Props = {
  x: number;
  y: number;
  actions: ContextAction[];
  source: HTMLElement;
  onClose: () => void;
};

/** One keyboard menu for both surfaces; actions are supplied by the editor's command handlers. */
export function ContextMenu({ x, y, actions, source, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = ref.current!;
    const r = el.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(x, innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(y, innerHeight - r.height - 8)),
    });
    (el.querySelector<HTMLButtonElement>("button:not(:disabled)") ?? el).focus();
    const dismiss = (e: Event) => { if (!el.contains(e.target as Node)) onClose(); };
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("blur", onClose);
      if (source.isConnected) source.focus({ preventScroll: true });
    };
  }, []);

  return (
    <div
      ref={ref} className="context-menu" role="menu" tabIndex={-1} style={position}
      onContextMenu={e => e.preventDefault()}
      onKeyDown={e => {
        e.stopPropagation();
        if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); onClose(); }
        const buttons = [...ref.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
          e.preventDefault();
          const next = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1
            : (i + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }
      }}
    >
      {actions.map(action => (
        <button
          key={action.label} role="menuitem" disabled={!!action.disabled} title={action.disabled}
          onClick={() => { onClose(); action.run(); }}
        >
          {action.label}
          {action.disabled && <small>{action.disabled}</small>}
        </button>
      ))}
    </div>
  );
}
