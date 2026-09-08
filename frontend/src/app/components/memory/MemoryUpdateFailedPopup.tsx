"use client";

import { useEffect, useMemo, useState } from "react";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import type { MemoryCurrent } from "@/app/lib/mikeApi";

const DISMISSAL_PREFIX = "mike:memory-update-failure-dismissed:";

function failureId(memory: MemoryCurrent | null): string | null {
  if (memory?.status !== "failed") return null;
  return [
    memory.revision,
    memory.status_updated_at ?? memory.updated_at ?? "unknown",
    memory.hash ?? "empty",
  ].join(":");
}

export function MemoryUpdateFailedPopup({
  memory,
  scopeKey,
}: {
  memory: MemoryCurrent | null;
  /** Stable per-file key, such as `app` or `project:<id>`. */
  scopeKey: string;
}) {
  const storageKey = `${DISMISSAL_PREFIX}${scopeKey}`;
  const currentFailureId = useMemo(() => failureId(memory), [memory]);
  const [dismissedFailureId, setDismissedFailureId] = useState<string | null>(
    null,
  );
  const [dismissalLoaded, setDismissalLoaded] = useState(false);

  useEffect(() => {
    setDismissalLoaded(false);
    try {
      setDismissedFailureId(window.localStorage.getItem(storageKey));
    } catch {
      setDismissedFailureId(null);
    }
    setDismissalLoaded(true);
  }, [storageKey]);

  function dismiss() {
    if (!currentFailureId) return;
    try {
      window.localStorage.setItem(storageKey, currentFailureId);
    } catch {
      // Component state still dismisses the popup for this page visit.
    }
    setDismissedFailureId(currentFailureId);
  }

  return (
    <WarningPopup
      open={
        dismissalLoaded &&
        currentFailureId !== null &&
        currentFailureId !== dismissedFailureId
      }
      onClose={dismiss}
      message={
        <span role="alert">
          The latest automatic update failed. Existing memory is unchanged.
        </span>
      }
    />
  );
}
