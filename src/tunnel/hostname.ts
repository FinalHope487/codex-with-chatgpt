import { HUB_KEYWORD } from "../hub/registry.js";
import { normalizeNamedTunnelHostname } from "./cloudflared-named.js";

/**
 * DNS-safe label from a workspace name. Non-ASCII names fall back to the id.
 * Every install's hub is named "hub", so it gets its id prefix too: two hubs on one
 * zone (another state dir, or the Claude fork) must not both want `c2c-hub`.
 */
export function hostnameSlug(workspaceName: string, workspaceId: string): string {
  if (workspaceName === HUB_KEYWORD) return `c2c-hub-${workspaceId.slice(0, 6)}`;
  const ascii = workspaceName
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  const label = ascii || `ws-${workspaceId.slice(0, 8)}`;
  return `c2c-${label}`;
}

export function suggestedNamedHostname(
  zone: string,
  workspaceName: string,
  workspaceId: string
): string {
  const zoneHost = normalizeNamedTunnelHostname(zone);
  return `${hostnameSlug(workspaceName, workspaceId)}.${zoneHost}`;
}

export function parseZoneInput(input: string): string | null {
  const trimmed = input.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").replace(/\.$/, "");
  if (!trimmed) return null;
  try {
    return normalizeNamedTunnelHostname(trimmed);
  } catch {
    return null;
  }
}
