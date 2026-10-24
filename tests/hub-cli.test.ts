import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TUNNEL_CHOICE_PROMPT } from "../src/tunnel/state.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const CLI = path.join(process.cwd(), "bin", "c2c.js");

describe("c2c CLI: workspace registry, prefs and sandbox-allow", () => {
  let stateDir: string;
  let codexHome: string;
  const dirs: string[] = [];

  beforeEach(() => {
    stateDir = makeTmpDir("cli-state");
    codexHome = makeTmpDir("cli-codex");
    dirs.push(stateDir, codexHome);
  });

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
  });

  /** Run the real CLI against an isolated state dir and Codex home. */
  function c2c(...args: string[]): { status: number | null; json: Record<string, any>; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      env: { ...process.env, C2C_STATE_DIR: stateDir, CODEX_HOME: codexHome },
    });
    let json: Record<string, any> = {};
    try {
      json = JSON.parse(result.stdout);
    } catch {
      // non-JSON output: callers read stdout
    }
    return { status: result.status, json, stdout: result.stdout, stderr: result.stderr };
  }

  function project(name: string): string {
    const dir = makeTmpDir(name);
    dirs.push(dir);
    return dir;
  }

  it("uses the same JSON error shape for hub and non-hub failures", () => {
    const missing = c2c("workspace", "add", path.join(stateDir, "..", "no-such-folder"), "--json");
    expect(missing.status).toBe(1);
    expect(missing.json.ok).toBe(false);
    expect(missing.json.error).toMatch(/does not exist/);
    const unsafe = c2c("workspace", "add", os.homedir(), "--json");
    expect(typeof unsafe.json.error).toBe("string");
    expect(unsafe.json.code).toBe("UNSAFE_ROOT");
  });

  it("adds idempotently, lists and removes", () => {
    const dir = project("demo");
    const first = c2c("workspace", "add", dir, "--name", "demo", "--json");
    expect(first.status, first.stderr).toBe(0);
    expect(first.json).toMatchObject({ ok: true, created: true, workspace: { name: "demo" } });

    const again = c2c("workspace", "add", dir, "--name", "demo", "--json");
    expect(again.json.created).toBe(false);
    expect(again.json.workspace.id).toBe(first.json.workspace.id);

    expect(c2c("workspace", "list", "--json").json.workspaces.map((w: { name: string }) => w.name)).toEqual(["demo"]);

    const removed = c2c("workspace", "remove", "demo", "--json");
    expect(removed.status).toBe(0);
    expect(removed.json.removed.name).toBe("demo");
    expect(c2c("workspace", "list", "--json").json.workspaces).toEqual([]);

    const missing = c2c("workspace", "remove", "demo", "--json");
    expect(missing.status).toBe(1);
    expect(missing.json.ok).toBe(false);
  });

  it("refuses roots that would expose too much", () => {
    const cases: Array<[string, string[], RegExp]> = [
      ["drive root", [path.parse(process.cwd()).root], /drive root/],
      ["home directory", [os.homedir()], /home directory/],
      ["state directory", [stateDir], /state directory/],
      ["hub placeholder", ["-w", "hub"], /hub placeholder/], // its own guard, not the state-dir one
    ];
    for (const [label, args, message] of cases) {
      const result = c2c("workspace", "add", ...args, "--json");
      expect(result.status, label).toBe(1);
      expect(result.json.code, label).toBe("UNSAFE_ROOT");
      expect(result.json.error, label).toMatch(message); // `error` is the message, like every other command
    }
    expect(c2c("workspace", "list", "--json").json.workspaces).toEqual([]);
  });

  it("registers every project when several adds run at once (smoke test; mutual exclusion is shown in hub.test.ts)", async () => {
    const names = ["p1", "p2", "p3", "p4", "p5", "p6"];
    const runs = names.map(
      (name) =>
        new Promise<number | null>((resolve) => {
          const child = spawn(process.execPath, [CLI, "workspace", "add", project(name), "--name", name, "--json"], {
            env: { ...process.env, C2C_STATE_DIR: stateDir, CODEX_HOME: codexHome },
            stdio: "ignore",
          });
          child.on("close", resolve);
        })
    );
    expect(await Promise.all(runs)).toEqual(names.map(() => 0));
    const listed = c2c("workspace", "list", "--json").json.workspaces.map((w: { name: string }) => w.name);
    expect(listed.sort()).toEqual(names);
  }, 60_000);

  it("reports an unreadable registry and does not overwrite it", () => {
    c2c("workspace", "add", project("keep"), "--name", "keep", "--json");
    const file = path.join(stateDir, "registry", "workspaces.json");
    fs.writeFileSync(file, "{ not json");

    for (const args of [
      ["workspace", "list", "--json"],
      ["workspace", "remove", "keep", "--json"],
      ["workspace", "add", project("other"), "--json"],
    ]) {
      const result = c2c(...args);
      expect(result.status, args.join(" ")).toBe(1);
      expect(result.json.code, args.join(" ")).toBe("REGISTRY_CORRUPT");
      expect(result.json.registry, args.join(" ")).toBe(file); // the local user is told which file
    }
    expect(fs.readFileSync(file, "utf8")).toBe("{ not json");
  });

  it("remembers the default zone and conversation, and a new workspace reports them", () => {
    const saved = c2c("prefs", "set", "--default-zone", "example.com", "--default-conversation", "long-chat", "--json");
    expect(saved.status, saved.stderr).toBe(0);
    expect(saved.json).toMatchObject({ defaultNamedZone: "example.com", defaultConversationMode: "long-chat" });
    expect(c2c("prefs", "--json").json).toMatchObject({ defaultNamedZone: "example.com" });

    const status = c2c("tunnel", "status", "-w", project("fresh"), "--json");
    expect(status.json.needsChoice).toBe(true);
    expect(status.json.defaultChoice).toEqual({ mode: "named", zone: "example.com" });
    expect(status.json.userPrompt).toBeUndefined();

    // the human-readable output must not ask the question either
    const text = c2c("tunnel", "status", "-w", project("fresh-text"));
    expect(text.stdout).toContain("无需询问"); // text only the default-zone branch prints (the prompt itself mentions example.com)
    expect(text.stdout).toContain("example.com");
    expect(text.stdout).not.toContain(TUNNEL_CHOICE_PROMPT);

    // a brand-new workspace starts in long-chat without asking
    const session = c2c("session", "-w", project("fresh-session"), "--json");
    expect(session.json.conversation).toMatchObject({ mode: "long-chat", reason: "default-long-chat" });

    const bad = c2c("prefs", "set", "--default-conversation", "tabs", "--json");
    expect(bad.status).toBe(1);
    expect(bad.stdout + bad.stderr).toMatch(/default-conversation must be one of long-chat, project/);
  });

  it("sandbox-allow still writes the Codex allowlist into the isolated CODEX_HOME", () => {
    const result = c2c("sandbox-allow", "--json");
    expect(result.status, result.stderr).toBe(0);
    expect(result.json.ok).toBe(true);
    expect(fs.existsSync(path.join(codexHome, "config.toml"))).toBe(true);
    expect(c2c("sandbox-allow", "--json").json.alreadyAllowed).toBe(true);
  });
});
