"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Brain, Trash2 } from "lucide-react";
import { useMemoryAutosave } from "@/app/components/memory/useMemoryAutosave";
import { MemoryUpdateFailedPopup } from "@/app/components/memory/MemoryUpdateFailedPopup";
import { Modal } from "@/app/components/modals/Modal";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { EmptyState } from "@/app/components/ui/empty-state";
import { GlassCard } from "@/app/components/ui/glass-card";
import { MarkdownEditor } from "@/app/components/ui/markdown-editor";
import { PillButton } from "@/app/components/ui/pill-button";
import { TabPillButton } from "@/app/components/ui/tab-pill-button";
import {
    MikeApiError,
    getProjectMemory,
    setProjectMemoryEnabled,
    updateProjectMemory,
    wipeProjectMemory,
    type MemoryCurrent,
} from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";

/**
 * Only states worth acting on. A quiet, up-to-date file says nothing: when it
 * was last touched is not something anyone needs to read.
 */
function currentStatus(memory: MemoryCurrent) {
    if (memory.status === "scheduled") return "Memory review scheduled";
    if (memory.status === "processing") return "Updating memory…";
    return null;
}

export function ProjectMemoryModal({
    open,
    onClose,
    projectId,
    projectName,
    projectLoading = false,
    canEdit,
    canManage,
    onMemoryEnabledChange,
}: {
    open: boolean;
    onClose: () => void;
    projectId: string;
    projectName: string | null;
    projectLoading?: boolean;
    /** Caller holds `content.edit` on this project. */
    canEdit: boolean;
    /** Caller holds `access.manage` on this project. */
    canManage: boolean;
    /**
     * Report the file's enabled flag back to the workspace so the project row
     * and its details dialog agree with what this dialog just did.
     */
    onMemoryEnabledChange?: (enabled: boolean) => void;
}) {
    const [memory, setMemory] = useState<MemoryCurrent | null>(null);
    const [draft, setDraft] = useState("");
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState(false);
    const [enabling, setEnabling] = useState(false);
    const [wipeConfirmOpen, setWipeConfirmOpen] = useState(false);
    const [wiping, setWiping] = useState(false);
    const [closing, setClosing] = useState(false);
    const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
    const [conflict, setConflict] = useState<MemoryCurrent | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [autosaveError, setAutosaveError] = useState<string | null>(null);
    const [savedNotice, setSavedNotice] = useState<string | null>(null);
    const memoryRef = useRef<MemoryCurrent | null>(null);
    const draftRef = useRef(draft);
    memoryRef.current = memory;
    draftRef.current = draft;

    const syncCurrent = useCallback(
        (current: MemoryCurrent, syncDraft = true) => {
            memoryRef.current = current;
            setMemory(current);
            if (syncDraft) {
                draftRef.current = current.content;
                setDraft(current.content);
            }
            onMemoryEnabledChange?.(current.enabled);
        },
        [onMemoryEnabledChange],
    );

    const load = useCallback(
        async (signal?: AbortSignal) => {
            setLoading(true);
            setLoadError(false);
            try {
                const current = await getProjectMemory(projectId, signal);
                if (signal?.aborted) return;
                syncCurrent(current);
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
        },
        [projectId, syncCurrent],
    );

    // The file is fetched when the dialog opens, not when the project page
    // mounts: most visits to a project never ask for its memory. Closing drops
    // what was read so a later open shows its skeleton rather than a stale file.
    useEffect(() => {
        if (!open) {
            setMemory(null);
            draftRef.current = "";
            setDraft("");
            setLoading(true);
            setConflict(null);
            setError(null);
            setAutosaveError(null);
            setSavedNotice(null);
            setClosing(false);
            setWipeConfirmOpen(false);
            setDiscardConfirmOpen(false);
            return;
        }
        const controller = new AbortController();
        void load(controller.signal);
        return () => controller.abort();
    }, [load, open]);

    const dirty = !!memory && draft !== memory.content;

    useEffect(() => {
        if (
            !open ||
            !memory?.enabled ||
            (memory.status !== "scheduled" && memory.status !== "processing") ||
            dirty ||
            conflict
        ) {
            return;
        }
        const controller = new AbortController();
        const timer = window.setTimeout(() => {
            void getProjectMemory(projectId, controller.signal)
                .then((current) => {
                    if (controller.signal.aborted) return;
                    syncCurrent(current);
                })
                .catch(() => {
                    // Keep the current file usable; the next poll or reopen can
                    // recover a transient status-refresh failure.
                });
        }, 3000);
        return () => {
            window.clearTimeout(timer);
            controller.abort();
        };
    }, [conflict, dirty, memory, open, projectId, syncCurrent]);

    async function resolveConflict(cause: unknown) {
        if (
            !(cause instanceof MikeApiError) ||
            cause.status !== 409 ||
            cause.code !== "memory_revision_conflict"
        ) {
            return false;
        }
        try {
            const latest = await getProjectMemory(projectId);
            setConflict(latest);
            onMemoryEnabledChange?.(latest.enabled);
        } catch {
            setError(
                "Project memory changed while you were editing. Reopen memory before saving again.",
            );
        }
        return true;
    }

    const autosave = useMemoryAutosave({
        value: draft,
        persistedValue: memory?.content ?? "",
        enabled:
            open &&
            canEdit &&
            !!memory?.enabled &&
            !loading &&
            !loadError &&
            !enabling &&
            !wiping &&
            !wipeConfirmOpen &&
            !discardConfirmOpen &&
            !conflict,
        flushOnUnmount: open && canEdit && !!memory?.enabled && !wiping,
        save: async (value) => {
            const current = memoryRef.current;
            if (!current) throw new Error("Project memory is unavailable");
            const saved = await updateProjectMemory(
                projectId,
                value,
                current.revision,
            );
            memoryRef.current = saved;
            return saved;
        },
        getPersistedValue: (current) => current.content,
        onSaved: (current, { isLatest }) => {
            // Reconcile server-normalized Markdown only if no newer keystroke has
            // landed since this write began.
            syncCurrent(current, isLatest);
            setAutosaveError(null);
        },
        onError: async (cause) => {
            if (!(await resolveConflict(cause))) {
                setAutosaveError(
                    userFacingApiError(
                        cause,
                        "Project memory could not be saved. Your draft has been kept.",
                    ),
                );
            }
        },
    });

    async function enableMemory() {
        if (!canManage || enabling || closing) return;
        setEnabling(true);
        setError(null);
        setAutosaveError(null);
        try {
            const current = await setProjectMemoryEnabled(projectId, true);
            syncCurrent(current);
            setSavedNotice("Project memory enabled");
        } catch (cause) {
            setError(
                userFacingApiError(
                    cause,
                    "Project memory could not be enabled. Please try again.",
                ),
            );
        } finally {
            setEnabling(false);
        }
    }

    async function wipeMemory() {
        if (
            !memory ||
            !canManage ||
            wiping ||
            autosave.inFlight ||
            discardConfirmOpen ||
            closing
        ) {
            return;
        }
        setWiping(true);
        setError(null);
        setAutosaveError(null);
        setSavedNotice(null);
        try {
            const current = await wipeProjectMemory(projectId);
            syncCurrent(current);
            setConflict(null);
            setWipeConfirmOpen(false);
            setSavedNotice("Project memory deleted");
        } catch (cause) {
            setError(
                userFacingApiError(
                    cause,
                    "Project memory could not be deleted. Please try again.",
                ),
            );
        } finally {
            setWiping(false);
        }
    }

    function useLatestConflict() {
        if (!conflict) return;
        syncCurrent(conflict);
        setConflict(null);
        setError(null);
        setAutosaveError(null);
        autosave.cancelPending();
    }

    function keepDraftAfterConflict() {
        if (!conflict) return;
        syncCurrent(conflict, false);
        setConflict(null);
        setError(null);
        setAutosaveError(null);
        autosave.retry();
    }

    const modalInteractionLocked =
        autosave.inFlight ||
        enabling ||
        wiping ||
        closing ||
        wipeConfirmOpen ||
        discardConfirmOpen;

    async function requestClose() {
        if (wipeConfirmOpen && !wiping) {
            setWipeConfirmOpen(false);
            return;
        }
        if (discardConfirmOpen) {
            setDiscardConfirmOpen(false);
            return;
        }
        if (closing || wiping) return;
        const current = memoryRef.current;
        const hasDirtyDraft = !!current && draftRef.current !== current.content;
        const canSaveCurrent = canEdit && !!current?.enabled && !loadError;
        if (!hasDirtyDraft || !canSaveCurrent) {
            onClose();
            return;
        }

        if (autosaveError || conflict) {
            autosave.cancelPending();
            setDiscardConfirmOpen(true);
            return;
        }

        setClosing(true);
        const saved = await autosave.flush();
        if (saved) onClose();
        else {
            setClosing(false);
            autosave.cancelPending();
            setDiscardConfirmOpen(true);
        }
    }

    return (
        <Modal
            open={open}
            onClose={requestClose}
            breadcrumbs={[
                "Projects",
                projectName ?? "Project",
                "Project Memory",
            ]}
            headerAction={
                memory?.enabled ? (
                    <div className="flex items-center gap-3">
                        {canManage &&
                        (memory.hash !== null || memory.status !== "idle") ? (
                            <TabPillButton
                                className="text-red-600 hover:text-red-700"
                                onClick={() => {
                                    autosave.cancelPending();
                                    setWipeConfirmOpen(true);
                                }}
                                disabled={modalInteractionLocked}
                                aria-label="Delete project memory"
                                title="Delete project memory"
                            >
                                <Trash2
                                    aria-hidden="true"
                                    className="h-3.5 w-3.5"
                                />
                                <span className="hidden sm:inline">Delete</span>
                            </TabPillButton>
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
                ) : undefined
            }
            footerStatus={
                error ? (
                    <span className="text-sm text-red-600" role="alert">
                        {error}
                    </span>
                ) : autosaveError ? (
                    <span className="inline-flex items-center gap-2 text-sm">
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
                    </span>
                ) : autosave.status !== "idle" ? (
                    <span
                        className="text-xs text-gray-500"
                        role="status"
                        aria-live="polite"
                    >
                        {autosave.status === "saving" ? "Saving…" : "Saved"}
                    </span>
                ) : savedNotice ? (
                    <span className="text-sm text-gray-400" role="status">
                        {savedNotice}
                    </span>
                ) : null
            }
        >
            <div className="flex min-h-0 flex-1 flex-col gap-3 pb-3 pt-1">
                {loading || projectLoading ? (
                    <ProjectMemorySkeleton />
                ) : loadError || !memory ? (
                    <GlassCard>
                        <EmptyState
                            icon={<Brain />}
                            title="Project memory could not be loaded"
                            description="Try again to inspect this project's shared memory."
                            tone="error"
                            className="px-5 py-8"
                            action={
                                <PillButton
                                    tone="black"
                                    size="sm"
                                    onClick={() => void load()}
                                >
                                    Retry
                                </PillButton>
                            }
                        />
                    </GlassCard>
                ) : !memory.enabled ? (
                    <GlassCard>
                        <EmptyState
                            icon={<Brain />}
                            title="Project memory is off"
                            description={
                                canManage
                                    ? "Enable it to start a new shared project memory.md for future conversations."
                                    : "A project owner can enable memory for future project conversations."
                            }
                            className="px-5 py-8"
                            action={
                                canManage ? (
                                    <PillButton
                                        tone="black"
                                        size="sm"
                                        onClick={() => void enableMemory()}
                                        disabled={enabling}
                                        aria-busy={enabling}
                                    >
                                        {enabling ? "Enabling…" : "Enable"}
                                    </PillButton>
                                ) : undefined
                            }
                        />
                    </GlassCard>
                ) : (
                    <>
                        <p className="text-sm text-gray-500">
                            Details about this project gathered from past chats.
                        </p>

                        {conflict ? (
                            <div
                                className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900"
                                role="alert"
                            >
                                <p className="font-medium">
                                    Project memory changed while you were
                                    editing
                                </p>
                                <p className="mt-1 text-xs text-amber-800">
                                    Reload what is saved now, or keep your draft
                                    and let it save over the change.
                                </p>
                                <div className="mt-3 flex flex-wrap gap-2">
                                    <PillButton
                                        tone="white"
                                        size="sm"
                                        onClick={useLatestConflict}
                                    >
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

                        <div className="min-h-0 flex-1">
                            <MarkdownEditor
                                value={draft}
                                onChange={
                                    canEdit
                                        ? (value) => {
                                              draftRef.current = value;
                                              setDraft(value);
                                              setAutosaveError(null);
                                              setError(null);
                                              setSavedNotice(null);
                                          }
                                        : undefined
                                }
                                readOnly={
                                    !canEdit ||
                                    enabling ||
                                    wiping ||
                                    closing ||
                                    wipeConfirmOpen ||
                                    discardConfirmOpen
                                }
                                ariaLabel="Project memory"
                                className="h-full"
                                allowTables={false}
                            />
                        </div>
                    </>
                )}
            </div>

            <ConfirmPopup
                open={wipeConfirmOpen}
                title="Delete project memory?"
                message={`This permanently deletes memory.md${dirty ? ", including your unsaved edits" : ""}. Project memory stays on and can learn again from future conversations. This cannot be undone.`}
                confirmLabel="Delete"
                confirmVariant="danger"
                confirmStatus={wiping ? "loading" : "idle"}
                onConfirm={() => void wipeMemory()}
                onCancel={() => {
                    if (!wiping) setWipeConfirmOpen(false);
                }}
            />

            <ConfirmPopup
                open={discardConfirmOpen}
                title="Close without saving?"
                message="The latest changes could not be saved to this project's memory.md. Closing now discards them."
                confirmLabel="Close without saving"
                confirmVariant="danger"
                onConfirm={() => {
                    autosave.cancelPending();
                    setDiscardConfirmOpen(false);
                    onClose();
                }}
                onCancel={() => setDiscardConfirmOpen(false)}
            />
            <MemoryUpdateFailedPopup
                memory={memory}
                scopeKey={`project:${projectId}`}
            />
        </Modal>
    );
}

function ProjectMemorySkeleton() {
    return (
        <div className="space-y-4" aria-label="Loading project memory">
            <div className="space-y-2">
                <div className="h-3 w-full max-w-xl animate-pulse rounded bg-gray-100" />
                <div className="h-3 w-40 animate-pulse rounded bg-gray-100" />
            </div>
            <div className="h-80 animate-pulse rounded-2xl bg-app-surface" />
        </div>
    );
}
