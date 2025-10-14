export type XpAdjustment = {
  id: string;
  tenant: string;
  userId: string;
  userName?: string;
  deltaXp: number;
  badge?: string;
  note?: string;
  source: "manual" | "shop";
  createdAt: string;
};

export type ShopItem = {
  id: string;
  title: string;
  name?: string;
  priceXp: number;
  stock?: number | null;
  badgeOnBuy?: string;
  enabled?: boolean;
};

export type AuditEvent = {
  id: string;
  tenant: string;
  actor: string;
  action:
    | "adjust.create"
    | "shop.item.put"
    | "shop.purchase"
    | "manual.xp"
    | "manual.level"
    | "labels.bulk.replace";
  detail?: any;
  ip?: string;
  ua?: string;
  at: string;
};

export type OpsLogEntry = {
  id: string;
  tenant: string;
  type: "adjust" | "purchase";
  ts: string;
  userId: string;
  userName?: string;
  deltaXp: number;
  badge?: string;
  note?: string;
  source: string;
};

export type ManualLogEntry = {
  id: string;
  tenant: string;
  type: "xp" | "level";
  userId: string;
  deltaXp?: number;
  deltaLevel?: number;
  reason?: string;
  ip?: string;
  ua?: string;
  createdAt: string;
};
