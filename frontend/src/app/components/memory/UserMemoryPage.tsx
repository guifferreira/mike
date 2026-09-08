"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { SettingsCard } from "@/app/components/settings/SettingsCard";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsRow } from "@/app/components/settings/SettingsRow";
import { MarkdownEditor } from "@/app/components/ui/markdown-editor";
import { PillButton } from "@/app/components/ui/pill-button";
import { ToggleSwitch } from "@/app/components/ui/toggle-switch";
import {
  SettingsDescription,
  SettingsLabel,
} from "@/app/components/settings/SettingsText";
import { useMemoryAutosave } from "@/app/components/memory/useMemoryAutosave";
import { MemoryUpdateFailedPopup } from "@/app/components/memory/MemoryUpdateFailedPopup";
import {
  MikeApiError,
  getUserMemory,
  setUserMemoryEnabled,
  updateUserMemory,
  type MemoryCurrent,
} from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";

type ConfirmAction = "disable";

/**
 * Only states worth acting on. A quiet, up-to-date file says nothing: when it
 * was last touched is not something anyone needs to read.
 */
function currentStatus(memory: MemoryCurrent) {
  if (memory.status === "scheduled") return "Memory review scheduled";
  if (memory.status === "processing") return "Updating memory…";
  return null;
}

export function UserMemoryPage() {
  const [memory, setMemory] = useState<MemoryCurrent | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [conflict, setConflict] = useState<MemoryCurrent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autosaveError, setAutosaveError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [settingsMutation, setSettingsMutation] = useState<
    "enable" | "disable" | null
  >(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(
    null,
  );
  const memoryRef = useRef<MemoryCurrent | null>(null);
  memoryRef.current = memory;

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError(false);
    try {
      const current = await getUserMemory(signal);
      if (signal?.aborted) return;
      setMemory(current);
      setDraft(current.content);
      setConflict(null);
      setError(null);
      setAutosaveError(null);
    } catch {
      if (!signal?.aborted) {
        setLoadError(true);
        setLoading(false);
      }
      return;
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function resolveConflict(cause: unknown) {
    if (
      !(cause instanceof MikeApiError) ||
      cause.status !== 409 ||
      cause.code !== "memory_revision_conflict"
    ) {
      return false;
    }
    try {
      setConflict(await getUserMemory());
    } catch {
      setError(
        "Memory changed while you were editing. Reload the page before saving again.",
      );
    }
    return true;
  }

  const autosave = useMemoryAutosave({
    value: draft,
    persistedValue: memory?.content ?? "",
    enabled:
      !!memory?.enabled &&
      !loading &&
      !loadError &&
      !conflict &&
      !confirmAction &&
      !settingsMutation,
    flushOnUnmount: !!memory?.enabled && settingsMutation === null,
    save: async (value) => {
      const current = memoryRef.current;
      if (!current) throw new Error("Memory is unavailable");
      const saved = await updateUserMemory(value, current.revision);
      // Advance the CAS ref even during a best-effort unmount flush, when UI
      // callbacks are intentionally skipped but a queued newer draft may run.
      memoryRef.current = saved;
      return saved;
    },
    getPersistedValue: (current) => current.content,
    onSaved: (current, { isLatest }) => {
      memoryRef.current = current;
      setMemory(current);
      // Reconcile server-normalized Markdown only if no newer keystroke has
      // landed since this write began.
      if (isLatest) setDraft(current.content);
      setAutosaveError(null);
    },
    onError: async (cause) => {
      if (!(await resolveConflict(cause))) {
        setAutosaveError(
          userFacingApiError(
            cause,
            "Memory could not be saved. Your draft has been kept.",
          ),
        );
      }
    },
  });

  const dirty = !!memory && draft !== memory.content;
  const interactionLocked =
    autosave.inFlight || settingsMutation !== null || confirmAction !== null;
  const editorLocked = settingsMutation !== null || confirmAction !== null;

  useEffect(() => {
    if (
      !memory?.enabled ||
      (memory.status !== "scheduled" && memory.status !== "processing") ||
      dirty ||
      conflict ||
      interactionLocked
    ) {
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void getUserMemory(controller.signal)
        .then((current) => {
          if (controller.signal.aborted) return;
          memoryRef.current = current;
          setMemory(current);
          setDraft(current.content);
        })
        .catch(() => {
          // The current file remains usable; a later page load can
          // recover status if this non-critical refresh fails.
        });
    }, 3000);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [conflict, dirty, interactionLocked, memory]);

  function useLatestConflict() {
    if (!conflict) return;
    memoryRef.current = conflict;
    setMemory(conflict);
    setDraft(conflict.content);
    setConflict(null);
    setError(null);
    setAutosaveError(null);
    autosave.cancelPending();
  }

  function keepDraftAfterConflict() {
    if (!conflict) return;
    memoryRef.current = conflict;
    setMemory(conflict);
    setConflict(null);
    setError(null);
    setAutosaveError(null);
    autosave.retry();
  }

  function syncSettingsMutation(current: MemoryCurrent, notice: string) {
    memoryRef.current = current;
    setMemory(current);
    setDraft(current.content);
    setConflict(null);
    setError(null);
    setAutosaveError(null);
    setSavedNotice(notice);
  }

  async function enableMemory() {
    if (interactionLocked) return;
    setSettingsMutation("enable");
    setError(null);
    setSavedNotice(null);
    try {
      syncSettingsMutation(
        await setUserMemoryEnabled(true),
        "App-wide memory enabled",
      );
    } catch (cause) {
      setError(
        userFacingApiError(
          cause,
          "App-wide memory could not be turned on. Please try again.",
        ),
      );
    } finally {
      setSettingsMutation(null);
    }
  }

  async function confirmSettingsMutation() {
    if (!confirmAction || settingsMutation || autosave.inFlight) return;
    setSettingsMutation("disable");
    setError(null);
    setSavedNotice(null);
    try {
      const current = await setUserMemoryEnabled(false);
      syncSettingsMutation(current, "App-wide memory turned off and deleted");
      setConfirmAction(null);
    } catch (cause) {
      setError(
        userFacingApiError(
          cause,
          "App-wide memory could not be turned off. Please try again.",
        ),
      );
      setConfirmAction(null);
    } finally {
      setSettingsMutation(null);
    }
  }

  return (
    <div className="space-y-8">
      <section
        className="space-y-3"
        aria-labelledby="app-memory-settings-heading"
      >
        <SettingsHeading id="app-memory-settings-heading">
          Memory
        </SettingsHeading>

        <SettingsCard>
          {loading ? (
            <div
              className="flex items-center justify-between gap-3 px-4 py-5"
              aria-label="Loading memory settings"
            >
              <div className="space-y-2">
                <div className="h-4 w-36 animate-pulse rounded bg-gray-200" />
                <div className="h-3 w-72 max-w-full animate-pulse rounded bg-gray-100" />
              </div>
              <div className="h-5 w-9 animate-pulse rounded-full bg-gray-200" />
            </div>
          ) : loadError || !memory ? (
            <SettingsRow>
              <div className="space-y-1">
                <SettingsLabel>Memory settings are unavailable</SettingsLabel>
                <p className="text-sm text-red-600" role="alert">
                  Could not load memory settings. Please try again.
                </p>
              </div>
              <PillButton tone="white" size="sm" onClick={() => void load()}>
                Retry
              </PillButton>
            </SettingsRow>
          ) : (
            <SettingsRow>
              <div className="space-y-1">
                <SettingsLabel>App-wide memory</SettingsLabel>
                <SettingsDescription>
                  Let Mike curate useful details after saved conversations and
                  use them in future answers.
                </SettingsDescription>
              </div>
              <div className="flex items-center gap-3">
                <ToggleSwitch
                  checked={memory.enabled}
                  disabled={interactionLocked}
                  aria-busy={settingsMutation === "enable"}
                  aria-label="App-wide memory"
                  onCheckedChange={(enabled) => {
                    if (enabled) void enableMemory();
                    else {
                      autosave.cancelPending();
                      setConfirmAction("disable");
                    }
                  }}
                />
              </div>
            </SettingsRow>
          )}

          <ProjectMemoryDefaultRow />
        </SettingsCard>

        {error ? (
          <p className="text-sm text-red-600" role="alert">
            {error}
          </p>
        ) : savedNotice ? (
          <p className="text-sm text-gray-500" role="status">
            {savedNotice}
          </p>
        ) : null}
      </section>

      {loading ? (
        <MemoryEditorSkeleton />
      ) : memory?.enabled ? (
        <section
          className="space-y-3"
          aria-labelledby="app-memory-file-heading"
        >
          <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
            <SettingsHeading id="app-memory-file-heading">
              Memory file
            </SettingsHeading>
            <div className="flex flex-wrap items-center gap-3">
              {autosaveError ? (
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-red-600" role="alert">
                    {autosaveError}
                  </span>
                  <button
                    type="button"
                    className="font-medium text-gray-700 hover:text-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2"
                    onClick={() => {
                      setAutosaveError(null);
                      autosave.retry();
                    }}
                  >
                    Retry
                  </button>
                </div>
              ) : autosave.status !== "idle" ? (
                <span
                  className="px-1 text-xs text-gray-500"
                  role="status"
                  aria-live="polite"
                >
                  {autosave.status === "saving" ? "Saving…" : "Saved"}
                </span>
              ) : null}
              {currentStatus(memory) ? (
                <p
                  className="text-xs text-gray-400"
                  role="status"
                >
                  {currentStatus(memory)}
                </p>
              ) : null}
            </div>
          </div>

          {conflict ? (
            <div
              className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900"
              role="alert"
            >
              <p className="font-medium">
                Memory changed while you were editing
              </p>
              <p className="mt-1 text-xs text-amber-800">
                Reload what is saved now, or keep your draft and let it save
                over the change.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <PillButton tone="white" size="sm" onClick={useLatestConflict}>
                  Reload latest
                </PillButton>
                <PillButton
                  tone="black"
                  size="sm"
                  onClick={keepDraftAfterConflict}
                >
                  Keep my draft
                </PillButton>
              </div>
            </div>
          ) : null}

          <div className="min-h-[24rem]">
            <MarkdownEditor
              value={draft}
              onChange={(value) => {
                setDraft(value);
                setAutosaveError(null);
                setError(null);
                setSavedNotice(null);
              }}
              ariaLabel="App-wide memory"
              className="min-h-[24rem]"
              readOnly={editorLocked}
              allowTables={false}
            />
          </div>
        </section>
      ) : null}

      <ConfirmPopup
        open={confirmAction !== null}
        title="Turn off and delete app-wide memory?"
        message={`This permanently deletes memory.md${dirty ? " and your unsaved draft" : ""}, and cancels pending memory updates. Memory will remain off until you turn it on again. This cannot be undone.`}
        confirmLabel="Disable"
        confirmVariant="danger"
        confirmStatus={settingsMutation ? "loading" : "idle"}
        onConfirm={() => void confirmSettingsMutation()}
        onCancel={() => {
          if (!settingsMutation) setConfirmAction(null);
        }}
      />
      <MemoryUpdateFailedPopup memory={memory} scopeKey="app" />
    </div>
  );
}

/**
 * The per-user default applied to projects this account creates. It is a
 * profile preference rather than a memory-file setting, so it stays usable
 * even when the memory file itself cannot be loaded, and it never overrides
 * another owner's choice on an existing project.
 */
function ProjectMemoryDefaultRow() {
  const { profile, updateProjectMemoryDefault } = useUserProfile();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleToggle(enabled: boolean) {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await updateProjectMemoryDefault(enabled);
    } catch (cause) {
      setError(
        userFacingApiError(
          cause,
          "That preference could not be saved. Please try again.",
        ),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsRow>
      <div className="space-y-1">
        <SettingsLabel>Project memory for new projects</SettingsLabel>
        <SettingsDescription>
          Projects you create start with shared memory on. Any project owner can
          still change it for a given project.
        </SettingsDescription>
        {error ? (
          <p className="text-xs text-red-600" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <ToggleSwitch
        checked={profile?.projectMemoryDefault !== false}
        disabled={!profile || saving}
        aria-busy={saving}
        aria-label="Project memory for new projects"
        onCheckedChange={(enabled) => void handleToggle(enabled)}
      />
    </SettingsRow>
  );
}

function MemoryEditorSkeleton() {
  return (
    <div className="space-y-3" aria-label="Loading memory editor">
      <div className="space-y-2">
        <div className="h-7 w-36 animate-pulse rounded bg-gray-200" />
        <div className="h-3 w-full max-w-xl animate-pulse rounded bg-gray-100" />
      </div>
      <div className="h-96 animate-pulse rounded-2xl bg-app-surface" />
    </div>
  );
}
