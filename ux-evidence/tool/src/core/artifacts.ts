import { mkdir, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

export async function clearArtifactDirectory(repoRoot: string, path: string): Promise<void> {
  const root = resolve(join(repoRoot, ".qa-artifacts"));
  const target = resolve(path);
  const fromRoot = relative(root, target);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || resolve(root, fromRoot) !== target) {
    throw new Error(`refusing to clear ${target}: not inside ${root}`);
  }
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
}
