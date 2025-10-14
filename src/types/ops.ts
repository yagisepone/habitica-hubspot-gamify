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
  priceXp: number;
  stock?: number | null;
  badgeOnBuy?: string;
  enabled?: boolean;
};

export type AuditEvent = {
  id: string;
  tenant: string;
  actor: string;
  action: "adjust.create" | "shop.item.put" | "shop.purchase";
  detail?: any;
  ip?: string;
  at: string;
};
