import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { problem } from "../domain/errors.js";

/** Works both in tsc output and a standalone bundled package; never searches an
 * Agent Kit checkout or any machine-specific installation path. */
export function packageRoot(from = import.meta.url): string {
  let dir = dirname(fileURLToPath(from));
  for (let i = 0; i < 6; i++) {
    const path = join(dir, "package.json");
    if (existsSync(path)) {
      try {
        const data = JSON.parse(readFileSync(path, "utf8"));
        if (data.agsx?.schema === "agsx.package.v1") return dir;
      } catch {
        /* Not this package. */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw problem(
    "integrity_error",
    "The running CLI package has no matching package identity.",
    "package_root",
  );
}
