import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStore } from "../src/auth/store.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const SCOPES = ["workspace.read", "offline_access"];

describe("auth state survives a bridge restart", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
  });

  function newFile(): string {
    const dir = makeTmpDir("auth-persist");
    dirs.push(dir);
    return path.join(dir, "ws.json");
  }

  it("keeps the registered client and a still-valid access token", () => {
    const file = newFile();
    const before = new AuthStore("ws", { file });
    const client = before.registerClient({ clientName: "ChatGPT", redirectUris: ["https://chatgpt.com/cb"] });
    const { accessToken } = before.issueTokens({ clientId: client.clientId, scopes: SCOPES });

    const after = new AuthStore("ws", { file });
    expect(after.getClient(client.clientId)?.clientName).toBe("ChatGPT");
    expect(after.verifyAccessToken(accessToken).ok).toBe(true);
  });

  it("lets ChatGPT refresh after restart once the access token has expired, without re-pairing", async () => {
    const file = newFile();
    const before = new AuthStore("ws", { file });
    const client = before.registerClient({ redirectUris: ["https://chatgpt.com/cb"] });
    const issued = before.issueTokens({ clientId: client.clientId, scopes: SCOPES, accessTtlMs: 5 });
    expect(issued.refreshToken).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const after = new AuthStore("ws", { file });
    expect(after.verifyAccessToken(issued.accessToken).ok).toBe(false);

    const refreshed = after.refresh(issued.refreshToken as string, client.clientId);
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) return;
    expect(after.verifyAccessToken(refreshed.tokens.accessToken).ok).toBe(true);

    // rotation is persisted too: the old refresh token is dead after another restart
    const third = new AuthStore("ws", { file });
    expect(third.refresh(issued.refreshToken as string, client.clientId).ok).toBe(false);
    expect(third.verifyAccessToken(refreshed.tokens.accessToken).ok).toBe(true);
  });

  it("does not resurrect tokens after unpair", () => {
    const file = newFile();
    const before = new AuthStore("ws", { file });
    const client = before.registerClient({ redirectUris: ["https://chatgpt.com/cb"] });
    const { accessToken } = before.issueTokens({ clientId: client.clientId, scopes: SCOPES });
    before.revokeAll();

    const after = new AuthStore("ws", { file });
    expect(after.verifyAccessToken(accessToken).ok).toBe(false);
    expect(after.tokenCount()).toBe(0);
  });
});
