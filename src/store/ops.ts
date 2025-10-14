import path from "path";
import { promises as fs } from "fs";

const DATA_ROOT = path.resolve(process.cwd(), "data");

const safeTenant = (tenant: string) =>
  String(tenant || "default")
    .trim()
    .replace(/[^a-zA-Z0-9_.@\-]/g, "_") || "default";

export async function ensureTenantDir(tenant: string): Promise<string> {
  const dir = path.join(DATA_ROOT, safeTenant(tenant));
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function appendJsonl(fullPath: string, obj: any): Promise<void> {
  const dir = path.dirname(fullPath);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(fullPath, `${JSON.stringify(obj)}\n`, "utf8");
}

export async function readLastN(fullPath: string, n: number): Promise<any[]> {
  if (n <= 0) return [];
  try {
    const txt = await fs.readFile(fullPath, "utf8");
    if (!txt) return [];
    const lines = txt
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (!lines.length) return [];
    const tail = lines.slice(-Math.max(1, n)).reverse();
    const items: any[] = [];
    for (const line of tail) {
      try {
        items.push(JSON.parse(line));
      } catch {
        // skip malformed lines
      }
    }
    return items;
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
}

export async function readJson<T>(fullPath: string, defVal: T): Promise<T> {
  try {
    const txt = await fs.readFile(fullPath, "utf8");
    return JSON.parse(txt) as T;
  } catch (err: any) {
    if (err?.code === "ENOENT") return defVal;
    throw err;
  }
}

export async function writeJson(fullPath: string, data: any): Promise<void> {
  const dir = path.dirname(fullPath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(fullPath, JSON.stringify(data, null, 2), "utf8");
}
