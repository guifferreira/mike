import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const backendRoot = resolve(__dirname, "../../../..");
const sources = [
  ["schema", readFileSync(resolve(backendRoot, "schema.sql"), "utf8"), true],
  [
    "migration",
    readFileSync(
      resolve(backendRoot, "migrations/20260905_01_scoped_memory_files.sql"),
      "utf8",
    ),
    false,
  ],
] as const;
const projectDefaultMigration = readFileSync(
  resolve(
    backendRoot,
    "migrations/20260907_01_project_memory_default_on.sql",
  ),
  "utf8",
);

function functionBody(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("\n$$;", start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe.each(sources)(
  "%s scoped memory SQL",
  (_name, sql, projectDefaultsOn) => {
    it("keeps account rollout explicit and applies the expected project default", () => {
      expect(sql).toMatch(/enabled boolean not null default true/);
      expect(sql).toMatch(
        /insert into public\.memory_files\(scope, user_id, enabled\)[\s\S]*select 'user', id, false from auth\.users/,
      );
      expect(sql).toMatch(
        new RegExp(
          `insert into public\\.memory_files\\(scope, project_id, enabled\\)[\\s\\S]*select 'project', id, ${projectDefaultsOn ? "true" : "false"} from public\\.projects`,
        ),
      );
    });

    it("creates each project and its explicit memory setting atomically", () => {
      const body = functionBody(sql, "create_project_with_memory");
      expect(body).toContain("insert into public.projects");
      expect(body).toContain("insert into public.memory_files");
      expect(body).toContain("p_memory_enabled");
      expect(body).not.toMatch(/exception[\s\S]*delete from public\.projects/i);
    });

    it("uses per-turn leases and a conversation-global quiet generation for every scope", () => {
      const begin = functionBody(sql, "begin_memory_conversation_turn");
      const release = functionBody(sql, "release_memory_conversation_turn");
      const schedule = functionBody(sql, "schedule_memory_consolidation");
      expect(sql).toContain("create table if not exists public.memory_conversation_turn_leases");
      expect(begin).toContain("insert into public.memory_conversation_turn_leases");
      expect(begin).toContain("quiet_until");
      expect(release).toContain("activity_id = p_activity_id");
      expect(release).toContain("make_interval(secs => p_quiet_seconds)");
      expect(schedule).toContain("'appEpoch'");
      expect(schedule).toContain("'projectEpoch'");
      expect(schedule).toContain("'conversationGeneration'");
      expect(schedule).toContain("memory_conversation_activity");
      expect(schedule).toContain("lease.activity_id = p_activity_id");
      expect(schedule).toContain("set memory_eligible_at = terminal_at");
      expect(schedule).toContain(
        "message.content @> jsonb_build_array(jsonb_build_object(",
      );
      expect(schedule).not.toContain(
        "memory_eligible_at = terminal_at, author_user_id",
      );
      expect(schedule).toContain("next_conversation_generation := activity.generation + 1");
      expect(schedule).toContain("project_curator_actor_user_id");
      expect(schedule).toContain("order by memory_file.id");
      expect(schedule).toContain("order by pending.actor_user_id, pending.id");
      expect(schedule).toContain(
        `values ('project', activity.project_id, ${projectDefaultsOn ? "true" : "false"})`,
      );
    });

    it("keeps state status updates from taking file locks in reverse order", () => {
      const stateStatus = functionBody(
        sql,
        "set_memory_consolidation_status",
      );
      expect(stateStatus).not.toContain("update public.memory_files");
      const fileStatus = functionBody(sql, "refresh_memory_file_status");
      expect(fileStatus).toContain("job.status = 'pending'");
      expect(fileStatus).toContain("job.status = 'running'");
      expect(fileStatus).toContain("job.id <> p_current_job_id");
    });

    it("records direct-user attribution on every conversational message table", () => {
      expect(sql.match(/author_user_id uuid references auth\.users\(id\)/g)?.length)
        .toBeGreaterThanOrEqual(3);
      expect(sql.match(/memory_input_message_id uuid/g)?.length)
        .toBeGreaterThanOrEqual(3);
      expect(sql.match(/memory_eligible_at timestamptz/g)?.length)
        .toBeGreaterThanOrEqual(3);
    });

    it("keeps all security-definer scheduling APIs service-only", () => {
      expect(sql).toMatch(
        /revoke all on function public\.begin_memory_conversation_turn\(text, uuid, uuid, uuid, integer, integer\)[\s\S]*from public, anon, authenticated/,
      );
      expect(sql).toMatch(
        /revoke all on function public\.release_memory_conversation_turn\(text, uuid, uuid, integer\)[\s\S]*from public, anon, authenticated/,
      );
      expect(sql).toMatch(
        /revoke all on function public\.schedule_memory_consolidation\(text, uuid, uuid, uuid, uuid, uuid, integer\)[\s\S]*from public, anon, authenticated/,
      );
      expect(sql).toMatch(
        /grant execute\s+on function public\.schedule_memory_consolidation\(text, uuid, uuid, uuid, uuid, uuid, integer\)[\s\S]*to service_role/,
      );
    });
  },
);

const schemaSql = sources[0][1];
const inlineContentMigration = readFileSync(
  resolve(
    backendRoot,
    "migrations/20260907_02_memory_files_inline_content.sql",
  ),
  "utf8",
);
const revisionRenameMigration = readFileSync(
  resolve(backendRoot, "migrations/20260907_05_memory_revision_rename.sql"),
  "utf8",
);
const candidateKindMigration = readFileSync(
  resolve(
    backendRoot,
    "migrations/20260907_04_drop_memory_candidate_cleanup_kind.sql",
  ),
  "utf8",
);

describe.each([
  ["schema", schemaSql],
  ["migration", revisionRenameMigration],
] as const)("%s direct memory writes", (_name, sql) => {
  it("fences a curator write before it touches the file row", () => {
    const body = functionBody(sql, "write_memory_file");
    expect(body).toContain("memory_job_superseded");
    expect(body).toContain("consolidation.generation <> p_consolidation_generation");
    expect(body).toContain("activity.generation <> p_conversation_generation");
    expect(body).toContain("activity.quiet_until > now()");
    expect(body).toContain("memory_conversation_turn_leases");
    expect(body.indexOf("select * into activity")).toBeLessThan(
      body.indexOf("select * into consolidation"),
    );
    expect(body.indexOf("select * into consolidation")).toBeLessThan(
      body.indexOf("select * into target"),
    );
  });

  it("writes the body onto the locked file row and replays a retried job once", () => {
    const body = functionBody(sql, "write_memory_file");
    expect(body).toContain("where id = p_memory_file_id\n  for update");
    expect(body).toContain("set content = p_content");
    expect(body).toContain("content_sha256 = p_content_sha256");
    expect(body).toContain("revision = target.revision + 1");
    expect(body).toContain("last_source_job_id = p_source_job_id");
    expect(body).toMatch(
      /target\.last_source_job_id = p_source_job_id[\s\S]*return query select false, target\.revision/,
    );
    expect(body).toContain("memory_revision_conflict");
    expect(body).toContain("memory_epoch_conflict");
  });

  it("erases the body in the same update that fences in-flight learning", () => {
    const body = functionBody(sql, "wipe_memory_file");
    expect(body).toContain("content = ''");
    expect(body).toContain("content_sha256 = null");
    expect(body).toContain("size_bytes = 0");
    expect(body).toContain("target.epoch + 1");
    expect(body).toContain("target.revision + 1");
    expect(body).toContain("coalesce(p_enabled, target.enabled)");
    expect(body).not.toContain("insert into public.db_jobs");
  });

  it("keeps every direct-write API service-only", () => {
    for (const signature of [
      "public\\.write_memory_file\\(uuid, bigint, bigint, text, text, integer, text, uuid, text, uuid, uuid, uuid, bigint, bigint, bigint\\)",
      "public\\.wipe_memory_file\\(uuid, boolean, uuid, text\\)",
    ]) {
      expect(sql).toMatch(
        new RegExp(
          `revoke all on function ${signature}[\\s\\S]*from public, anon, authenticated`,
        ),
      );
      expect(sql).toMatch(
        new RegExp(
          `grant execute\\s+on function ${signature}[\\s\\S]*to service_role`,
        ),
      );
    }
  });
});

describe.each([
  ["schema", schemaSql],
  ["migration", candidateKindMigration],
] as const)("%s destructive cleanup claims", (_name, sql) => {
  it("reclaims cleanup jobs indefinitely after worker crashes", () => {
    const batchClaim = functionBody(sql, "claim_db_jobs");
    const singleClaim = functionBody(sql, "claim_db_job");
    for (const body of [batchClaim, singleClaim]) {
      expect(body).toContain("'storage.cleanup'");
      expect(body).toContain("2147483647");
      expect(body).toMatch(/status = 'failed'[\s\S]*storage\.cleanup/);
      expect(body).toMatch(/status = 'running'[\s\S]*storage\.cleanup/);
      // The candidate-cleanup kind has no enqueuer or handler any more.
      expect(body).not.toContain("memory.candidate_cleanup");
    }
    expect(batchClaim).toMatch(
      /attempts >= max_attempts[\s\S]*kind <> 'storage\.cleanup'/,
    );
  });
});

describe("memory version removal SQL", () => {
  it("leaves no version or upload-candidate objects behind", () => {
    for (const gone of ["memory_file_versions", "memory_object_candidates"]) {
      expect(schemaSql.includes(gone)).toBe(false);
    }
    // The superseded functions may only survive as the drops that retire
    // them on a database that still has them.
    for (const gone of [
      "advance_memory_file",
      "begin_memory_file_upload",
      "claim_memory_upload_candidate",
      "fence_memory_file_delete",
    ]) {
      expect(schemaSql).not.toContain(
        `create or replace function public.${gone}`,
      );
    }
    // `current_version_id` still belongs to documents; only the memory file
    // stopped pointing at a separate row.
    const memoryFilesTable = schemaSql.slice(
      schemaSql.indexOf("create table if not exists public.memory_files ("),
      schemaSql.indexOf("create unique index if not exists memory_files_user_unique"),
    );
    expect(memoryFilesTable).not.toContain("current_version_id");
    expect(memoryFilesTable).toContain("content text not null default ''");
    expect(memoryFilesTable).toContain("last_source_job_id uuid");
  });

  it("reclaims the objects it orphans and retires their cleanup jobs", () => {
    expect(inlineContentMigration).toContain("jsonb_build_array('memories/')");
    expect(inlineContentMigration).toMatch(
      /delete from public\.db_jobs[\s\S]*kind = 'memory\.candidate_cleanup'/,
    );
    const enqueue = inlineContentMigration.indexOf("'storage.cleanup'");
    const drop = inlineContentMigration.indexOf(
      "drop table if exists public.memory_file_versions",
    );
    expect(enqueue).toBeGreaterThanOrEqual(0);
    expect(drop).toBeGreaterThan(enqueue);
    for (const dropped of [
      "drop table if exists public.memory_object_candidates cascade;",
      "drop function if exists public.claim_memory_upload_candidate(uuid);",
      "drop trigger if exists memory_files_delete_fence on public.memory_files;",
      "alter table public.memory_files drop column if exists current_version_id;",
    ]) {
      expect(inlineContentMigration).toContain(dropped);
    }
  });
});

describe("project memory default-on upgrade SQL", () => {
  it("only enables untouched backfill rows and advances their learning cutoff", () => {
    expect(projectDefaultMigration).toMatch(
      /set enabled = true,[\s\S]*learning_cutoff_at = greatest\(file\.learning_cutoff_at, now\(\)\)/,
    );
    for (const predicate of [
      "file.enabled = false",
      "file.epoch = 0",
      "file.version = 0",
      "file.status = 'idle'",
      "file.current_version_id is null",
      "file.last_source is null",
      "file.last_error_code is null",
      "file.updated_by is null",
      "file.created_at > project.created_at",
    ]) {
      expect(projectDefaultMigration).toContain(predicate);
    }
  });

  it("idempotently upgrades only the scheduler's missing-project default", () => {
    expect(projectDefaultMigration).toContain(
      "pg_get_functiondef(scheduler)",
    );
    expect(projectDefaultMigration).toContain(
      "values (''project'', activity.project_id, false)",
    );
    expect(projectDefaultMigration).toContain(
      "values (''project'', activity.project_id, true)",
    );
    expect(projectDefaultMigration).toContain("disabled_occurrences <> 1");
    expect(projectDefaultMigration).toMatch(
      /disabled_occurrences = 0[\s\S]*position\(enabled_literal in definition\) > 0[\s\S]*return/,
    );
  });
});
