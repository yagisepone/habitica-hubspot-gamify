// src/web/server/zoomAuth.ts
import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";

const SECRET = process.env.ZOOM_WEBHOOK_SECRET_TOKEN || "";

/** express.json の verify フック：rawBody を保持する */
export function rawBodySaver(req: Request, _res: Response, buf: Buffer, _encoding: BufferEncoding) {
  (req as any).rawBody = buf;
}

/** Zoom URL検証 (endpoint.url_validation) を処理して 200 返却。処理したら true */
export function handleUrlValidation(req: Request, res: Response): boolean {
  const body = req.body;
  if (body?.event !== "endpoint.url_validation") return false;

  const plainToken: string = body?.payload?.plainToken || "";
  const encryptedToken = crypto
    .createHmac("sha256", SECRET)
    .update(plainToken)
    .digest("hex");

  res.status(200).json({ plainToken, encryptedToken });
  return true;
}

/** 署名検証：Base64 / Hex どちらの x-zm-signature も許容 */
export function verifyZoomSignature(req: Request): boolean {
  const header = String(req.headers["x-zm-signature"] || "").trim(); // v0=...
  const tsStr = String(req.headers["x-zm-request-timestamp"] || "").trim();
  const ts = Number(tsStr || "0");

  if (!SECRET || !header || !ts) return false;

  // リプレイ対策：±300秒
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > 300) return false;

  const raw: Buffer = ((req as any).rawBody as Buffer) ?? Buffer.from("");
  const msg = `v0:${ts}:${raw.toString("utf8")}`;

  const hmacBuf = crypto.createHmac("sha256", SECRET).update(msg).digest();
  const b64 = hmacBuf.toString("base64");
  const hex = hmacBuf.toString("hex");
  const want = header.replace(/^v0=/, "");

  return want === b64 || want === hex;
}

/** ミドルウェア：URL検証 or 署名OK 以外は 401 */
export function requireZoomSignature(req: Request, res: Response, next: NextFunction) {
  // URL検証イベントはここで完結
  if (handleUrlValidation(req, res)) return;

  const ok = verifyZoomSignature(req);
  if (!ok) {
    // フォレンジック用に失敗リクエストの一部を記録（rawBodyはそのまま）
    try {
      const fs = require("fs");
      const path = require("path");
      const dir = path.join(process.cwd(), "logs", "forensics");
      fs.mkdirSync(dir, { recursive: true });
      const line = [
        new Date().toISOString(),
        req.headers["x-zm-request-timestamp"],
        req.headers["x-zm-signature"],
        (req as any).rawBody?.toString("utf8") ?? "",
      ].join("\t") + "\n";
      fs.appendFileSync(path.join(dir, `zoom_failed_${new Date().toISOString().slice(0,10)}.log`), line);
    } catch (e) {
      // ここは落としてOK（ログ用途）
    }
    return res.status(401).json({ error: "invalid_signature" });
  }
  return next();
}
