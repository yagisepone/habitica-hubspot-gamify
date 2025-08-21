import fs from "fs";
import path from "path";

const filePath = path.resolve(process.cwd(), "data", "processed.json");

interface ProcessedStore { [key: string]: boolean; }

function loadStore(): ProcessedStore {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
}

function saveStore(store: ProcessedStore) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2), "utf-8");
}

/** このキーが既に処理済みかどうかを返す */
export function isProcessed(key: string): boolean {
  const store = loadStore();
  return !!store[key];
}

/** 処理済みとしてキーを登録する */
export function markProcessed(key: string) {
  const store = loadStore();
  store[key] = true;
  saveStore(store);
}
