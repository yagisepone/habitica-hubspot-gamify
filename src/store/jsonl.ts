import path from "path";
import { promises as fs } from "fs";

const DATA_ROOT = path.resolve(process.cwd(), "data");

async function ensureDirFor(filePath: string) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
}

async function readLines(filePath: string): Promise<string[]> {
  try {
    const txt = await fs.readFile(filePath, "utf8");
    return txt
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
}

async function writeLines(filePath: string, lines: string[]): Promise<void> {
  await ensureDirFor(filePath);
  if (!lines.length) {
    await fs.writeFile(filePath, "", "utf8");
    return;
  }
  await fs.writeFile(filePath, lines.join("\n") + "\n", "utf8");
}

export function tenantJsonlPath(tenant: string, filename: string): string {
  const safeTenant =
    String(tenant || "default")
      .trim()
      .replace(/[^a-zA-Z0-9_.@\-]/g, "_") || "default";
  return path.join(DATA_ROOT, safeTenant, filename);
}

export async function readAll<T>(filePath: string): Promise<T[]> {
  const lines = await readLines(filePath);
  const items: T[] = [];
  for (const line of lines) {
    try {
      items.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }
  return items;
}

export async function upsertById<T extends { id: string }>(
  filePath: string,
  obj: T
): Promise<T> {
  const all = await readAll<T>(filePath);
  const idx = all.findIndex((item) => item && item.id === obj.id);
  if (idx >= 0) all[idx] = obj;
  else all.push(obj);
  await writeLines(
    filePath,
    all.map((item) => JSON.stringify(item))
  );
  return obj;
}

export async function removeById(filePath: string, id: string): Promise<void> {
  const all = await readAll<{ id: string }>(filePath);
  const next = all.filter((item) => item && item.id !== id);
  await writeLines(
    filePath,
    next.map((item) => JSON.stringify(item))
  );
}
