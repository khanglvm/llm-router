import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils.js";
import { TOAST_DURATION_MS, TOAST_STATUS_TICK_MS } from "../constants.js";

export function getToastToneLabel(tone) {
  if (tone === "error") return "Error";
  if (tone === "success") return "Success";
  return "Notice";
}

export function Toast({ notice, onDismiss }) {
  const [remainingMs, setRemainingMs] = useState(TOAST_DURATION_MS);
  const [visibleRemainingMs, setVisibleRemainingMs] = useState(TOAST_DURATION_MS);
  const [paused, setPaused] = useState(false);
  const timerRef = useRef(null);
  const startedAtRef = useRef(0);

  useEffect(() => {
    if (remainingMs <= 0) {
      onDismiss();
      return undefined;
    }

    if (paused) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return undefined;
    }

    startedAtRef.current = Date.now();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      onDismiss();
    }, remainingMs);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [onDismiss, paused, remainingMs]);

  useEffect(() => {
    if (paused || remainingMs <= 0) {
      setVisibleRemainingMs(remainingMs);
      return undefined;
    }

    const syncRemaining = () => {
      const elapsed = startedAtRef.current ? Date.now() - startedAtRef.current : 0;
      setVisibleRemainingMs(Math.max(0, remainingMs - elapsed));
    };

    syncRemaining();
    const intervalId = setInterval(syncRemaining, TOAST_STATUS_TICK_MS);
    return () => clearInterval(intervalId);
  }, [paused, remainingMs]);

  function pauseTimer() {
    if (paused) return;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const elapsed = startedAtRef.current ? Date.now() - startedAtRef.current : 0;
    const nextRemainingMs = Math.max(0, remainingMs - elapsed);
    setRemainingMs(nextRemainingMs);
    setVisibleRemainingMs(nextRemainingMs);
    setPaused(true);
  }

  function resumeTimer() {
    setPaused(false);
  }

  const classes = notice.tone === "error"
    ? "border-rose-200 bg-rose-50 text-rose-800"
    : notice.tone === "success"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : "border-amber-200 bg-amber-50 text-amber-800";
  const progressRadius = 9;
  const progressCircumference = 2 * Math.PI * progressRadius;
  const progressRatio = Math.max(0, Math.min(1, visibleRemainingMs / TOAST_DURATION_MS));
  const progressOffset = progressCircumference * (1 - progressRatio);
  const progressLabel = paused
    ? `Auto-dismiss paused with ${Math.max(0, visibleRemainingMs / 1000).toFixed(1)} seconds remaining`
    : `Auto-dismiss in ${Math.max(0, visibleRemainingMs / 1000).toFixed(1)} seconds`;

  return (
    <div
      className={cn("pointer-events-auto rounded-2xl border px-4 py-3 text-sm shadow-lg backdrop-blur", classes)}
      onMouseEnter={pauseTimer}
      onMouseLeave={resumeTimer}
      onFocusCapture={pauseTimer}
      onBlurCapture={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        resumeTimer();
      }}
      role={notice.tone === "error" ? "alert" : "status"}
    >
      <div className="min-w-0">
        <div className="flex items-start justify-between gap-3">
          <div className="text-[11px] font-medium uppercase tracking-[0.16em] opacity-75">
            {getToastToneLabel(notice.tone)}
          </div>
          <div className="relative mt-0.5 h-6 w-6 shrink-0 opacity-85" aria-label={progressLabel} title={progressLabel}>
            <svg viewBox="0 0 24 24" className={cn("h-6 w-6 -rotate-90", paused ? "opacity-70" : "opacity-100")} aria-hidden="true">
              <circle
                cx="12"
                cy="12"
                r={progressRadius}
                fill="none"
                stroke="currentColor"
                strokeOpacity="0.18"
                strokeWidth="2"
              />
              <circle
                cx="12"
                cy="12"
                r={progressRadius}
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeDasharray={progressCircumference}
                strokeDashoffset={progressOffset}
                className="transition-[stroke-dashoffset,opacity] duration-100 ease-linear"
              />
            </svg>
            <span
              className={cn(
                "pointer-events-none absolute inset-0 flex items-center justify-center",
                paused ? "gap-[2px]" : ""
              )}
              aria-hidden="true"
            >
              {paused ? (
                <>
                  <span className="h-2.5 w-[2px] rounded-full bg-current/75" />
                  <span className="h-2.5 w-[2px] rounded-full bg-current/75" />
                </>
              ) : (
                <span className="h-1.5 w-1.5 rounded-full bg-current/75" />
              )}
            </span>
          </div>
        </div>
        <div className="mt-1 leading-6">{notice.message}</div>
        <div className="mt-2 flex justify-end">
          <button
            className="rounded-full border border-current/15 px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.16em] opacity-85 transition hover:border-current/30 hover:opacity-100"
            onClick={onDismiss}
            type="button"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

export function ToastStack({ notices, onDismiss }) {
  if (!Array.isArray(notices) || notices.length === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-x-4 top-4 z-50 flex flex-col items-end gap-3" aria-live="polite" aria-relevant="additions text">
      {notices.map((notice) => (
        <div key={notice.id} className="w-full max-w-md">
          <Toast notice={notice} onDismiss={() => onDismiss(notice.id)} />
        </div>
      ))}
    </div>
  );
}
