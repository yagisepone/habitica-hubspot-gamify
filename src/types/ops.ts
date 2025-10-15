export interface ManualAdjustRequest {
  userId: string;
  deltaXp: number;
  deltaLvl?: number;
  note?: string;
  idempotencyKey?: string;
}

export type XpAdjustment = {
  id: string;
  tenant: string;
  userId: string;
  userName?: string;
  deltaXp: number;
  deltaLevel?: number;
  badge?: string;
  note?: string;
  source: "manual" | "shop";
  idempotencyKey?: string;
  createdAt: string;
};

export type LegacyShopItem = {
  id: string;
  title: string;
  name?: string;
  priceXp: number;
  stock?: number | null;
  badgeOnBuy?: string;
  enabled?: boolean;
};

export interface ShopItem {
  id: string;
  name: string;
  description?: string;
  value: number;
  isPaid?: boolean;
  active?: boolean;
  createdAt: string;
  updatedAt: string;
}

export type BadgeCriteriaType =
  | "totalXpAtLeast"
  | "callsDurationMsAtLeast"
  | "appointmentsCountAtLeast"
  | "hasLabelCountAtLeast";

export interface Badge {
  id: string;
  title: string;
  description?: string;
  xp?: number;
  icon?: string;
  criteria: {
    type: BadgeCriteriaType;
    threshold: number;
    labelId?: string;
  };
  active?: boolean;
  createdAt: string;
  updatedAt: string;
}

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
