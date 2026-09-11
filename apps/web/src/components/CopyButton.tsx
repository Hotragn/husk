"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A real copy button. It writes to the clipboard, it says so in a polite live
 * region, and its box does not change size when the label changes — a control
 * that reflows while you are clicking it is a control you will misclick
 * (UI-PRINCIPLES.md §4).
 *
 * Failure is a state, not a silence: if the Clipboard API is unavailable or
 * denied, the button says what to do instead.
 */
export function CopyButton({
  value,
  label = "Copy",
  what = "command",
}: {
  value: string;
  label?: string;
  what?: string;
}) {
  const [state, setState] = useState<"rest" | "done" | "failed">("rest");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const onCopy = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    try {
      if (!navigator.clipboard) throw new Error("no clipboard api");
      await navigator.clipboard.writeText(value);
      setState("done");
    } catch {
      setState("failed");
    }
    timer.current = setTimeout(() => setState("rest"), 2400);
  }, [value]);

  const text =
    state === "done" ? "Copied" : state === "failed" ? "Select it" : label;

  return (
    <>
      <button
        type="button"
        className="btn btn-ghost copy-btn"
        onClick={onCopy}
        aria-label={
          state === "failed"
            ? `Could not reach the clipboard. Select the ${what} and copy it by hand.`
            : `Copy the ${what}`
        }
      >
        <span aria-hidden="true">{text}</span>
      </button>
      <span role="status" aria-live="polite" className="visually-hidden">
        {state === "done"
          ? `${what} copied to the clipboard`
          : state === "failed"
            ? `The clipboard is not available in this browser. Select the ${what} and copy it by hand.`
            : ""}
      </span>
    </>
  );
}
