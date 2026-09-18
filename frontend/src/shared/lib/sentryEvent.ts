/**
 * Sentry event hygiene shared by the web app (browser + Next server) and the
 * Word add-in. Framework-free on purpose: this file must not import from
 * `@/app/` (the add-in bundles it through a webpack alias) and it must not
 * import a Sentry package either, because the two targets use different
 * ones (`@sentry/nextjs` vs `@sentry/react`) — the structural types below
 * are the subset both agree on.
 *
 * Two jobs:
 *
 *  1. SCRUB. Mike handles privileged legal documents. An event may carry a
 *     user id and a route; it must never carry a request body, a cookie, an
 *     auth header, or anything under a key that looks like a secret.
 *  2. DEDUPE. Every remaining `console.error` is bridged into Sentry so no
 *     failure is silently dropped, but code that already reported an error
 *     explicitly (with tags) logs it too. The explicit path marks the error
 *     object; the bridge's copy of a marked error is discarded.
 */

export const CONSOLE_CAPTURE_MECHANISM = "auto.core.capture_console";

// BEGIN shared-redaction
// This block is the privacy control for every runtime. It is authored once
// and mirrored, indentation aside, between backend/src/lib/observability/
// sentry.ts and frontend/src/shared/lib/sentryEvent.ts (the backend cannot
// import the frontend tree at build time). sentryEvent.sync.test.ts fails
// the moment the two copies differ, so edit both or neither.
const SENSITIVE_HEADERS = new Set([
    "authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "x-supabase-auth",
]);
const SENSITIVE_KEY_PATTERN =
    /(token|secret|password|passwd|authorization|cookie|api[-_]?key|credential|private[-_]?key)/i;
const MAX_SCRUB_DEPTH = 6;
/**
  * Query parameters whose VALUE is a credential, plus the two OAuth callback
  * parameters (an authorization code is single-use but still a credential
  * until it is exchanged) and S3 presigned-URL signature fields.
  */
const SENSITIVE_QUERY_PATTERN =
    /(token|secret|password|passwd|authorization|cookie|api[-_]?key|credential|private[-_]?key|signature|^code$|^state$|^sig$|^x-amz-(signature|credential|security-token)$)/i;
/** Path segments whose NEXT segment is a token: GET /download/<token>. */
const TOKEN_PATH_SEGMENTS = new Set(["download"]);
/** Keys whose string value is a path or URL: redactUrl sees bare paths too. */
const URL_KEY_PATTERN =
    /^(url|href|path|query_string|referer|referrer|location|redirect(_uri)?)$/i;

/**
  * Strip credentials from a URL or path while keeping it recognisable:
  * `/download/<token>` → `/download/[Filtered]`, `?code=…&state=…` →
  * `?code=[Filtered]&state=[Filtered]`.
  */
export function redactUrl(value: string): string {
    const queryStart = value.indexOf("?");
    const pathPart = queryStart === -1 ? value : value.slice(0, queryStart);
    const query = queryStart === -1 ? null : value.slice(queryStart + 1);
    const segments = pathPart.split("/");
    for (let i = 0; i < segments.length - 1; i += 1) {
        const segment = segments[i];
        if (
            segment !== undefined &&
            TOKEN_PATH_SEGMENTS.has(segment) &&
            segments[i + 1]
        ) {
            segments[i + 1] = "[Filtered]";
        }
    }
    let out = segments.join("/");
    if (query !== null) {
        out += `?${redactQueryString(query)}`;
    }
    return out;
}

function redactQueryString(query: string): string {
    return query
        .split("&")
        .map((pair) => {
            // Idempotent: text redaction may run over an already scrubbed URL.
            if (pair.endsWith("=[Filtered]")) return pair;
            const eq = pair.indexOf("=");
            const key = eq === -1 ? pair : pair.slice(0, eq);
            let name = key;
            try {
                name = decodeURIComponent(key);
            } catch {
                // Keep the raw key; it still gets pattern-matched below.
            }
            return SENSITIVE_QUERY_PATTERN.test(name) ? `${key}=[Filtered]` : pair;
        })
        .join("&");
}

/** The SDK may hand query parameters over as a string, a map, or pairs. */
function redactQueryParams(value: unknown): unknown {
    if (typeof value === "string") return redactQueryString(value);
    if (Array.isArray(value)) {
        return value.map((entry) =>
            Array.isArray(entry) && typeof entry[0] === "string"
                ? SENSITIVE_QUERY_PATTERN.test(entry[0])
                    ? [entry[0], "[Filtered]"]
                    : entry
                : entry,
        );
    }
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value as object)) {
            out[key] = SENSITIVE_QUERY_PATTERN.test(key) ? "[Filtered]" : entry;
        }
        return out;
    }
    return value;
}

/**
  * Secrets and identities that appear INSIDE free text: a Postgres error
  * quoting the email it collided on, an HTTP client echoing an Authorization
  * header, a provider key in a stack frame, a presigned URL in a log line.
  * Key-based filtering cannot see any of these, so every string that lands
  * on an event — the title, the exception text, extras, breadcrumbs — goes
  * through here. Order matters: URLs first so their query strings are
  * handled by redactUrl, then bearer tokens before the bare-JWT pattern.
  */
const TEXT_PATTERNS: Array<[RegExp, string | ((match: string) => string)]> = [
    [/https?:\/\/[^\s"'<>]+/g, (match) => redactUrl(match)],
    [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [Filtered]"],
    [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{2,}(?:\.[A-Za-z0-9_-]*)?/g, "[jwt]"],
    [/\bsk-[A-Za-z0-9_-]{8,}/g, "[api-key]"],
    [/\bAKIA[0-9A-Z]{16}\b/g, "[aws-key]"],
    [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g, "[github-token]"],
    [/\bxox[abprs]-[A-Za-z0-9-]{8,}/g, "[slack-token]"],
    [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
];

export function redactText(value: string): string {
    let out = value;
    for (const [pattern, replacement] of TEXT_PATTERNS) {
        out =
            typeof replacement === "string"
                ? out.replace(pattern, replacement)
                : out.replace(pattern, replacement);
    }
    return out;
}

/**
  * Keys allowed under `extra` and breadcrumb data, at any depth. Everything
  * else is replaced, not only secret-looking keys: an `extra.note` holding a
  * contract clause has no telltale name, and the console bridge copies whole
  * logged objects into `extra.arguments`. The list is the ids and error
  * fields this codebase actually attaches; extend it deliberately.
  */
const EXTRA_KEY_ALLOWLIST = new Set([
    "arguments",
    "body",
    "code",
    "dedupe_key",
    "detail",
    "document_id",
    "documentId",
    "err",
    "error",
    "error_stack",
    "exit_code",
    "file_id",
    "fileId",
    "id",
    "job_id",
    "jobId",
    "kind",
    "message",
    "name",
    "path",
    "request_id",
    "requestId",
    "review_id",
    "reviewId",
    "row_id",
    "rowId",
    "session_id",
    "sessionId",
    "stack",
    "stage",
    "status",
    "statusCode",
    "tool",
    "tool_call_id",
    "unhandledPromiseRejection",
    "url",
    "version_id",
    "versionId",
    "worker_id",
    "workerId",
]);

/** A string leaf: bare paths under URL-shaped keys get redactUrl as well. */
function redactLeaf(key: string, value: string): string {
    return redactText(URL_KEY_PATTERN.test(key) ? redactUrl(value) : value);
}

/** Free-form application data (extra, breadcrumb data): allowlist + text. */
export function scrubFreeform(value: unknown, depth = 0): unknown {
    if (depth > MAX_SCRUB_DEPTH) return "[Truncated]";
    if (typeof value === "string") return redactText(value);
    if (Array.isArray(value)) {
        return value.map((item) => scrubFreeform(item, depth + 1));
    }
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value as object)) {
            out[key] =
                EXTRA_KEY_ALLOWLIST.has(key) && !SENSITIVE_KEY_PATTERN.test(key)
                    ? typeof entry === "string"
                        ? redactLeaf(key, entry)
                        : scrubFreeform(entry, depth + 1)
                    : "[Filtered]";
        }
        return out;
    }
    return value;
}

/** SDK-shaped data (contexts: os, runtime, device…): denylist + text. */
export function redactShaped(value: unknown, depth = 0): unknown {
    if (depth > MAX_SCRUB_DEPTH) return "[Truncated]";
    if (typeof value === "string") return redactText(value);
    if (Array.isArray(value)) {
        return value.map((item) => redactShaped(item, depth + 1));
    }
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value as object)) {
            out[key] = SENSITIVE_KEY_PATTERN.test(key)
                ? "[Filtered]"
                : typeof entry === "string"
                    ? redactLeaf(key, entry)
                    : redactShaped(entry, depth + 1);
        }
        return out;
    }
    return value;
}
// END shared-redaction

/** The pieces of a Sentry event this module reads or rewrites. */
// No index signatures: the SDKs' `ErrorEvent` is an interface, and an
// interface is not assignable to an indexable type, so the shape below must
// name only the properties it touches.
export type ScrubbableEvent = {
    /** Set to "console" by the console bridge on every event it creates. */
    logger?: string;
    message?: string;
    fingerprint?: string[];
    tags?: Record<string, unknown>;
    exception?: {
        values?: {
            type?: string;
            value?: string;
            mechanism?: { type?: string };
        }[];
    };
    request?: {
        data?: unknown;
        cookies?: unknown;
        headers?: Record<string, string>;
        url?: string;
        query_string?: unknown;
    };
    user?: { id?: string | number };
    extra?: Record<string, unknown>;
    contexts?: Record<string, unknown>;
    breadcrumbs?: { message?: string; data?: Record<string, unknown> }[];
};

export type ScrubHint = {
    originalException?: unknown;
    /**
     * The console bridge passes its raw `console.error` arguments here
     * (`{ extra: { arguments } }`); by the time `beforeSend` runs the copy on
     * the event has been normalised, so this is the only place the original
     * objects can still be recognised.
     */
    captureContext?: unknown;
};

const NESTED_SEARCH_DEPTH = 2;

function consoleArguments(hint: ScrubHint): unknown[] | null {
    const context = hint.captureContext as
        | { extra?: { arguments?: unknown } }
        | undefined;
    const args = context?.extra?.arguments;
    return Array.isArray(args) ? args : null;
}

function findNested(
    value: unknown,
    predicate: (candidate: object) => boolean,
    depth = 0,
): object | null {
    if (!value || typeof value !== "object") return null;
    if (predicate(value)) return value;
    if (depth >= NESTED_SEARCH_DEPTH) return null;
    for (const entry of Object.values(value)) {
        const found = findNested(entry, predicate, depth + 1);
        if (found) return found;
    }
    return null;
}

/** Kept for callers and tests: SDK-shaped redaction. */
export const redactSensitiveValues = redactShaped;

const DEFAULT_MAX_EVENTS_PER_ISSUE_PER_MINUTE = 10;
const THROTTLE_WINDOW_MS = 60_000;

function issueKey(event: ScrubbableEvent): string {
    if (event.fingerprint?.length) return event.fingerprint.join("|");
    const exception = event.exception?.values?.[0];
    const base = exception
        ? `${exception.type ?? "Error"}: ${exception.value ?? ""}`
        : (event.message ?? "");
    const component = (event.tags as Record<string, unknown> | undefined)
        ?.component;
    return `${component ?? ""}::${base.slice(0, 300)}`;
}

/**
 * A registry of errors already sent with explicit context, plus per-issue
 * flood control. Each runtime (web app, add-in) creates one and installs its
 * scrubber as `beforeSend`.
 *
 * Flood control: a render loop or a retry loop can raise the same error many
 * times a second, and Sentry only collapses strictly consecutive duplicates.
 * The first `maxEventsPerIssuePerMinute` events of an issue go out; the rest
 * are dropped locally so the quota stays for the next, different bug.
 */
export function createEventScrubber(options?: {
    maxEventsPerIssuePerMinute?: number;
    now?: () => number;
}) {
    const reported = new WeakSet<object>();
    const budget =
        options?.maxEventsPerIssuePerMinute ??
        DEFAULT_MAX_EVENTS_PER_ISSUE_PER_MINUTE;
    const now = options?.now ?? (() => Date.now());
    const buckets = new Map<string, { windowStart: number; sent: number }>();

    const withinBudget = (event: ScrubbableEvent): boolean => {
        const key = issueKey(event);
        const at = now();
        let bucket = buckets.get(key);
        if (!bucket || at - bucket.windowStart >= THROTTLE_WINDOW_MS) {
            bucket = { windowStart: at, sent: 0 };
            buckets.set(key, bucket);
        }
        if (bucket.sent >= budget) return false;
        bucket.sent += 1;
        return true;
    };

    const markReported = (error: unknown): void => {
        if (error && typeof error === "object") reported.add(error);
    };

    const scrubEvent = <T extends ScrubbableEvent>(
        event: T,
        hint: ScrubHint = {},
    ): T | null => {
        const mechanism = event.exception?.values?.[0]?.mechanism?.type;
        const original = hint.originalException;
        if (
            mechanism === CONSOLE_CAPTURE_MECHANISM &&
            original &&
            typeof original === "object" &&
            reported.has(original)
        ) {
            return null;
        }

        // console.error("[label] failed", { jobId, error }) — the common shape
        // in this codebase. The bridge only recognises a top-level Error, so
        // it sends this as a message titled "[label] failed [object Object]".
        // Recover: drop it if that nested error was already reported, else
        // give the message the error's name and text and group by label.
        const args =
            event.logger === "console" ? consoleArguments(hint) : null;
        if (args) {
            if (args.some((arg) => findNested(arg, (c) => reported.has(c)))) {
                return null;
            }
            const nestedError = args
                .map((arg) =>
                    typeof arg === "object" && arg instanceof Error
                        ? null
                        : findNested(arg, (c) => c instanceof Error),
                )
                .find((found): found is Error => found instanceof Error);
            if (nestedError) {
                const label = args
                    .filter((arg): arg is string => typeof arg === "string")
                    .join(" ")
                    .trim();
                event.message = `${label ? `${label}: ` : ""}${nestedError.name}: ${nestedError.message}`;
                event.fingerprint = ["console", label, nestedError.name];
                event.extra = {
                    ...(event.extra ?? {}),
                    error_stack: nestedError.stack,
                };
            }
        }

        // The title and the exception text are free text from libraries
        // that quote emails, tokens, and URLs; key filtering cannot see them.
        if (typeof event.message === "string") {
            event.message = redactText(event.message);
        }
        for (const value of event.exception?.values ?? []) {
            if (typeof value.value === "string") {
                value.value = redactText(value.value);
            }
        }
        if (event.request) {
            delete event.request.data;
            delete event.request.cookies;
            // The URL stays (it says which endpoint), its credentials do not.
            if (typeof event.request.url === "string") {
                event.request.url = redactUrl(event.request.url);
            }
            if (event.request.query_string !== undefined) {
                event.request.query_string = redactQueryParams(
                    event.request.query_string,
                );
            }
            if (event.request.headers) {
                for (const name of Object.keys(event.request.headers)) {
                    if (SENSITIVE_HEADERS.has(name.toLowerCase())) {
                        delete event.request.headers[name];
                    }
                }
            }
        }
        if (event.user) {
            event.user = event.user.id ? { id: event.user.id } : undefined;
        }
        if (event.extra) {
            event.extra = scrubFreeform(event.extra) as Record<string, unknown>;
        }
        if (event.contexts) {
            event.contexts = redactShaped(event.contexts) as Record<
                string,
                unknown
            >;
        }
        if (event.breadcrumbs) {
            event.breadcrumbs = event.breadcrumbs.map((crumb) => ({
                ...crumb,
                ...(typeof crumb.message === "string"
                    ? { message: redactText(crumb.message) }
                    : {}),
                ...(crumb.data
                    ? { data: scrubFreeform(crumb.data) as Record<string, unknown> }
                    : {}),
            }));
        }
        if (!withinBudget(event)) return null;
        return event;
    };

    return { markReported, scrubEvent };
}

/**
 * Collapse ids out of an API path so one failing endpoint groups as one
 * Sentry issue: /projects/8f1c…/documents/42 → /projects/:id/documents/:id.
 */
export function normalizeApiPath(path: string): string {
    const withoutQuery = path.split("?")[0] ?? path;
    return withoutQuery
        .replace(
            /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
            ":id",
        )
        .replace(/\/\d+(?=\/|$)/g, "/:id");
}

/** Clamp an env-provided sample rate to [0, 1]; anything unparseable → fallback. */
export function parseSampleRate(
    raw: string | undefined,
    fallback: number,
): number {
    if (!raw) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(parsed, 0), 1);
}

/**
 * The release every event is tagged with. An explicit SENTRY_RELEASE wins;
 * otherwise the git commit the build came from (`mike@<sha12>`), which is
 * what lets Sentry say "regressed in this deploy" and resolve an issue
 * until the next release. Undefined when neither is known (a dev checkout).
 */
export function releaseName(
    explicit: string | undefined,
    gitSha: string | undefined,
): string | undefined {
    const named = explicit?.trim();
    if (named) return named;
    const sha = gitSha?.trim();
    return sha ? `mike@${sha.slice(0, 12)}` : undefined;
}
