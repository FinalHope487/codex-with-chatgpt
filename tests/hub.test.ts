import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { appendExecutionRecord } from "../src/execution/records.js";
import { Workspace } from "../src/workspace/manager.js";
import {
  addWorkspace,
  createHubContext,
  findRegistered,
  hubRoot,
  isHubRoot,
  listRegistered,
  registryFile,
  registryHealth,
  removeWorkspace,
  sanitizeName,
  HubError,
} from "../src/hub/registry.js";
import { cleanup, isolateStateDir, makeGitRepo, makeTmpDir, write } from "./helpers.js";

function textOf(result: { content?: unknown }): string {
  return (result.content as { text: string }[])?.[0]?.text ?? "";
}

describe("hub registry", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  function project(name: string): string {
    const dir = makeTmpDir(name);
    dirs.push(dir);
    return dir;
  }

  it("starts empty, registers idempotently and persists", () => {
    dirs.push(isolateStateDir());
    expect(listRegistered()).toEqual([]);
    const root = project("alpha");
    const first = addWorkspace(root);
    expect(first.created).toBe(true);
    expect(first.workspace.root).toBe(fs.realpathSync.native(root));
    expect(addWorkspace(root).created).toBe(false);
    expect(listRegistered()).toHaveLength(1);
    expect(findRegistered(first.workspace.id.toUpperCase())?.id).toBe(first.workspace.id);
    expect(findRegistered(first.workspace.name.toUpperCase())?.id).toBe(first.workspace.id);
  });

  it("renames on re-add with --name and rejects a taken name", () => {
    dirs.push(isolateStateDir());
    const one = project("one");
    const a = addWorkspace(one, { name: "app" });
    const b = project("two");
    expect(() => addWorkspace(b, { name: "APP" })).toThrow(HubError);
    const second = addWorkspace(b, { name: "other" });
    expect(second.workspace.name).toBe("other");
    // re-adding the same folder with its own name is a no-op, not a clash
    const again = addWorkspace(one, { name: "app" });
    expect(again.created).toBe(false);
    expect(again.workspace.id).toBe(a.workspace.id);
    // renaming onto another workspace's name is refused
    expect(() => addWorkspace(one, { name: "other" })).toThrow(HubError);
    expect(listRegistered().map((w) => w.name).sort()).toEqual(["app", "other"]);
  });

  it("never overwrites an unreadable registry (it would unregister every other project)", () => {
    dirs.push(isolateStateDir());
    const keep = addWorkspace(project("keep"), { name: "keep" }).workspace;
    const file = registryFile();
    for (const garbage of ["{ not json", "", '{"workspaces":"nope"}', JSON.stringify({ workspaces: [{ id: 1 }] })]) {
      fs.writeFileSync(file, garbage);
      expect(() => listRegistered(), garbage).toThrow(/unreadable/);
      expect(() => addWorkspace(project("new")), garbage).toThrow(HubError);
      expect(() => removeWorkspace("keep"), garbage).toThrow(HubError);
      expect(fs.readFileSync(file, "utf8"), garbage).toBe(garbage); // untouched
    }
    fs.writeFileSync(file, JSON.stringify({ workspaces: [keep] }));
    expect(listRegistered()).toEqual([keep]);
  });

  it("doctor health: red when empty or unreadable, green when projects are registered", () => {
    dirs.push(isolateStateDir());
    expect(registryHealth()).toMatchObject({ ok: false });
    addWorkspace(project("healthy"), { name: "healthy" });
    expect(registryHealth()).toEqual({ ok: true, detail: "healthy" });
    fs.writeFileSync(registryFile(), "{ not json");
    expect(registryHealth()).toMatchObject({ ok: false, detail: expect.stringContaining("unreadable") });
  });

  it("keeps names unique, including auto-disambiguated ones and ids", () => {
    dirs.push(isolateStateDir());
    const folder = (parentName: string): string => {
      const parent = makeTmpDir(parentName);
      dirs.push(parent);
      const dir = path.join(parent, "app");
      fs.mkdirSync(dir);
      return dir;
    };
    const first = addWorkspace(folder("p1")).workspace;
    expect(first.name).toBe("app");
    const thirdDir = folder("p3");
    const thirdId = new Workspace(thirdDir).id;
    // occupy the name the third folder would be given automatically
    addWorkspace(project("squatter"), { name: `app-${thirdId.slice(0, 4)}` });
    const third = addWorkspace(thirdDir).workspace;
    expect(third.name).toBe(`app-${thirdId.slice(0, 6)}`);
    const names = listRegistered().map((w) => w.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    // a name can never be another project's id
    expect(() => addWorkspace(project("clash"), { name: first.id })).toThrow(/already used/);
  });

  it("routes an exact id before any name", () => {
    dirs.push(isolateStateDir());
    const one = addWorkspace(project("one"), { name: "one" }).workspace;
    const two = addWorkspace(project("two"), { name: "two" }).workspace;
    expect(findRegistered(two.id)?.name).toBe("two");
    expect(findRegistered(one.id)?.name).toBe("one");
    expect(findRegistered("TWO")?.id).toBe(two.id);
  });

  it("an id beats a name even if a hand-edited registry makes them collide", () => {
    dirs.push(isolateStateDir());
    const entry = (id: string, name: string) => ({ id, name, root: project(name), addedAt: "2026-10-24T00:00:00.000Z" });
    // "squatter" is listed first and is *named* like victim's id
    const squatter = entry("aaaaaaaaaaaa", "bbbbbbbbbbbb");
    const victim = entry("bbbbbbbbbbbb", "victim");
    fs.writeFileSync(registryFile(), JSON.stringify({ workspaces: [squatter, victim] }));
    expect(findRegistered("bbbbbbbbbbbb")?.name).toBe("victim");
  });

  it("registry lock: a stale lock is cleared and a live lock blocks the update", () => {
    dirs.push(isolateStateDir());
    const lock = `${registryFile()}.lock`;
    fs.writeFileSync(lock, "");
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lock, old, old);
    expect(addWorkspace(project("after-stale"), { name: "after-stale" }).created).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);

    fs.writeFileSync(lock, ""); // fresh: another process is mid-update
    expect(() => addWorkspace(project("blocked"), { name: "blocked" })).toThrow(/updating the workspace registry/);
    expect(listRegistered().map((w) => w.name)).toEqual(["after-stale"]);
    fs.rmSync(lock);
  }, 20_000);

  it("reports a registered folder that became a file as invalid, not missing, without leaking its path", () => {
    dirs.push(isolateStateDir());
    const parent = makeTmpDir("became-file");
    dirs.push(parent);
    const dir = path.join(parent, "proj");
    fs.mkdirSync(dir);
    addWorkspace(dir, { name: "proj" });
    fs.rmSync(dir, { recursive: true, force: true });
    fs.writeFileSync(dir, "now a file");
    let caught: unknown;
    try {
      createHubContext().resolve("proj");
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string } | undefined)?.code).toBe("WORKSPACE_ROOT_INVALID");
    expect((caught as Error).message).not.toContain(parent); // reaches ChatGPT: no local paths
  });

  it("distinguishes a registry that cannot be read from one that is corrupt, without leaking its path", () => {
    const state = isolateStateDir();
    dirs.push(state);
    addWorkspace(project("keep"), { name: "keep" });
    fs.rmSync(registryFile());
    fs.mkdirSync(registryFile()); // reading a directory fails with EISDIR, not a parse error
    let caught: unknown;
    try {
      listRegistered();
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string }).code).toBe("REGISTRY_UNREADABLE");
    expect((caught as Error).message).not.toContain(state);
    expect((caught as Error).message).toMatch(/do not delete/);
  });

  it("leaves no temp file behind after a save", () => {
    dirs.push(isolateStateDir());
    addWorkspace(project("tidy"));
    expect(fs.readdirSync(path.dirname(registryFile()))).toEqual(["workspaces.json"]);
  });

  it("disambiguates two folders that share a name", () => {
    dirs.push(isolateStateDir());
    const make = (): string => {
      const parent = makeTmpDir("parent");
      dirs.push(parent);
      const dir = path.join(parent, "app");
      fs.mkdirSync(dir);
      return dir;
    };
    const a = addWorkspace(make());
    const b = addWorkspace(make());
    expect(a.workspace.name).toBe("app");
    expect(b.workspace.name).toMatch(/^app-[0-9a-f]{4}$/);
  });

  it("removes a workspace by name or id", () => {
    dirs.push(isolateStateDir());
    const a = addWorkspace(project("gone")).workspace;
    expect(removeWorkspace("nope")).toBeNull();
    expect(removeWorkspace(a.name)?.id).toBe(a.id);
    expect(listRegistered()).toEqual([]);
  });

  it("refuses roots that are too broad or expose C2C's secrets", () => {
    const state = isolateStateDir();
    dirs.push(state);
    expect(() => addWorkspace(path.parse(state).root)).toThrow(/root/i);
    expect(() => addWorkspace(os.homedir())).toThrow(/home/i);
    expect(() => addWorkspace(path.dirname(os.homedir()))).toThrow(/home/i);
    expect(() => addWorkspace(state)).toThrow(/state directory/i);
    expect(() => addWorkspace(path.dirname(state))).toThrow(/state directory/i);
    expect(() => addWorkspace(hubRoot())).toThrow(/state directory/i);
    expect(() => addWorkspace(path.join(state, "does-not-exist"))).toThrow(/does not exist/);
    expect(listRegistered()).toEqual([]);
  });

  it("recognises the hub root and sanitizes names", () => {
    dirs.push(isolateStateDir());
    expect(isHubRoot(hubRoot())).toBe(true);
    expect(isHubRoot(project("not-hub"))).toBe(false);
    expect(sanitizeName("My App (v2)")).toBe("My-App-v2");
    expect(sanitizeName("資料結構")).toBe("資料結構");
    expect(() => sanitizeName("   ")).toThrow(HubError);
  });
});

describe("hub MCP server", () => {
  let stateDir: string;
  let rootA: string;
  let rootB: string;
  let bridge: Bridge;
  let client: Client;

  async function call(name: string, args: Record<string, unknown> = {}) {
    return client.callTool({ name, arguments: args });
  }

  beforeAll(async () => {
    stateDir = isolateStateDir();
    rootA = makeTmpDir("proj-a");
    rootB = makeTmpDir("proj-b");
    makeGitRepo(rootA);
    makeGitRepo(rootB);
    write(rootA, "only-in-a.txt", "alpha secret-free text\n");
    write(rootB, "only-in-b.txt", "bravo text\n");
    write(rootA, ".env", "TOKEN=a-secret\n");

    bridge = await startBridge({
      workspaceRoot: hubRoot(),
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(makeTmpDir("hub-auth"), "store.json"),
    });
    const { accessToken } = bridge.authStore.issueTokens({
      clientId: "hub-client",
      scopes: ["workspace.read", "workspace.search", "git.read", "execution.read"],
    });
    client = new Client({ name: "hub-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
      })
    );
  });

  afterAll(async () => {
    await client.close();
    await bridge.close();
    for (const dir of [rootA, rootB, stateDir]) cleanup(dir);
    delete process.env.C2C_STATE_DIR;
  });

  it("exposes list_workspaces plus a workspace argument on every other tool", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("list_workspaces");
    expect(names).toHaveLength(11);
    for (const tool of tools.filter((t) => t.name !== "list_workspaces")) {
      const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      expect(Object.keys(props), tool.name).toContain("workspace");
    }
  });

  it("with nothing registered every call fails with NO_WORKSPACES", async () => {
    const empty = await call("workspace_info", {});
    expect(empty.isError).toBe(true);
    expect(JSON.parse(textOf(empty)).error).toBe("NO_WORKSPACES");
    const list = await call("list_workspaces");
    expect((list.structuredContent as { workspaces: unknown[] }).workspaces).toEqual([]);
  });

  it("serves a single registered workspace without the argument", async () => {
    const a = addWorkspace(rootA, { name: "alpha" }).workspace;
    const info = await call("workspace_info", {});
    expect((info.structuredContent as { workspaceId: string }).workspaceId).toBe(a.id);
  });

  it("requires the argument once several are registered, then routes by name or id", async () => {
    const a = findRegistered("alpha")!;
    const b = addWorkspace(rootB, { name: "bravo" }).workspace;

    const ambiguous = await call("read_file", { path: "hello.txt" });
    expect(ambiguous.isError).toBe(true);
    const err = JSON.parse(textOf(ambiguous));
    expect(err.error).toBe("WORKSPACE_REQUIRED");
    expect(err.message).toContain("alpha");
    expect(err.message).toContain("bravo");

    const list = await call("list_workspaces");
    expect((list.structuredContent as { workspaces: { name: string }[] }).workspaces.map((w) => w.name)).toEqual([
      "alpha",
      "bravo",
    ]);

    const fromA = await call("read_file", { workspace: "alpha", path: "only-in-a.txt" });
    expect(JSON.parse(textOf(fromA)).content).toContain("alpha");
    const fromB = await call("read_file", { workspace: b.id, path: "only-in-b.txt" });
    expect(JSON.parse(textOf(fromB)).content).toContain("bravo");
    expect((await call("workspace_info", { workspace: "BRAVO" })).structuredContent).toMatchObject({
      workspaceId: b.id,
    });
    expect(a.id).not.toBe(b.id);
  });

  it("does not leak one project into another", async () => {
    // the same relative path exists in both projects: a leak would return the wrong content
    write(rootA, "shared.txt", "shared-from-alpha");
    write(rootB, "shared.txt", "shared-from-bravo");
    const sharedA = JSON.parse(textOf(await call("read_file", { workspace: "alpha", path: "shared.txt" })));
    const sharedB = JSON.parse(textOf(await call("read_file", { workspace: "bravo", path: "shared.txt" })));
    expect(sharedA.content).toContain("shared-from-alpha");
    expect(sharedA.content).not.toContain("bravo");
    expect(sharedB.content).toContain("shared-from-bravo");
    expect(sharedB.content).not.toContain("alpha");

    const wrongFile = await call("read_file", { workspace: "alpha", path: "only-in-b.txt" });
    expect(wrongFile.isError).toBe(true);
    expect(JSON.parse(textOf(wrongFile)).error).toBe("FILE_NOT_FOUND");
    const traversal = await call("read_file", { workspace: "alpha", path: `../${path.basename(rootB)}/only-in-b.txt` });
    expect(traversal.isError).toBe(true);
    expect(JSON.parse(textOf(traversal)).error).toBe("PATH_OUTSIDE_WORKSPACE");
    const absolute = await call("read_file", { workspace: "alpha", path: path.join(rootB, "only-in-b.txt") });
    expect(absolute.isError).toBe(true);
    // search: positive control in each project, then the cross-project queries must be empty
    const count = async (workspace: string, query: string): Promise<number> =>
      ((await call("search_workspace", { workspace, query })).structuredContent as { matchCount: number }).matchCount;
    expect(await count("alpha", "secret-free")).toBeGreaterThan(0);
    expect(await count("bravo", "bravo text")).toBeGreaterThan(0);
    expect(await count("alpha", "bravo text")).toBe(0);
    expect(await count("bravo", "secret-free")).toBe(0);
  });

  it("keeps per-workspace sensitive-file policy and execution records separate", async () => {
    const denied = await call("read_file", { workspace: "alpha", path: ".env" });
    expect(denied.isError).toBe(true);
    expect(JSON.parse(textOf(denied)).error).toBe("ACCESS_DENIED_SENSITIVE_FILE");

    // the same file name is sensitive in bravo only (its .c2cignore) and readable in alpha
    write(rootA, "private.txt", "alpha private-ok");
    write(rootB, "private.txt", "bravo private");
    write(rootB, ".c2cignore", "private.txt\n");
    const privateA = await call("read_file", { workspace: "alpha", path: "private.txt" });
    expect(privateA.isError).toBeFalsy();
    expect(JSON.parse(textOf(privateA)).content).toContain("alpha private-ok");
    const privateB = await call("read_file", { workspace: "bravo", path: "private.txt" });
    expect(privateB.isError).toBe(true);
    expect(JSON.parse(textOf(privateB)).error).toBe("ACCESS_DENIED_SENSITIVE_FILE");

    const a = findRegistered("alpha")!;
    const b = findRegistered("bravo")!;
    appendExecutionRecord(a.id, {
      taskId: "c2c_alpha",
      iteration: 1,
      changedFiles: 1,
      tests: "1 passed",
      exitStatus: "ok",
      timestamp: new Date().toISOString(),
    });
    const sa = await call("execution_summary", { workspace: "alpha" });
    const sb = await call("execution_summary", { workspace: "bravo" });
    expect((sa.structuredContent as { records: unknown[] }).records).toHaveLength(1);
    expect((sb.structuredContent as { records: unknown[] }).records).toHaveLength(0);
    expect(b.id).not.toBe(a.id);
  });

  it("rejects unregistered names, name tricks and filesystem paths as workspace references", async () => {
    for (const trick of ["alpha/../bravo", "../bravo", "alp", "alpha,bravo", "alpha\u0000"]) {
      const result = await call("read_file", { workspace: trick, path: "only-in-b.txt" });
      expect(result.isError, trick).toBe(true);
      expect(JSON.parse(textOf(result)).error, trick).toBe("WORKSPACE_NOT_REGISTERED");
    }
    const unknown = await call("read_file", { workspace: "charlie", path: "hello.txt" });
    expect(unknown.isError).toBe(true);
    expect(JSON.parse(textOf(unknown)).error).toBe("WORKSPACE_NOT_REGISTERED");
    // a filesystem path is not a valid workspace reference
    const byPath = await call("read_file", { workspace: rootA, path: "hello.txt" });
    expect(byPath.isError).toBe(true);
    expect(JSON.parse(textOf(byPath)).error).toBe("WORKSPACE_NOT_REGISTERED");
  });

  it("removal takes effect immediately on the running bridge", async () => {
    // through the real CLI, against the state dir the running bridge reads
    const cli = spawnSync(process.execPath, [path.join(process.cwd(), "bin", "c2c.js"), "workspace", "remove", "alpha", "--json"], {
      encoding: "utf8",
      env: { ...process.env, C2C_STATE_DIR: process.env.C2C_STATE_DIR },
    });
    expect(cli.status, cli.stderr).toBe(0);
    expect(JSON.parse(cli.stdout).removed.name).toBe("alpha");
    const gone = await call("read_file", { workspace: "alpha", path: "hello.txt" });
    expect(gone.isError).toBe(true);
    expect(JSON.parse(textOf(gone)).error).toBe("WORKSPACE_NOT_REGISTERED");
    // bravo is now the only one left, so the argument becomes optional again
    const fallback = await call("read_file", { path: "only-in-b.txt" });
    expect(JSON.parse(textOf(fallback)).content).toContain("bravo");
  });

  it("reports a registered folder that disappeared", async () => {
    const parent = makeTmpDir("vanish");
    const dir = path.join(parent, "temp-proj");
    fs.mkdirSync(dir);
    addWorkspace(dir, { name: "vanishing" });
    fs.rmSync(dir, { recursive: true, force: true });
    const result = await call("read_file", { workspace: "vanishing", path: "x.txt" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result)).error).toBe("WORKSPACE_ROOT_MISSING");
    cleanup(parent);
  });

  it("refuses a registered folder that was swapped for a link to another folder", async () => {
    const parent = makeTmpDir("swap");
    const dir = path.join(parent, "proj");
    fs.mkdirSync(dir);
    addWorkspace(dir, { name: "swapped" });
    fs.rmSync(dir, { recursive: true, force: true });
    fs.symlinkSync(rootB, dir, "junction"); // "proj" now leads to bravo, which was never registered as "swapped"
    const result = await call("read_file", { workspace: "swapped", path: "only-in-b.txt" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result)).error).toBe("WORKSPACE_ROOT_CHANGED");
    fs.rmSync(dir, { recursive: true, force: true });
    removeWorkspace("swapped");
    cleanup(parent);
  });

  it("reports an unreadable registry instead of treating it as empty", async () => {
    const file = registryFile();
    const original = fs.readFileSync(file, "utf8");
    try {
      fs.writeFileSync(file, "{ not json");
      const list = await call("list_workspaces");
      expect(list.isError).toBe(true);
      expect(JSON.parse(textOf(list)).error).toBe("REGISTRY_CORRUPT");
      expect(textOf(list)).not.toContain(stateDir); // this text goes to ChatGPT: no local paths
      const read = await call("read_file", { workspace: "bravo", path: "only-in-b.txt" });
      expect(JSON.parse(textOf(read)).error).toBe("REGISTRY_CORRUPT");
    } finally {
      fs.writeFileSync(file, original);
    }
  });
});

describe("single-project mode is unchanged by hub support", () => {
  it("exposes the original ten tools and no workspace argument", async () => {
    const stateDir = isolateStateDir();
    const root = makeTmpDir("single");
    makeGitRepo(root);
    const bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(makeTmpDir("single-auth"), "store.json"),
    });
    const { accessToken } = bridge.authStore.issueTokens({ clientId: "single", scopes: ["workspace.read"] });
    const client = new Client({ name: "single-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
      })
    );
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(10);
      expect(tools.map((t) => t.name)).not.toContain("list_workspaces");
      // the original input arguments of every tool, exactly (taken from HEAD's src/mcp/server.ts)
      const original: Record<string, string[]> = {
        workspace_info: [],
        list_directory: ["depth", "limit", "offset", "path"],
        read_file: ["end_line", "path", "start_line"],
        read_image: ["path"],
        search_workspace: ["glob", "limit", "path", "query", "regex"],
        git_status: [],
        git_diff: ["max_bytes", "mode", "offset", "path"],
        test_status: [],
        execution_summary: ["limit"],
        execution_output: ["action", "id", "limit"],
      };
      const actual = Object.fromEntries(
        tools.map((t) => [t.name, Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}).sort()])
      );
      expect(actual).toEqual(original);
    } finally {
      await client.close();
      await bridge.close();
      for (const dir of [root, stateDir]) cleanup(dir);
      delete process.env.C2C_STATE_DIR;
    }
  });
});
