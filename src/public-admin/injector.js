/* Sales Gamify Console – injector v2 (overlay + persistent gear button) */
(() => {
  const WRAP_ID = "sgc-overlay";
  const FAB_ID  = "sgc-fab-outer";

  // 既定の BASE（必要に応じて自社Renderに変更）
  const DEFAULT_BASE = "https://sales-gamify.onrender.com";

  // すでに外側の⚙️が無ければ作る（リロードまでは残る）
  if (!document.getElementById(FAB_ID)) {
    const fab = document.createElement("div");
    fab.id = FAB_ID;
    fab.textContent = "⚙️ 設定";
    fab.style.cssText =
      "position:fixed;top:110px;right:18px;z-index:2147483646;background:#6c5ce7;color:#fff;" +
      "border-radius:14px;padding:10px 14px;box-shadow:0 6px 18px rgba(0,0,0,.25);" +
      "font-weight:700;display:flex;gap:8px;align-items:center;cursor:pointer;user-select:none";
    fab.addEventListener("mouseenter", () => (fab.style.filter = "brightness(1.06)"));
    fab.addEventListener("mouseleave", () => (fab.style.filter = ""));
    fab.addEventListener("click", () => toggleOverlay(true));
    document.body.appendChild(fab);
  }

  // Escで閉じる
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const wrap = document.getElementById(WRAP_ID);
      if (wrap) wrap.style.display = "none";
    }
  });

  // 表示/非表示のトグル
  function toggleOverlay(forceShow) {
    let wrap = document.getElementById(WRAP_ID);
    if (!wrap) {
      wrap = buildOverlay();
      document.body.appendChild(wrap);
    }
    wrap.style.display =
      forceShow ? "block" : wrap.style.display === "none" ? "block" : "none";
  }

  // オーバーレイ生成
  function buildOverlay() {
    // 既存のプロファイル（console.html が保存する localStorage）を利用
    let prof = {};
    try {
      prof = JSON.parse(localStorage.getItem("sgc.profile.v3") || "{}") || {};
    } catch {}
    const tenant = prof.tenant || "default";
    const base = (prof.baseUrl || DEFAULT_BASE).replace(/\/+$/, "");
    const token = prof.token || "";

    // console.html にマジック値をブリッジ（初回が楽）
    const q = new URLSearchParams();
    if (tenant) q.set("tenant", tenant);
    if (token) q.set("token", token);
    if (base) q.set("base", base);
    const consoleUrl = `${base}/admin/console/${q.toString() ? "#" + q.toString() : ""}`;

    const wrap = document.createElement("div");
    wrap.id = WRAP_ID;
    wrap.style.cssText =
      "position:fixed;inset:0;z-index:2147483645;background:rgba(0,0,0,.40);" +
      "backdrop-filter:saturate(110%) blur(1.5px);display:block";
    wrap.innerHTML = `
      <div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
                  width:min(1100px,95vw);height:min(85vh,95vh);background:#fff;border-radius:14px;
                  box-shadow:0 20px 48px rgba(0,0,0,.35);overflow:hidden;display:flex;flex-direction:column">
        <div style="display:flex;align-items:center;justify-content:space-between;
                    background:#f7f7fb;border-bottom:1px solid #ececf5;padding:8px 12px">
          <div style="font-weight:800">Sales Gamify Console</div>
          <div style="display:flex;gap:10px;align-items:center;font-size:12px;color:#666">
            <span>Tenant: <b>${tenant}</b></span>
            <span>Base: <a href="${base}" target="_blank" style="color:#6c5ce7;text-decoration:none">${base}</a></span>
            <button id="sgc-close" style="border:1px solid #e1e1ef;border-radius:8px;padding:6px 10px;cursor:pointer;background:#fff">閉じる</button>
          </div>
        </div>
        <iframe id="sgc-frame" src="${consoleUrl}" style="border:0;width:100%;height:100%;background:#fff"></iframe>
      </div>
    `;
    // 枠外クリックで閉じる
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap) wrap.style.display = "none";
    });
    wrap.querySelector("#sgc-close").addEventListener("click", () => (wrap.style.display = "none"));
    return wrap;
  }

  // ブックマークから呼ばれた瞬間に開く
  toggleOverlay(true);
})();
