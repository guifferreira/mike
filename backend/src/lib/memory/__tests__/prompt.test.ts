import { beforeEach, describe, expect, it, vi } from "vitest";

const { getMemoryCurrent } = vi.hoisted(() => ({
  getMemoryCurrent: vi.fn(),
}));

vi.mock("../files", () => ({
  getMemoryCurrent: (...args: unknown[]) => getMemoryCurrent(...args),
}));

import { buildMemoryTurn, MEMORY_SYSTEM_POLICY } from "../prompt";

beforeEach(() => {
  getMemoryCurrent.mockReset();
});

describe("buildMemoryTurn", () => {
  it("loads app and project memory in parallel", async () => {
    let resolveApp!: (value: unknown) => void;
    let resolveProject!: (value: unknown) => void;
    getMemoryCurrent
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveApp = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveProject = resolve;
        }),
      );

    const pending = buildMemoryTurn({
      db: {} as never,
      systemPrompt: "BASE",
      userId: "user-1",
      projectId: "project-1",
    });

    expect(getMemoryCurrent).toHaveBeenCalledTimes(2);
    resolveApp({ current: { enabled: true, content: "App" } });
    resolveProject({ current: { enabled: true, content: "Project" } });
    await expect(pending).resolves.toMatchObject({
      message: { content: expect.stringContaining("Project") },
    });
  });

  it("injects enabled files with explicit precedence and no write capability", async () => {
    getMemoryCurrent
      .mockResolvedValueOnce({
        current: { enabled: true, content: "# App\n- concise" },
      })
      .mockResolvedValueOnce({
        current: { enabled: true, content: "# Project\n- Matter Alpha" },
      });

    const turn = await buildMemoryTurn({
      db: {} as never,
      systemPrompt: "BASE",
      userId: "user-1",
      projectId: "project-1",
      sharedAudience: true,
    });

    expect(MEMORY_SYSTEM_POLICY).toContain(
      "current conversation over project memory",
    );
    expect(MEMORY_SYSTEM_POLICY).toContain("project memory over app memory");
    expect(turn.message?.content).toContain('scope="app"');
    expect(turn.message?.content).toContain('scope="project"');
    expect(turn.message?.content).toContain("# App");
    expect(turn.message?.content).toContain("# Project");
    expect(turn.message?.content).toContain("CONVERSATION AUDIENCE: SHARED");
    expect(MEMORY_SYSTEM_POLICY).toContain("never grants permissions");
    expect(MEMORY_SYSTEM_POLICY).toContain(
      "never reveal, quote, summarize, or otherwise expose a detail found only in app memory",
    );
  });

  it("appends the policy and the audience rule the caller must enforce", async () => {
    getMemoryCurrent.mockResolvedValueOnce({
      current: { enabled: true, content: "# App" },
    });

    const shared = await buildMemoryTurn({
      db: {} as never,
      systemPrompt: "BASE",
      userId: "user-1",
      sharedAudience: true,
    });

    expect(shared.systemPrompt).toContain("BASE");
    expect(shared.systemPrompt).toContain(MEMORY_SYSTEM_POLICY);
    expect(shared.systemPrompt).toContain("CURRENT MEMORY AUDIENCE: SHARED");
    expect(shared.systemPrompt).toContain(
      "Never reveal, quote, summarize, or otherwise expose",
    );
    // Memory content is carried by the turn, never by the system prompt.
    expect(shared.systemPrompt).not.toContain("# App");
    expect(shared.message).toEqual({
      role: "user",
      content: expect.stringContaining("# App"),
    });

    getMemoryCurrent.mockResolvedValueOnce({
      current: { enabled: true, content: "# App" },
    });
    const private_ = await buildMemoryTurn({
      db: {} as never,
      systemPrompt: "BASE",
      userId: "user-1",
    });
    expect(private_.systemPrompt).toContain(
      "CURRENT MEMORY AUDIENCE: PRIVATE TO THE ACTIVE USER",
    );
  });

  it("leaves the prompt untouched for a surface that opts out", async () => {
    await expect(
      buildMemoryTurn({
        db: {} as never,
        systemPrompt: "BASE",
        userId: "user-1",
        include: false,
      }),
    ).resolves.toEqual({ message: null, systemPrompt: "BASE" });
    expect(getMemoryCurrent).not.toHaveBeenCalled();
  });

  it("omits disabled content and contains strict read failures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    getMemoryCurrent
      .mockRejectedValueOnce(new Error("storage unavailable"))
      .mockResolvedValueOnce({
        current: { enabled: false, content: "must not appear" },
      });

    await expect(
      buildMemoryTurn({
        db: {} as never,
        systemPrompt: "BASE",
        userId: "user-1",
        projectId: "project-1",
      }),
    ).resolves.toMatchObject({ message: null, systemPrompt: "BASE" });
    expect(warn).toHaveBeenCalledWith(
      "[memory-context] scoped memory could not be loaded",
      { scope: "app" },
    );
    warn.mockRestore();
  });
});
