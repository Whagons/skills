import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { resourceSummary, type AccessRole } from "../lib/access";

export function RolePicker({ label, value, roles, disabled, placeholder = "Choose a role", onChange }: {
  label: string; value: string; roles: AccessRole[]; disabled?: boolean; placeholder?: string; onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const selected = roles.find(role => role.id === value);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  useEffect(() => {
    if (open) root.current?.querySelector<HTMLButtonElement>(`[data-index="${focused}"]`)?.focus();
  }, [open, focused]);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  return <div className="rolePicker" ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button ref={trigger} type="button" className="rolePickerTrigger" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled || !roles.length}
      onClick={() => { setFocused(Math.max(0, roles.findIndex(role => role.id === value))); setOpen(!open); }}
      onKeyDown={event => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setFocused(Math.max(0, roles.findIndex(role => role.id === value))); setOpen(true); } }}>
      <span>{selected?.name ?? placeholder}</span><ChevronDown size={16} />
    </button>
    {open && <div id={id} role="listbox" aria-label={label} className="rolePickerMenu" onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); close(); }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        setFocused(current => event.key === "Home" ? 0 : event.key === "End" ? roles.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + roles.length) % roles.length);
      }
    }}>
      {roles.map((role, index) => <button key={role.id} type="button" role="option" aria-selected={role.id === value} tabIndex={index === focused ? 0 : -1} data-index={index} className="rolePickerOption" onClick={() => { onChange(role.id); close(); }}>
        <span><strong>{role.name}</strong><small>{resourceSummary(role, "skills")} · {resourceSummary(role, "credentials")}</small></span>
        {role.id === value && <Check size={16} />}
      </button>)}
    </div>}
  </div>;
}
