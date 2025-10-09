import fs from "fs";
import path from "path";

const FILE = path.join(process.cwd(), "data", "observed_labels.json");

type LabelRec = { kind: string; title?: string; id?: string };
type Bag = Record<string, LabelRec[]>;

function ensure(): Bag {
  try {
    const s = fs.readFileSync(FILE, "utf8");
    return JSON.parse(s || "{}") || {};
  } catch {
    return {};
  }
}
function persist(bag: Bag) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(bag, null, 2));
}

export function getObservedLabels(tenant: string): LabelRec[] {
  const bag = ensure();
  return bag[tenant] || [];
}
export function setObservedLabels(tenant: string, arr: LabelRec[]) {
  const bag = ensure();
  bag[tenant] = (arr || []).map((x) => ({
    kind: String(x.kind || "appointment"),
    title: (x.title || "").trim(),
    id: (x.id || "").trim(),
  }));
  persist(bag);
}
export function getObservedLabelIds(tenant: string, kind = "appointment"): string[] {
  return getObservedLabels(tenant)
    .filter((x) => x.kind === kind && x.id)
    .map((x) => x.id!);
}
export function getObservedLabelTitles(tenant: string, kind = "appointment"): string[] {
  return getObservedLabels(tenant)
    .filter((x) => x.kind === kind && x.title)
    .map((x) => x.title!.toLowerCase());
}
