import fs from "fs";
import path from "path";

const filePath = path.resolve(process.cwd(), "data", "processed.json");

type Store = Record<string, boolean>;

function load(): Store {
  try {
    if (!fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
}

function save(store: Store) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2), "utf-8");
}

export function isProcessed(key: string) {
  const s = load();
  return !!s[key];
}

export function markProcessed(key: string) {
  const s = load();
  s[key] = true;
  save(s);
}
