"use client";

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";

/** Save button that says so when the save went through. */
export function SaveButton({ label = "Save" }: { label?: string }) {
  const { pending } = useFormStatus();
  const was = useRef(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (was.current && !pending) {
      setSaved(true);
      const t = setTimeout(() => setSaved(false), 2000);
      return () => clearTimeout(t);
    }
    was.current = pending;
  }, [pending]);
  useEffect(() => {
    was.current = pending;
  });
  return (
    <button className="btn-quiet" disabled={pending}>
      {pending ? "Saving…" : saved ? "Saved ✓" : label}
    </button>
  );
}

/** A small text button that needs a second click, for things that are hard to undo. */
export function ConfirmButton({ label, confirm }: { label: string; confirm: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      className={`text-xs underline ${armed ? "text-weak" : "text-muted"}`}
      onClick={(e) => {
        if (!armed) {
          e.preventDefault();
          setArmed(true);
        }
      }}
    >
      {armed ? confirm : label}
    </button>
  );
}
