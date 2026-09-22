import { test, expect } from "@playwright/test";

// Exercise the actual settings page/popup/polling in Chromium while replacing
// only the Google integration endpoints. No Google credentials or consent UI.
test("Google Drive connect, cancel and disconnect", async ({
    page,
    context,
}) => {
    let connected = false;
    let cancelled = false;
    const state = "a".repeat(32);
    await context.route("https://accounts.google.com/**", (route) =>
        route.fulfill({
            contentType: "text/html",
            body: "<p>Mock Google consent</p>",
        }),
    );
    await page.route(
        "**/api/user/integrations/google-drive**",
        async (route) => {
            const url = new URL(route.request().url());
            if (url.pathname.endsWith("/oauth/start")) {
                return route.fulfill({
                    json: {
                        authorizationUrl: `https://accounts.google.com/authorize?state=${state}`,
                    },
                });
            }
            if (url.pathname.endsWith("/oauth/cancel")) {
                expect(route.request().postDataJSON()).toEqual({ state });
                cancelled = true;
                return route.fulfill({ status: 204 });
            }
            if (route.request().method() === "DELETE") {
                connected = false;
                return route.fulfill({ status: 204 });
            }
            return route.fulfill({
                json: {
                    connected,
                    scope: connected
                        ? "https://www.googleapis.com/auth/drive.readonly"
                        : null,
                    configured: true,
                    schemaReady: true,
                },
            });
        },
    );
    await page.goto("/settings/connectors");
    const connect = page.getByRole("button", { name: "Connect", exact: true });
    await expect(connect).toBeEnabled();
    const firstPopup = context.waitForEvent("page");
    await connect.click();
    const popup = await firstPopup;
    await expect(
        page.getByRole("button", { name: "Waiting for Google…" }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByText("Authorization cancelled.")).toBeVisible();
    expect(cancelled).toBe(true);
    await expect(connect).toBeEnabled();
    if (!popup.isClosed()) await popup.close();

    await connect.click();
    connected = true; // Represents the successful server-side code exchange.
    const disconnect = page.getByRole("button", {
        name: "Disconnect",
        exact: true,
    });
    await expect(disconnect).toBeVisible();
    await disconnect.click();
    await expect(connect).toBeEnabled();
    expect(connected).toBe(false);
});
