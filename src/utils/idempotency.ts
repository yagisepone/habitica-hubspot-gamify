import fs from "fs";
import path from "path";

const FILE = path.resolve("data/processed.json");

function load(): Record<string, boolean> {
  try {
    if (!fs.existsSync(FILE)) return {};
    return JSON.parse(fs.readFileSync(FILE, "utf-8"));
  } catch {
    return {};
  }
}
function save(obj: Record<string, boolean>) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(obj, null, 2), "utf-8");
}

export function isProcessed(key: string): boolean {
  const m = load();
  return Boolean(m[key]);
}
export function markProcessed(key: string) {
  const m = load();
  m[key] = true;
  save(m);
}
