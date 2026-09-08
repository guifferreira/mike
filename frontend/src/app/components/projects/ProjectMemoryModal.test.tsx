import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MikeApiError,
  getProjectMemory,
  setProjectMemoryEnabled,
  updateProjectMemory,
  wipeProjectMemory,
} from "@/app/lib/mikeApi";
import { ProjectMemoryModal } from "./ProjectMemoryModal";

vi.mock("@/app/components/ui/markdown-editor", () => ({
  MarkdownEditor: ({
    value,
    onChange,
    readOnly,
    ariaLabel,
  }: {
    value: string;
    onChange?: (value: string) => void;
    readOnly?: boolean;
    ariaLabel?: string;
  }) => (
    <textarea
      aria-label={ariaLabel}
      value={value}
      readOnly={readOnly}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
  getProjectMemory: vi.fn(),
  setProjectMemoryEnabled: vi.fn(),
  updateProjectMemory: vi.fn(),
  wipeProjectMemory: vi.fn(),
}));

const CURRENT = {
  enabled: true,
  content: "# Matter facts",
  revision: 2,
  hash: "hash-2",
  updated_at: "2026-09-05T01:00:00Z",
  updated_by: "Alex",
  source: "curator" as const,
  status: "idle" as const,
};

function renderModal(
  props: Partial<React.ComponentProps<typeof ProjectMemoryModal>> = {},
) {
  const onClose = vi.fn();
  const onMemoryEnabledChange = vi.fn();
  const result = render(
    <ProjectMemoryModal
      open
      onClose={onClose}
      projectId="project-1"
      projectName="Matter"
      canEdit={false}
      canManage={false}
      onMemoryEnabledChange={onMemoryEnabledChange}
      {...props}
    />,
  );
  return { ...result, onClose, onMemoryEnabledChange };
}

describe("ProjectMemoryModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    vi.mocked(getProjectMemory).mockResolvedValue(CURRENT);
    vi.mocked(updateProjectMemory).mockImplementation(
      async (_projectId, content) => ({
        ...CURRENT,
        content,
        revision: 3,
        hash: "hash-3",
      }),
    );
  });

  it("does not read memory until the dialog is opened", async () => {
    const { rerender, onClose } = renderModal({ open: false });

    expect(getProjectMemory).not.toHaveBeenCalled();

    rerender(
      <ProjectMemoryModal
        open
        onClose={onClose}
        projectId="project-1"
        projectName="Matter"
        canEdit={false}
        canManage={false}
      />,
    );

    await screen.findByRole("textbox", { name: "Project memory" });
    expect(getProjectMemory).toHaveBeenCalledWith(
      "project-1",
      expect.anything(),
    );
  });

  it("lets viewers read memory without edit or delete controls", async () => {
    renderModal();

    const editor = await screen.findByRole("textbox", {
      name: "Project memory",
    });
    // A quiet, up-to-date file reports nothing: no timestamp, no source.
    expect(screen.queryByText(/Last updated/)).toBeNull();
    expect(screen.queryByText(/Automatic update/)).toBeNull();
    // The editor takes whatever height is left rather than the body scrolling.
    expect(editor.parentElement).toHaveClass("min-h-0", "flex-1");
    expect(editor).toHaveValue("# Matter facts");
    expect(editor).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: /Save/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Delete/ })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Download project memory.md" }),
    ).toBeNull();
    expect(screen.getByRole("dialog", { name: "Project Memory" })).toHaveClass(
      "max-w-2xl",
      "h-[min(600px,calc(100vh-2rem))]",
    );
    expect(screen.getByRole("dialog", { name: "Project Memory" })).not.toHaveClass(
      "max-w-4xl",
    );
  });

  it("shows a failed update only inside project memory and remembers dismissal", async () => {
    const user = userEvent.setup();
    vi.mocked(getProjectMemory).mockResolvedValue({
      ...CURRENT,
      status: "failed",
    });

    const { unmount } = renderModal();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The latest automatic update failed",
    );

    await user.click(screen.getByRole("button", { name: "Dismiss warning" }));
    expect(screen.queryByRole("alert")).toBeNull();

    unmount();
    renderModal();
    await screen.findByRole("textbox", { name: "Project memory" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("autosaves an editor's draft against the loaded version", async () => {
    vi.mocked(updateProjectMemory).mockResolvedValue({
      ...CURRENT,
      content: "# Updated",
      revision: 3,
    });
    const user = userEvent.setup();
    renderModal({ canEdit: true });

    const editor = await screen.findByRole("textbox", {
      name: "Project memory",
    });
    await user.clear(editor);
    await user.type(editor, "# Updated");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(updateProjectMemory).not.toHaveBeenCalled();
    expect(screen.getByText("Saving…")).toBeVisible();

    await waitFor(
      () =>
        expect(updateProjectMemory).toHaveBeenCalledWith(
          "project-1",
          "# Updated",
          2,
        ),
      { timeout: 2000 },
    );
    expect(await screen.findByText("Saved")).toBeVisible();
  });

  it("adopts server-normalized Markdown without repeatedly saving it", async () => {
    vi.mocked(updateProjectMemory).mockResolvedValue({
      ...CURRENT,
      content: "# Normalized",
      revision: 3,
      hash: "hash-3",
    });
    renderModal({ canEdit: true });

    const editor = await screen.findByRole("textbox", {
      name: "Project memory",
    });
    await screen.findByRole("button", { name: "Close" });

    vi.useFakeTimers();
    try {
      fireEvent.change(editor, { target: { value: "# Normalized " } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(800);
      });

      expect(updateProjectMemory).toHaveBeenCalledOnce();
      expect(editor).toHaveValue("# Normalized");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(updateProjectMemory).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes an unsaved draft before closing", async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal({ canEdit: true });

    const editor = await screen.findByRole("textbox", {
      name: "Project memory",
    });
    fireEvent.change(editor, {
      target: { value: "# Matter facts and more" },
    });
    await user.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(
      () =>
        expect(updateProjectMemory).toHaveBeenCalledWith(
          "project-1",
          "# Matter facts and more",
          2,
        ),
      { timeout: 2000 },
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(screen.queryByText("Discard unsaved memory edits?")).toBeNull();
  });

  it("closes without confirmation when nothing is unsaved", async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal({ canEdit: true });

    await screen.findByRole("textbox", { name: "Project memory" });
    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByText("Discard unsaved memory edits?")).toBeNull();
  });

  it("offers an explicit discard path when autosave fails during close", async () => {
    vi.mocked(updateProjectMemory).mockRejectedValueOnce(new Error("offline"));
    const user = userEvent.setup();
    const { onClose } = renderModal({ canEdit: true });

    const editor = await screen.findByRole("textbox", {
      name: "Project memory",
    });
    fireEvent.change(editor, {
      target: { value: "# Matter facts unsaved" },
    });
    expect(
      await screen.findByText(
        "Project memory could not be saved. Your draft has been kept.",
        {},
        { timeout: 3000 },
      ),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Close without saving?")).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "Close without saving" }),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("preserves an editor's stale draft across a version conflict", async () => {
    const latest = {
      ...CURRENT,
      content: "# Automatic update",
      revision: 3,
      hash: "hash-3",
    };
    vi.mocked(getProjectMemory)
      .mockResolvedValueOnce(CURRENT)
      .mockResolvedValueOnce(latest);
    vi.mocked(updateProjectMemory)
      .mockRejectedValueOnce(
        new MikeApiError({
          status: 409,
          code: "memory_revision_conflict",
          message: "Memory changed",
        }),
      )
      .mockResolvedValueOnce({
        ...CURRENT,
        content: "# My draft",
        revision: 4,
        hash: "hash-4",
      });
    const user = userEvent.setup();
    renderModal({ canEdit: true, canManage: true });

    const editor = await screen.findByRole("textbox", {
      name: "Project memory",
    });
    await user.clear(editor);
    await user.type(editor, "# My draft");

    expect(
      await screen.findByText(
        "Project memory changed while you were editing",
        {},
        { timeout: 2000 },
      ),
    ).toBeVisible();
    expect(editor).toHaveValue("# My draft");

    await user.click(screen.getByRole("button", { name: "Keep my draft" }));

    await waitFor(
      () =>
        expect(updateProjectMemory).toHaveBeenLastCalledWith(
          "project-1",
          "# My draft",
          3,
        ),
      { timeout: 2000 },
    );
  });

  it("only enables disabled memory for a project owner", async () => {
    const off = {
      ...CURRENT,
      enabled: false,
      content: "",
      revision: 0,
      hash: null,
      updated_at: null,
      updated_by: null,
    };
    vi.mocked(getProjectMemory).mockResolvedValue(off);
    vi.mocked(setProjectMemoryEnabled).mockResolvedValue({
      ...off,
      enabled: true,
    });
    const user = userEvent.setup();
    const { onMemoryEnabledChange } = renderModal({
      canEdit: true,
      canManage: true,
    });

    await user.click(await screen.findByRole("button", { name: "Enable" }));

    await waitFor(() =>
      expect(setProjectMemoryEnabled).toHaveBeenCalledWith("project-1", true),
    );
    expect(await screen.findByText("Project memory enabled")).toBeVisible();
    expect(onMemoryEnabledChange).toHaveBeenLastCalledWith(true);
  });

  it("hides the enable action from members who cannot manage access", async () => {
    vi.mocked(getProjectMemory).mockResolvedValue({
      ...CURRENT,
      enabled: false,
      content: "",
      revision: 0,
      hash: null,
      updated_at: null,
      updated_by: null,
    });

    renderModal({ canEdit: true });

    expect(await screen.findByText("Project memory is off")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Enable" })).toBeNull();
  });

  it("requires confirmation before an owner deletes memory", async () => {
    vi.mocked(wipeProjectMemory).mockResolvedValue({
      ...CURRENT,
      content: "",
      // Wipes clear the head while preserving a monotonic CAS token.
      revision: 3,
      hash: null,
      updated_at: null,
      updated_by: null,
    });
    const user = userEvent.setup();
    renderModal({ canEdit: true, canManage: true });

    await user.click(
      await screen.findByRole("button", { name: "Delete project memory" }),
    );
    expect(wipeProjectMemory).not.toHaveBeenCalled();
    expect(screen.getByText("Delete project memory?")).toBeVisible();

    await user.click(screen.getAllByRole("button", { name: /Delete/ }).at(-1)!);
    await waitFor(() =>
      expect(wipeProjectMemory).toHaveBeenCalledWith("project-1"),
    );
    expect(await screen.findByText("Project memory deleted")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Delete project memory" }),
    ).toBeNull();
    expect(screen.queryByText("Version 3")).toBeNull();
  });

  it("lets an owner delete a pending first memory update", async () => {
    vi.mocked(getProjectMemory).mockResolvedValue({
      ...CURRENT,
      content: "",
      revision: 0,
      hash: null,
      updated_at: null,
      updated_by: null,
      status: "scheduled",
    });

    renderModal({ canEdit: true, canManage: true });

    expect(
      await screen.findByRole("button", {
        name: "Delete project memory",
      }),
    ).toBeVisible();
  });

  it("polls until a scheduled project-memory update is visible", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(getProjectMemory)
        .mockResolvedValueOnce({ ...CURRENT, status: "scheduled" })
        .mockResolvedValueOnce({
          ...CURRENT,
          content: "# Curated matter facts",
          revision: 3,
          hash: "hash-3",
          status: "idle",
        });

      renderModal();
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByText(/Memory review scheduled/)).toBeVisible();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });

      expect(
        screen.getByRole("textbox", { name: "Project memory" }),
      ).toHaveValue("# Curated matter facts");
      expect(getProjectMemory).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
