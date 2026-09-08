import { beforeEach, describe, expect, it, vi } from "vitest";

const { ensureMemoryFile, wipeMemoryFile } = vi.hoisted(() => ({
  ensureMemoryFile: vi.fn(),
  wipeMemoryFile: vi.fn(),
}));

vi.mock("./files", () => ({
  ensureMemoryFile,
  wipeMemoryFile,
}));

import { deleteUserPrivateMemories } from "./bulk";

function queryResult(data: unknown[]) {
  const query: Record<string, unknown> = {};
  for (const method of ["select", "eq", "is", "in"]) {
    query[method] = vi.fn(() => query);
  }
  query.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve({ data, error: null }).then(resolve);
  return query;
}

describe("deleteUserPrivateMemories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("wipes app memory and existing memories for private projects the user created", async () => {
    const appFile = { id: "app", enabled: true };
    const projectFile = { id: "project-p1", enabled: false };
    ensureMemoryFile.mockResolvedValue(appFile);
    wipeMemoryFile.mockResolvedValue({});
    const projectQuery = queryResult([{ id: "p1" }]);
    const memoryQuery = queryResult([projectFile]);
    const db = {
      from: vi.fn((table: string) =>
        table === "projects" ? projectQuery : memoryQuery,
      ),
    };

    const result = await deleteUserPrivateMemories(db as never, "u1");

    expect((projectQuery.eq as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      "user_id",
      "u1",
    );
    expect((projectQuery.is as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      "org_id",
      null,
    );
    expect(ensureMemoryFile).toHaveBeenCalledWith(db, "user", "u1");
    expect(wipeMemoryFile).toHaveBeenCalledTimes(2);
    expect(wipeMemoryFile).toHaveBeenCalledWith({
      db,
      file: appFile,
      enabled: null,
      updatedBy: "u1",
      source: "wipe",
    });
    expect(wipeMemoryFile).toHaveBeenCalledWith({
      db,
      file: projectFile,
      enabled: null,
      updatedBy: "u1",
      source: "wipe",
    });
    expect(result).toEqual({ projectMemoriesDeleted: 1 });
  });
});
