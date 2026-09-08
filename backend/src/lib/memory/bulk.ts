import type { Db } from "../dbq/types";
import {
  ensureMemoryFile,
  wipeMemoryFile,
  type MemoryFileRow,
} from "./files";

const PROJECT_BATCH_SIZE = 200;

function chunks<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    out.push(values.slice(index, index + size));
  }
  return out;
}

/**
 * Delete personal memory without reaching into an organization's data or a
 * project that merely happens to be shared with this user.
 */
export async function deleteUserPrivateMemories(
  db: Db,
  userId: string,
): Promise<{ projectMemoriesDeleted: number }> {
  const { data: projects, error: projectsError } = await db
    .from("projects")
    .select("id")
    .eq("user_id", userId)
    .is("org_id", null);
  if (projectsError) throw new Error("Failed to load private projects");

  const projectIds = (projects ?? [])
    .map((project: { id?: string | null }) => project.id)
    .filter((id): id is string => !!id);
  const projectFiles: MemoryFileRow[] = [];
  for (const batch of chunks(projectIds, PROJECT_BATCH_SIZE)) {
    const { data, error } = await db
      .from("memory_files")
      .select("*")
      .eq("scope", "project")
      .in("project_id", batch);
    if (error) throw new Error("Failed to load private project memories");
    projectFiles.push(...((data ?? []) as MemoryFileRow[]));
  }

  const appFile = await ensureMemoryFile(db, "user", userId);
  for (const file of [appFile, ...projectFiles]) {
    await wipeMemoryFile({
      db,
      file,
      enabled: null,
      updatedBy: userId,
      source: "wipe",
    });
  }

  return { projectMemoriesDeleted: projectFiles.length };
}
