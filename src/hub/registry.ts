import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureDir, getStateDir, writeSecureJson } from "../config/paths.js";
import { Workspace, WorkspaceError } from "../workspace/manager.js";

/**
 * Hub mode: ONE bridge / ONE ChatGPT connector serving many projects.
 *
 * The allowlist is a registry file in the state directory. Only registered
 * workspaces are visible to ChatGPT; every MCP call re-reads the registry, so
 * `c2c workspace add/remove` takes effect immediately without a restart.
 * Per-workspace protections (path containment, sensitive-file policy,
 * `.c2cignore`) still come from the Workspace class of the target project.
 */

/** `c2c <cmd> -w hub` addresses the hub itself instead of a project. */
export const HUB_KEYWORD = "hub";

export interface RegisteredWorkspace {
  id: string;
  name: string;
  root: string;
  addedAt: string;
}

interface RegistryFile {
  workspaces: RegisteredWorkspace[];
}

export type HubErrorCode =
  | "NO_WORKSPACES"
  | "WORKSPACE_REQUIRED"
  | "WORKSPACE_NOT_REGISTERED"
  | "WORKSPACE_ROOT_MISSING"
  | "WORKSPACE_ROOT_CHANGED"
  | "REGISTRY_CORRUPT"
  | "REGISTRY_UNREADABLE"
  | "WORKSPACE_ROOT_INVALID"
  | "REGISTRY_BUSY"
  | "UNSAFE_ROOT"
  | "INVALID_NAME"
  | "NAME_TAKEN";

export class HubError extends Error {
  constructor(
    public code: HubErrorCode,
    message: string
  ) {
    super(message);
    this.name = "HubError";
  }
}

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";
const normCase = (p: string): string => (CASE_INSENSITIVE ? p.toLowerCase() : p);

/** True when `child` is `parent` or lives below it. */
function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(normCase(parent), normCase(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** realpath when the path exists; otherwise the resolved path is the best canonical form available. */
function realOrResolved(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

export function hubRoot(): string {
  const dir = ensureDir(path.join(getStateDir(), "hub"));
  const readme = path.join(dir, "README.md");
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(
      readme,
      "# hub\n\nPlaceholder workspace for the shared Codex with ChatGPT connector.\nProjects are registered with `c2c workspace add`.\n"
    );
  }
  return realOrResolved(dir);
}

export function isHubRoot(root: string): boolean {
  return normCase(realOrResolved(root)) === normCase(realOrResolved(path.join(getStateDir(), "hub")));
}

export function registryFile(): string {
  return path.join(ensureDir(path.join(getStateDir(), "registry")), "workspaces.json");
}

function isEntry(value: unknown): value is RegisteredWorkspace {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" && typeof v.name === "string" && typeof v.root === "string" && typeof v.addedAt === "string"
  );
}

/**
 * A missing file is an empty registry. A file that exists but cannot be read or parsed
 * is an error: treating it as empty would let the next `workspace add` overwrite (and
 * so silently unregister) every other project. Messages carry no local paths because
 * they are returned to ChatGPT verbatim; the CLI adds the path for the local user.
 */
export function listRegistered(): RegisteredWorkspace[] {
  let raw: string;
  try {
    raw = fs.readFileSync(registryFile(), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return []; // no registry yet
    throw new HubError(
      "REGISTRY_UNREADABLE",
      `The workspace registry cannot be read (${code ?? "unknown error"}). Check its permissions and try again; do not delete it.`
    );
  }
  const corrupt = (): HubError =>
    new HubError(
      "REGISTRY_CORRUPT",
      "The workspace registry is unreadable (its content is corrupt). Repair it from a backup; deleting it unregisters every project."
    );
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw corrupt();
  }
  const list = (data as Partial<RegistryFile> | null)?.workspaces;
  if (!Array.isArray(list) || !list.every(isEntry)) throw corrupt();
  return list;
}

/** Write-then-rename so a crash never leaves a half-written registry behind. */
function save(workspaces: RegisteredWorkspace[]): void {
  const file = registryFile();
  const tmp = `${file}.${process.pid}.tmp`;
  writeSecureJson(tmp, { workspaces } satisfies RegistryFile);
  fs.renameSync(tmp, file);
}

const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 30_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Serialize read-modify-write on the registry across processes. Without it a
 * `remove` that lands between an `add`'s read and write is silently undone, which
 * would re-grant ChatGPT access to a project that was just revoked.
 */
function withRegistryLock<T>(fn: () => T): T {
  const lock = `${registryFile()}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd: number;
  for (;;) {
    try {
      fd = fs.openSync(lock, "wx");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { force: true }); // left by a crash
      } catch (statError) {
        // only "the holder released it between our open and stat" is benign; anything else is the real cause
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
      }
      if (Date.now() > deadline) {
        throw new HubError("REGISTRY_BUSY", "Another c2c process is updating the workspace registry. Try again.");
      }
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
  }
}

/** Names are what ChatGPT types, so keep them short and free of spaces. */
export function sanitizeName(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 64);
  if (!cleaned) throw new HubError("INVALID_NAME", `Cannot derive a workspace name from "${raw}". Pass --name.`);
  return cleaned;
}

/**
 * Refuse roots that are too broad or that would expose C2C's own secrets.
 * A registered root is readable by any ChatGPT chat that uses the connector.
 */
function assertSafeRoot(real: string): void {
  if (path.parse(real).root === real) {
    throw new HubError("UNSAFE_ROOT", "Refusing to register a filesystem or drive root.");
  }
  const home = realOrResolved(os.homedir());
  if (isWithin(real, home)) {
    throw new HubError("UNSAFE_ROOT", "Refusing to register your home directory or one of its parents.");
  }
  const state = realOrResolved(getStateDir());
  if (isWithin(real, state) || isWithin(state, real)) {
    throw new HubError("UNSAFE_ROOT", "Refusing to register C2C's own state directory (it holds tokens).");
  }
}

/** Health of the allowlist for `c2c doctor`: an empty or unreadable registry serves nothing. */
export function registryHealth(): { ok: boolean; detail: string } {
  try {
    const names = listRegistered().map((w) => w.name);
    return names.length
      ? { ok: true, detail: names.join(", ") }
      : { ok: false, detail: "0（还没有注册项目：c2c workspace add）" };
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
}

/** An exact id always wins over a name, so a name can never shadow another project's id. */
export function findRegistered(nameOrId: string): RegisteredWorkspace | null {
  const wanted = nameOrId.trim().toLowerCase();
  const all = listRegistered();
  return all.find((w) => w.id === wanted) ?? all.find((w) => w.name.toLowerCase() === wanted) ?? null;
}

interface AddResult {
  workspace: RegisteredWorkspace;
  created: boolean;
}

export function addWorkspace(rootInput: string, opts: { name?: string } = {}): AddResult {
  const ws = new Workspace(rootInput); // throws a WorkspaceError if missing / not a directory
  assertSafeRoot(ws.root);
  const wantedName = sanitizeName(opts.name ?? ws.name);

  return withRegistryLock(() => {
    const all = listRegistered();
    // a name is taken by another entry's name or id (ids route first, so they must stay reachable)
    const taken = (name: string, exceptId?: string): boolean => {
      const lower = name.toLowerCase();
      return all.some((w) => w.id !== exceptId && (w.name.toLowerCase() === lower || w.id === lower));
    };

    const existing = all.find((w) => w.id === ws.id);
    if (existing) {
      if (opts.name && existing.name !== wantedName) {
        if (taken(wantedName, existing.id)) throw new HubError("NAME_TAKEN", `Name "${wantedName}" is already used.`);
        existing.name = wantedName;
        save(all);
      }
      return { workspace: existing, created: false };
    }

    let name = wantedName;
    if (taken(name)) {
      if (opts.name) throw new HubError("NAME_TAKEN", `Name "${name}" is already used by another workspace.`);
      // two folders both called "app": add more of the id until the name is free
      const free = [4, 6, 8, 12]
        .map((n) => `${wantedName.slice(0, 50)}-${ws.id.slice(0, n)}`)
        .find((candidate) => !taken(candidate));
      if (!free) throw new HubError("NAME_TAKEN", `Could not find a free name for "${wantedName}". Pass --name.`);
      name = free;
    }
    const entry: RegisteredWorkspace = { id: ws.id, name, root: ws.root, addedAt: new Date().toISOString() };
    save([...all, entry]);
    return { workspace: entry, created: true };
  });
}

export function removeWorkspace(nameOrId: string): RegisteredWorkspace | null {
  return withRegistryLock(() => {
    const found = findRegistered(nameOrId);
    if (!found) return null;
    save(listRegistered().filter((w) => w.id !== found.id));
    return found;
  });
}

// ---------------------------------------------------------------- resolution for MCP calls

export interface HubContext {
  /** Resolve the workspace a tool call targets. Throws HubError / WorkspaceError. */
  resolve(nameOrId?: string): Workspace;
  list(): { name: string; id: string }[];
}

export function createHubContext(): HubContext {
  const names = (): string => listRegistered().map((w) => w.name).join(", ");
  return {
    list: () => listRegistered().map((w) => ({ name: w.name, id: w.id })),
    resolve(nameOrId?: string): Workspace {
      const all = listRegistered();
      if (all.length === 0) {
        throw new HubError("NO_WORKSPACES", "No workspaces are registered. Ask Codex to run `c2c workspace add`.");
      }
      let entry: RegisteredWorkspace | null;
      if (nameOrId === undefined || nameOrId.trim() === "") {
        if (all.length > 1) {
          throw new HubError(
            "WORKSPACE_REQUIRED",
            `Pass the "workspace" argument. Registered workspaces: ${names()}.`
          );
        }
        entry = all[0];
      } else {
        entry = findRegistered(nameOrId);
        if (!entry) {
          throw new HubError(
            "WORKSPACE_NOT_REGISTERED",
            `Unknown workspace "${nameOrId}". Registered workspaces: ${names()}.`
          );
        }
      }
      try {
        const workspace = new Workspace(entry.root);
        // The id is a hash of the real path: a different id means the registered
        // folder is now a link to somewhere that was never allowlisted.
        if (workspace.id !== entry.id) {
          throw new HubError(
            "WORKSPACE_ROOT_CHANGED",
            `Workspace "${entry.name}" no longer resolves to the folder that was registered. Re-add it.`
          );
        }
        return workspace;
      } catch (error) {
        // only a vanished folder is "missing"; keep other causes (e.g. it became a file) as they are
        if (error instanceof WorkspaceError && error.code === "FILE_NOT_FOUND") {
          throw new HubError("WORKSPACE_ROOT_MISSING", `Workspace "${entry.name}" is registered but its folder is gone.`);
        }
        if (error instanceof WorkspaceError && error.code === "NOT_A_DIRECTORY") {
          // WorkspaceError's own message embeds the absolute path, which would reach ChatGPT
          throw new HubError("WORKSPACE_ROOT_INVALID", `Workspace "${entry.name}" is registered but its path is no longer a folder.`);
        }
        throw error;
      }
    },
  };
}
