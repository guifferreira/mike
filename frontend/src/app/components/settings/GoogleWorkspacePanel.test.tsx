import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { GoogleWorkspacePanel } from "./GoogleWorkspacePanel";
import * as api from "@/app/lib/mikeApi";
vi.mock("@/app/lib/mikeApi", async (original) => ({
  ...(await original<typeof import("@/app/lib/mikeApi")>()),
  getGoogleWorkspaceStatus: vi.fn(),
  startGoogleWorkspaceOAuth: vi.fn(),
  cancelGoogleWorkspaceOAuth: vi.fn(),
  disconnectGoogleWorkspace: vi.fn(),
  listGoogleWorkspaceActions: vi.fn(),
  decideGoogleWorkspaceAction: vi.fn(),
}));
vi.mock("@/app/components/popups/MfaVerificationPopup", () => ({
  MfaVerificationPopup: ({
    open,
    onVerified,
  }: {
    open: boolean;
    onVerified: () => void;
  }) => (open ? <button onClick={onVerified}>Verify test MFA</button> : null),
}));
const base = {
  configured: true,
  schemaReady: true,
  connected: false,
  writeEnabled: false,
  redirectUri: "http://localhost:3000/api/callback",
};
const pending = {
  id: "a1",
  provider: "gmail" as const,
  status: "pending" as const,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  resultMessage: null,
  proposal: {
    tool: "gmail_propose_send",
    accountEmail: "mail-account@example.com",
    args: {
      to: ["recipient@example.com"],
      subject: "Contract update",
      body: "Exact proposed body",
    },
  },
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.getGoogleWorkspaceStatus).mockResolvedValue(base);
  vi.mocked(api.listGoogleWorkspaceActions).mockResolvedValue({ actions: [] });
  vi.mocked(api.cancelGoogleWorkspaceOAuth).mockResolvedValue();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const gmail = () =>
  within(screen.getByRole("region", { name: "Gmail connection" }));
describe("opt-in Google connections and action review", () => {
  it("does not start OAuth or request write access when visiting settings, even for Google sign-in", async () => {
    render(<GoogleWorkspacePanel />);
    await screen.findAllByText("Not connected");
    expect(api.startGoogleWorkspaceOAuth).not.toHaveBeenCalled();
    expect(api.decideGoogleWorkspaceAction).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Google sign-in never connects/),
    ).toBeInTheDocument();
    expect(
      gmail().getByRole("button", { name: "Connect read-only" }),
    ).toBeEnabled();
  });
  it("shows the selected account, independently of the Mike login", async () => {
    vi.mocked(api.getGoogleWorkspaceStatus).mockResolvedValue({
      ...base,
      connected: true,
      accountEmail: "other-account@example.com",
      grantId: "g1",
    });
    render(<GoogleWorkspacePanel />);
    await screen.findAllByText(/Connected as other-account@example.com/);
    expect(
      gmail().getByRole("button", { name: "Enable writes with approval" }),
    ).toBeVisible();
  });
  it("shows exact content and recipients and never approves on render", async () => {
    vi.mocked(api.listGoogleWorkspaceActions).mockResolvedValue({
      actions: [pending],
    });
    render(<GoogleWorkspacePanel />);
    await screen.findByText("Exact proposed body");
    expect(screen.getByText("recipient@example.com")).toBeVisible();
    expect(screen.getByText(/Account: mail-account/)).toBeVisible();
    expect(api.decideGoogleWorkspaceAction).not.toHaveBeenCalled();
    vi.mocked(api.decideGoogleWorkspaceAction).mockResolvedValue({
      status: "succeeded",
      message: "Done",
    });
    fireEvent.click(screen.getByRole("button", { name: "Approve send email" }));
    await waitFor(() =>
      expect(api.decideGoogleWorkspaceAction).toHaveBeenCalledWith(
        "a1",
        "approve",
      ),
    );
  });
  it("rejects separately and disables an expired proposal", async () => {
    vi.mocked(api.listGoogleWorkspaceActions).mockResolvedValue({
      actions: [pending, { ...pending, id: "a2", expiresAt: "2000-01-01" }],
    });
    render(<GoogleWorkspacePanel />);
    await screen.findAllByText("Exact proposed body");
    expect(
      screen.getAllByRole("button", { name: "Approve send email" })[1],
    ).toBeDisabled();
    fireEvent.click(screen.getAllByRole("button", { name: "Reject" })[0]);
    await waitFor(() =>
      expect(api.decideGoogleWorkspaceAction).toHaveBeenCalledWith(
        "a1",
        "reject",
      ),
    );
  });
  it("connects with read-only consent and accepts only a new grant when changing accounts", async () => {
    const popup = { location: { href: "" }, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    vi.mocked(api.startGoogleWorkspaceOAuth).mockResolvedValue({
      authorizationUrl: "https://accounts.google.com/auth?state=state",
    });
    render(<GoogleWorkspacePanel />);
    await screen.findAllByText("Not connected");
    vi.mocked(api.getGoogleWorkspaceStatus).mockResolvedValue({
      ...base,
      connected: true,
      accountEmail: "new@example.com",
      grantId: "new",
    });
    fireEvent.click(gmail().getByRole("button", { name: "Connect read-only" }));
    await screen.findByText(/Connected as new@example.com/);
    expect(api.startGoogleWorkspaceOAuth).toHaveBeenCalledWith("gmail", false);
    expect(popup.close).toHaveBeenCalled();
  });
  it("does not treat the existing read grant as a completed write upgrade", async () => {
    vi.mocked(api.getGoogleWorkspaceStatus).mockResolvedValue({
      ...base,
      connected: true,
      grantId: "old",
      accountEmail: "old@example.com",
    });
    const popup = { location: { href: "" }, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    vi.mocked(api.startGoogleWorkspaceOAuth).mockResolvedValue({
      authorizationUrl: "https://accounts.google.com/auth?state=state",
    });
    render(<GoogleWorkspacePanel />);
    await screen.findAllByText(/Connected as old/);
    fireEvent.click(
      gmail().getByRole("button", { name: "Enable writes with approval" }),
    );
    await waitFor(() =>
      expect(api.startGoogleWorkspaceOAuth).toHaveBeenCalledWith("gmail", true),
    );
    expect(gmail().getByText("Waiting for Google…")).toBeVisible();
    fireEvent.click(
      gmail().getByRole("button", { name: "Cancel authorization" }),
    );
    await waitFor(() =>
      expect(api.cancelGoogleWorkspaceOAuth).toHaveBeenCalledWith(
        "gmail",
        "state",
      ),
    );
  });
  it("reopens OAuth after MFA instead of reusing a closed popup", async () => {
    const popups = [
      { location: { href: "" }, close: vi.fn() },
      { location: { href: "" }, close: vi.fn() },
    ];
    vi.spyOn(window, "open")
      .mockReturnValueOnce(popups[0] as unknown as Window)
      .mockReturnValueOnce(popups[1] as unknown as Window);
    vi.mocked(api.startGoogleWorkspaceOAuth)
      .mockRejectedValueOnce(
        new api.MikeApiError({
          status: 403,
          message: "MFA",
          code: "mfa_verification_required",
        }),
      )
      .mockResolvedValueOnce({
        authorizationUrl: "https://accounts.google.com/auth?state=state",
      });
    render(<GoogleWorkspacePanel />);
    await screen.findAllByText("Not connected");
    fireEvent.click(gmail().getByRole("button", { name: "Connect read-only" }));
    await screen.findByRole("button", { name: "Verify test MFA" });
    vi.mocked(api.getGoogleWorkspaceStatus).mockResolvedValue({
      ...base,
      connected: true,
      grantId: "new",
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify test MFA" }));
    await waitFor(() => expect(window.open).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(popups[1].location.href).toContain("accounts.google.com"),
    );
  });
  it("cancels server state when cancellation occurs while start is in flight", async () => {
    let resolve!: (v: { authorizationUrl: string }) => void;
    vi.mocked(api.startGoogleWorkspaceOAuth).mockReturnValue(
      new Promise((r) => (resolve = r)),
    );
    vi.spyOn(window, "open").mockReturnValue({
      location: { href: "" },
      close: vi.fn(),
    } as unknown as Window);
    render(<GoogleWorkspacePanel />);
    await screen.findAllByText("Not connected");
    fireEvent.click(gmail().getByRole("button", { name: "Connect read-only" }));
    fireEvent.click(
      gmail().getByRole("button", { name: "Cancel authorization" }),
    );
    await act(async () =>
      resolve({
        authorizationUrl: "https://accounts.google.com/auth?state=pending",
      }),
    );
    expect(api.cancelGoogleWorkspaceOAuth).toHaveBeenCalledWith(
      "gmail",
      "pending",
    );
  });
});
