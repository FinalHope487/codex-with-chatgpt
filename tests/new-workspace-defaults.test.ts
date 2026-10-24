import { afterEach, describe, expect, it } from "vitest";
import { mergeUiPrefs, readUiPrefs } from "../src/config/ui-prefs.js";
import { resolveConversation } from "../src/session/state.js";
import { cleanup, isolateStateDir } from "./helpers.js";

describe("machine-wide defaults for a brand-new workspace", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  it("keeps upstream behaviour (Project) when nothing is configured", () => {
    dirs.push(isolateStateDir());
    const view = resolveConversation(null);
    expect(view.mode).toBe("project");
    expect(view.reason).toBe("new-workspace");
    expect(view.projectReady).toBe(false);
  });

  it("starts a new workspace in long-chat when the default says so", () => {
    dirs.push(isolateStateDir());
    mergeUiPrefs({ defaultConversationMode: "long-chat" });
    const view = resolveConversation(null);
    expect(view.mode).toBe("long-chat");
    expect(view.reason).toBe("default-long-chat");
    expect(view.chatUrl).toBeNull();
    expect(view.reuseSavedChat).toBe(false);
  });

  it("does not override a workspace that already has a session", () => {
    dirs.push(isolateStateDir());
    mergeUiPrefs({ defaultConversationMode: "long-chat" });
    const view = resolveConversation({
      conversationMode: "project",
      projectUrl: "https://chatgpt.com/g/g-p-abc123/project",
      savedAt: "2026-10-24T00:00:00.000Z",
    });
    expect(view.mode).toBe("project");
    expect(view.projectReady).toBe(true);
  });

  it("remembers the default zone and conversation mode without dropping other prefs", () => {
    dirs.push(isolateStateDir());
    mergeUiPrefs({ setupMode: "auto" });
    mergeUiPrefs({ defaultNamedZone: "example.com" });
    const next = mergeUiPrefs({ defaultConversationMode: "project" });
    expect(next.setupMode).toBe("auto");
    expect(next.defaultNamedZone).toBe("example.com");
    expect(next.defaultConversationMode).toBe("project");
    expect(readUiPrefs().defaultNamedZone).toBe("example.com");
  });

  it("rejects an unknown default conversation mode", () => {
    dirs.push(isolateStateDir());
    expect(() => mergeUiPrefs({ defaultConversationMode: "tabs" as "project" })).toThrow(/default-conversation/);
    expect(readUiPrefs().defaultConversationMode).toBeNull();
  });
});
