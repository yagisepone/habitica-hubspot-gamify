import fs from "fs";
import path from "path";
import zlib from "zlib";
import dayjs from "dayjs";

const srcDir = path.resolve("data/events");
const dstDir = path.resolve("data/archive");
fs.mkdirSync(dstDir, { recursive: true });

const cutoff = dayjs().subtract(30, "day").valueOf();

for (const f of fs.readdirSync(srcDir).filter(f => f.endsWith(".jsonl"))) {
  const p = path.join(srcDir, f);
  const st = fs.statSync(p);
  if (st.mtimeMs < cutoff && st.size > 0) {
    const gz = path.join(dstDir, `${f}.${dayjs(st.mtime).format("YYYYMMDD")}.gz`);
    fs.createReadStream(p).pipe(zlib.createGzip()).pipe(fs.createWriteStream(gz))
      .on("finish", () => fs.truncateSync(p, 0));
    console.log("[rotate] archived:", f);
  }
}
