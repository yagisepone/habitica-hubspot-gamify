// NEW
import type { Request, Response, NextFunction } from "express";
import { promises as fs } from "fs";
import path from "path";
import { requireEditorToken } from "../lib/auth.js";
import { getHabitica, MAIL2NAME } from "../lib/maps.js";
import { habSafe } from "../lib/habiticaQueue.js";
import { ensurePartyAndInvite } from "../connectors/habitica.js";

const DIR = "data/party";

const configPath = (tenant: string) =>
  path.resolve(DIR, `${(tenant || "default").trim() || "default"}.json`);

async function readConfig(tenant: string): Promise<any> {
  try {
    const txt = await fs.readFile(configPath(tenant), "utf8");
    return JSON.parse(txt || "{}");
  } catch {
    return {};
  }
}

async function writeConfig(tenant: string, obj: any) {
  await fs.mkdir(DIR, { recursive: true });
  await fs.writeFile(configPath(tenant), JSON.stringify(obj ?? {}, null, 2));
}

function ensureTenant(req: Request): string {
  const tenant = String(req.params?.id ?? "default").trim() || "default";
  if (!req.params) (req as any).params = {};
  (req.params as any).id = tenant;
  return tenant;
}

function ensureEditor(req: Request, res: Response): boolean {
  let allowed = false;
  const next: NextFunction = () => {
    allowed = true;
  };
  requireEditorToken(req, res, next);
  return allowed;
}

function normalizeDomains(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const value of input) {
    const s = String(value ?? "").toLowerCase().trim();
    if (s) out.push(s);
  }
  return out;
}

export async function partyPutConfig(req: Request, res: Response) {
  if (!ensureEditor(req, res)) return;
  const tenant = ensureTenant(req);
  const body = req.body || {};
  const domains = normalizeDomains(body?.domains);
  const leaderEmail = String(body?.leaderEmail || "").toLowerCase().trim();
  await writeConfig(tenant, { domains, leaderEmail });
  res.json({ ok: true });
}

export async function partyGetSuggest(req: Request, res: Response) {
  const tenant = ensureTenant(req);
  const cfg = await readConfig(tenant);
  const domains = normalizeDomains(cfg?.domains);
  const list: Array<{ email: string; name?: string; hasCred: boolean }> = [];
  for (const email of Object.keys(MAIL2NAME)) {
    if (!domains.some((d) => email.endsWith(`@${d}`))) continue;
    const cred = getHabitica(email);
    list.push({ email, name: MAIL2NAME[email], hasCred: !!cred });
  }
  const leaderEmail = String(cfg?.leaderEmail || "").toLowerCase().trim() || undefined;
  res.json({ domains, leaderEmail, candidates: list });
}

export async function partyHabiticaSync(req: Request, res: Response) {
  if (!ensureEditor(req, res)) return;
  const tenant = ensureTenant(req);
  const cfg = await readConfig(tenant);
  const domains = normalizeDomains(cfg?.domains);
  const leaderEmail = String(cfg?.leaderEmail || "").toLowerCase().trim();
  const leaderCred = getHabitica(leaderEmail);
  if (!leaderCred) {
    return res.status(400).json({ ok: false, error: "leader credential not found" });
  }
  const emails = Object.keys(MAIL2NAME).filter((email) =>
    domains.some((d) => email.endsWith(`@${d}`))
  );
  const invited: string[] = [];
  const skipped: string[] = [];
  await habSafe(async () => {
    for (const email of emails) {
      const member = getHabitica(email);
      if (!member) {
        skipped.push(email);
        continue;
      }
      await ensurePartyAndInvite(leaderCred, member);
      invited.push(email);
    }
    return undefined as any;
  });
  res.json({ ok: true, leader: leaderEmail || null, invited, skipped });
}
