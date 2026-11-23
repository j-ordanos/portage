import type { Vault } from "../vault.js";
import { arr, rec, str } from "./util.js";

export interface MappedMount {
  type: "volume" | "bind" | "file";
  name?: string;
  hostPath?: string;
  mountPath: string;
  contentRef?: string | null;
}

/** Persistent storages (`name`, `mount_path`, `host_path`) and file storages (`mount_path`, `content`). */
export async function mapStorages(
  raw: unknown,
  vault: Vault,
  ownerUuid?: string,
): Promise<MappedMount[]> {
  const mounts: MappedMount[] = [];
  for (const entry of arr(raw)) {
    const item = rec(entry);
    const mountPath = str(item, "mount_path");
    if (!mountPath) continue;
    const isFile =
      "content" in item || "fs_path" in item || item.is_directory === false;
    if (isFile) {
      const content = typeof item.content === "string" ? item.content : null;
      mounts.push({
        type: "file",
        mountPath,
        contentRef: content === null ? null : await vault.put(content),
      });
      continue;
    }
    const hostPath = str(item, "host_path");
    const rawName = str(item, "name");
    // Coolify prefixes volume names with the resource uuid; drop it so the name is readable.
    const name =
      rawName && ownerUuid
        ? rawName.replace(new RegExp(`^${ownerUuid}[-_]|[-_]${ownerUuid}$`), "")
        : rawName;
    mounts.push({
      type: hostPath ? "bind" : "volume",
      ...(name ? { name } : {}),
      ...(hostPath ? { hostPath } : {}),
      mountPath,
    });
  }
  return mounts.sort((a, b) => a.mountPath.localeCompare(b.mountPath));
}
