import { mkdir, open, readFile, rename, lstat, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/** Plugin-owned files only. Never resolve paths supplied by messages/models. */
export async function privateDir(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("Agents Chat state directory must be private (mode 0700), not a symlink");
}
export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > 16 * 1024 * 1024) throw new Error("Agents Chat state file is not private or exceeds its size limit");
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
export async function writeJson(path: string, value: unknown) {
  await privateDir(dirname(path));
  const temp = join(dirname(path), `.agents-chat-${randomUUID()}.tmp`);
  const file = await open(temp, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  try { await rename(temp, path); } finally { await rm(temp, { force: true }); }
}

/** Short cross-process lock for credential refresh vs CLI login/logout. */
export async function withFileLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    let lock;
    try { lock = await open(path, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Do not steal a lock: stale locks require explicit operator recovery.
      if (Date.now() >= deadline) throw new Error("Agents Chat credential update is locked; retry or inspect the stale lock after stopping OpenClaw");
      await new Promise((resolve) => setTimeout(resolve, 100)); continue;
    }
    try { await lock.writeFile(String(process.pid)); return await action(); }
    finally { await lock.close(); await rm(path, { force: true }); }
  }
}
