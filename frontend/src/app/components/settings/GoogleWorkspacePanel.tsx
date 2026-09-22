"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  GoogleWorkspaceProvider,
  GoogleWorkspaceStatus,
  GoogleWorkspaceActionReview,
} from "@mike/contracts";
import {
  getGoogleWorkspaceStatus,
  startGoogleWorkspaceOAuth,
  cancelGoogleWorkspaceOAuth,
  disconnectGoogleWorkspace,
  listGoogleWorkspaceActions,
  decideGoogleWorkspaceAction,
  isMfaRequiredError,
} from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { MfaVerificationPopup } from "@/app/components/popups/MfaVerificationPopup";
import { SettingsCard } from "./SettingsCard";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";

const names = { gmail: "Gmail", "google-calendar": "Google Calendar" };
const actionNames: Record<string, string> = {
  gmail_propose_send: "Send email",
  gmail_propose_save_draft: "Save draft",
  gmail_propose_delete_draft: "Delete draft",
  gmail_propose_modify: "Change email labels",
  gmail_propose_trash: "Move email to Trash",
  google_calendar_propose_create: "Create event",
  google_calendar_propose_update: "Edit event",
  google_calendar_propose_delete: "Delete event",
};
const labels: Record<string, string> = {
  to: "To",
  cc: "Cc",
  bcc: "Bcc",
  subject: "Subject",
  body: "Message",
  calendar_id: "Calendar",
  event_id: "Event",
  draft_id: "Draft",
  message_id: "Message",
  summary: "Title",
  description: "Description",
  location: "Location",
  start: "Start",
  end: "End (exclusive for all-day events)",
  attendees: "Attendees",
  add_label_ids: "Add labels",
  remove_label_ids: "Remove labels",
  date: "Date",
  dateTime: "Date and time",
  timeZone: "Time zone",
  email: "Email",
};
function display(value: unknown): string {
  if (Array.isArray(value)) return value.map(display).join("\n");
  if (value && typeof value === "object")
    return Object.entries(value)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([key, v]) => `${labels[key] ?? key}: ${display(v)}`)
      .join("\n");
  return String(value ?? "");
}
class FlowError extends Error {}
type Sensitive = (
  action: () => Promise<void>,
  retry?: () => Promise<void>,
) => Promise<void>;
function ConnectionCard({
  provider,
  sensitive,
  changed,
}: {
  provider: GoogleWorkspaceProvider;
  sensitive: Sensitive;
  changed: () => void;
}) {
  const [status, setStatus] = useState<GoogleWorkspaceStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const name = names[provider];
  useEffect(() => {
    let mounted = true;
    getGoogleWorkspaceStatus(provider)
      .then((s) => {
        if (mounted) setStatus(s);
      })
      .catch(() => {
        if (mounted) setError(`Could not load ${name}. Reload this page.`);
      });
    return () => {
      mounted = false;
      abortRef.current?.abort();
    };
  }, [provider, name]);
  const connect = async (write = false) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError(null);
    const popup = window.open(
      "about:blank",
      `mike_${provider}_oauth`,
      "popup,width=560,height=720",
    );
    let pending: string | null = null;
    try {
      if (!popup)
        throw new FlowError(
          "Allow popups for Mike, then try connecting again.",
        );
      await sensitive(
        async () => {
          const { authorizationUrl } = await startGoogleWorkspaceOAuth(
            provider,
            write,
          );
          pending = new URL(authorizationUrl).searchParams.get("state");
          if (controller.signal.aborted)
            throw new FlowError("Authorization cancelled.");
          popup.location.href = authorizationUrl;
          const started = Date.now();
          while (Date.now() - started < 300_000) {
            if (controller.signal.aborted)
              throw new FlowError("Authorization cancelled.");
            const current = await getGoogleWorkspaceStatus(provider);
            if (
              current.connected &&
              current.grantId !== status?.grantId &&
              current.writeEnabled === write
            ) {
              pending = null;
              setStatus(current);
              changed();
              return;
            }
            await new Promise<void>((resolve) => {
              const done = () => {
                clearTimeout(timer);
                controller.signal.removeEventListener("abort", done);
                resolve();
              };
              const timer = setTimeout(done, 1500);
              controller.signal.addEventListener("abort", done, { once: true });
              if (controller.signal.aborted) done();
            });
          }
          throw new FlowError("Google authorization timed out. Try again.");
        },
        () => connect(write),
      );
    } catch (e) {
      setError(
        e instanceof FlowError
          ? e.message
          : userFacingApiError(e, `Could not connect ${name}.`),
      );
    } finally {
      if (pending) {
        try {
          await cancelGoogleWorkspaceOAuth(provider, pending);
          setStatus(await getGoogleWorkspaceStatus(provider));
        } catch {
          setError(
            "Could not cancel authorization. Close the Google window and reload this page.",
          );
        }
      }
      try {
        popup?.close();
      } catch {
        /* Google may sever window.opener. */
      }
      setBusy(false);
    }
  };
  const disconnect = async () => {
    try {
      await sensitive(async () => {
        setBusy(true);
        setError(null);
        try {
          await disconnectGoogleWorkspace(provider);
          setStatus(await getGoogleWorkspaceStatus(provider));
          changed();
        } finally {
          setBusy(false);
        }
      });
    } catch (e) {
      setError(userFacingApiError(e, `Could not disconnect ${name}.`));
    }
  };
  return (
    <SettingsCard>
      <section className="space-y-3 p-4" aria-label={`${name} connection`}>
        <div>
          <h3 className="text-sm font-medium">{name}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {provider === "gmail"
              ? "Search and read email."
              : "Search calendars and read events."}{" "}
            Connect any Google account you choose, independently of your Mike
            sign-in.
          </p>
        </div>
        {!status ? (
          <p className="text-xs" role="status">
            {error ? "Unavailable" : "Loading…"}
          </p>
        ) : (
          <>
            <p className="text-sm">
              {status.connected
                ? `Connected as ${status.accountEmail ?? "your selected Google account"} · ${status.writeEnabled ? "Writes require approval" : "Read-only"}`
                : "Not connected"}
            </p>
            {!status.schemaReady ? (
              <p className="text-xs text-muted-foreground">
                This server needs the Gmail and Calendar database migration.
              </p>
            ) : !status.configured ? (
              <p className="text-xs text-muted-foreground">
                An administrator must configure a Google OAuth client.
              </p>
            ) : null}
            {status.redirectUri && !status.connected && (
              <details className="text-xs text-muted-foreground">
                <summary>Connection setup</summary>
                <p className="mt-2 break-all">
                  Authorized redirect URI: {status.redirectUri}
                </p>
              </details>
            )}
            <div className="flex flex-wrap gap-2">
              <PillButtonUI
                tone="blue"
                disabled={busy || !status.configured || !status.schemaReady}
                onClick={() => void connect(false)}
              >
                {status.connected
                  ? "Choose another account / read-only"
                  : "Connect read-only"}
              </PillButtonUI>
              {status.connected && !status.writeEnabled && (
                <PillButtonUI
                  tone="white"
                  disabled={busy}
                  onClick={() => void connect(true)}
                >
                  Enable writes with approval
                </PillButtonUI>
              )}
              {status.connected && (
                <PillButtonUI
                  tone="white"
                  disabled={busy}
                  onClick={() => void disconnect()}
                >
                  Disconnect
                </PillButtonUI>
              )}
              {busy && (
                <PillButtonUI
                  tone="white"
                  onClick={() => abortRef.current?.abort()}
                >
                  Cancel authorization
                </PillButtonUI>
              )}
            </div>
            {busy && (
              <p role="status" className="text-xs">
                Waiting for Google…
              </p>
            )}
            {status.connected && (
              <p className="text-xs text-muted-foreground">
                Enabling writes opens a new Google consent request. Every action
                still needs your approval below. Disconnecting removes this
                service from Mike; manage all app permissions in your Google
                account.
              </p>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </section>
    </SettingsCard>
  );
}
export function GoogleWorkspacePanel() {
  const [actions, setActions] = useState<GoogleWorkspaceActionReview[] | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [mfa, setMfa] = useState(false);
  const retryRef = useRef<(() => Promise<void>) | null>(null);
  const refresh = useCallback(async () => {
    try {
      const result = await listGoogleWorkspaceActions();
      setActions(result.actions);
    } catch {
      setError("Could not load Google action proposals.");
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const sensitive: Sensitive = async (action, retry = action) => {
    try {
      await action();
    } catch (e) {
      if (isMfaRequiredError(e)) {
        retryRef.current = retry;
        setMfa(true);
      } else throw e;
    }
  };
  const decide = async (id: string, decision: "approve" | "reject") => {
    setError(null);
    setBusy(id);
    try {
      await sensitive(async () => {
        const result = await decideGoogleWorkspaceAction(id, decision);
        if (result && result.status !== "succeeded") setError(result.message);
        await refresh();
      });
    } catch (e) {
      setError(
        userFacingApiError(
          e,
          "Could not complete this decision. Refresh and check its status before retrying.",
        ),
      );
      await refresh();
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="mb-3 space-y-3">
      <p className="text-xs text-muted-foreground">
        Google sign-in never connects your email or calendar automatically. Each
        connection below is optional.
      </p>
      <ConnectionCard
        provider="gmail"
        sensitive={sensitive}
        changed={() => void refresh()}
      />
      <ConnectionCard
        provider="google-calendar"
        sensitive={sensitive}
        changed={() => void refresh()}
      />
      <SettingsCard>
        <section
          id="google-actions"
          aria-label="Google action approvals"
          className="space-y-3 p-4"
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium">Review Google actions</h3>
            <PillButtonUI tone="white" onClick={() => void refresh()}>
              Refresh proposals
            </PillButtonUI>
          </div>
          <p className="text-xs text-muted-foreground">
            The assistant can prepare changes, but nothing is sent or changed
            until you approve the exact action here. Proposals expire after 10
            minutes. Review all recipients and contents.
          </p>
          {actions === null ? (
            <p role="status" className="text-sm">
              Loading proposals…
            </p>
          ) : !actions.length ? (
            <p className="text-sm text-muted-foreground">
              No action proposals.
            </p>
          ) : (
            actions.map((action) => (
              <article
                key={action.id}
                className="space-y-3 rounded-lg bg-app-surface p-3"
              >
                <h4 className="text-sm font-medium">
                  {actionNames[action.proposal.tool] ?? "Google action"}
                </h4>
                <p className="text-xs">
                  Account: {action.proposal.accountEmail}
                </p>
                <p className="text-xs">
                  Status: {action.status}
                  {action.status === "pending"
                    ? ` · Expires ${new Date(action.expiresAt).toLocaleTimeString()}`
                    : ""}
                </p>
                {action.provider === "google-calendar" && (
                  <p className="text-sm">
                    Google will notify attendees of this change. Deleting an
                    event sends cancellation notices.
                  </p>
                )}
                {action.proposal.tool === "gmail_propose_delete_draft" && (
                  <p className="text-sm">
                    This deletes the draft. Review its contents before
                    approving.
                  </p>
                )}
                <dl className="space-y-2 text-sm">
                  {Object.entries(action.proposal.args).map(([k, v]) => (
                    <div key={k}>
                      <dt className="font-medium">{labels[k] ?? k}</dt>
                      <dd className="whitespace-pre-wrap break-words">
                        {display(v)}
                      </dd>
                    </div>
                  ))}
                </dl>
                {action.proposal.before !== undefined && (
                  <details>
                    <summary className="text-sm cursor-pointer">
                      Current item before this change
                    </summary>
                    <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">
                      {display(action.proposal.before)}
                    </pre>
                  </details>
                )}
                {action.resultMessage && (
                  <p className="text-sm" role="status">
                    {action.resultMessage}
                  </p>
                )}
                {action.status === "executing" && (
                  <p className="text-xs">
                    Execution has started. If this status persists, check Google
                    before requesting another action; Mike will not run this
                    approval again.
                  </p>
                )}
                {action.status === "pending" && (
                  <div className="flex gap-2">
                    <PillButtonUI
                      tone="blue"
                      disabled={
                        busy !== null ||
                        Date.parse(action.expiresAt) <= Date.now()
                      }
                      onClick={() => void decide(action.id, "approve")}
                    >
                      Approve{" "}
                      {actionNames[action.proposal.tool]?.toLowerCase() ??
                        "action"}
                    </PillButtonUI>
                    <PillButtonUI
                      tone="white"
                      disabled={busy !== null}
                      onClick={() => void decide(action.id, "reject")}
                    >
                      Reject
                    </PillButtonUI>
                  </div>
                )}
              </article>
            ))
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </section>
      </SettingsCard>
      <MfaVerificationPopup
        open={mfa}
        onCancel={() => {
          setMfa(false);
          retryRef.current = null;
        }}
        onVerified={() => {
          setMfa(false);
          const retry = retryRef.current;
          retryRef.current = null;
          if (retry)
            void sensitive(retry).catch((e) =>
              setError(
                userFacingApiError(
                  e,
                  "Could not complete the verified action.",
                ),
              ),
            );
        }}
      />
    </div>
  );
}
