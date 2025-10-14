/* Sales Gamify Console – injector (overlay iframe loader) */
(() => {
  const ID = "sgc-overlay";
  if (document.getElementById(ID)) { // 2回目以降は表示/非表示トグル
    const box = document.getElementById(ID);
    box.style.display = (box.style.display === "none" ? "block" : "none");
    return;
  }

  // 既定BASE（必要なら自社Renderに変更）-------------------------
  const DEFAULT_BASE = "https://sales-gamify.onrender.com";
  //------------------------------------------------------------

  // 既存のプロフィール（tenant/base/token）を Habitica 側 localStorage から読む
  let prof = {};
  try { prof = JSON.parse(localStorage.getItem("sgc.profile.v3") || "{}") || {}; } catch {}
  const tenant = prof.tenant || "default";
  const base   = (prof.baseUrl || DEFAULT_BASE).replace(/\/+$/,"");
  const token  = prof.token || "";

  // console.html へマジックパラメータを橋渡し（初回の利便性）
  const q = new URLSearchParams();
  if (tenant) q.set("tenant", tenant);
  if (token)  q.set("token", token);
  if (base)   q.set("base", base);
  const consoleUrl = `${base}/admin/console/${q.toString() ? "#" + q.toString() : ""}`;

  // オーバーレイ作成（iframeで /admin/console をそのまま表示）
  const wrap = document.createElement("div");
  wrap.id = ID;
  wrap.style.cssText = `
    position:fixed; inset:0; z-index:2147483646; background:rgba(0,0,0,.40);
    display:block; backdrop-filter:saturate(110%) blur(1.5px);
  `;
  wrap.innerHTML = `
    <div style="
      position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
      width:min(1100px,95vw); height:min(85vh,95vh); background:#fff; border-radius:14px;
      box-shadow:0 20px 48px rgba(0,0,0,.35); overflow:hidden; display:flex; flex-direction:column;">
      <div style="display:flex; align-items:center; justify-content:space-between;
                  background:#f7f7fb; border-bottom:1px solid #ececf5; padding:8px 12px;">
        <div style="font-weight:800">Sales Gamify Console</div>
        <div style="display:flex; gap:8px; align-items:center; font-size:12px; color:#666">
          <span>Tenant: <b>${tenant}</b></span>
          <span>Base: <b>${base}</b></span>
          <button id="sgc-close" style="border:1px solid #e1e1ef;border-radius:8px;padding:6px 10px;cursor:pointer;background:#fff">閉じる</button>
        </div>
      </div>
      <iframe id="sgc-frame" src="${consoleUrl}" style="border:0; width:100%; height:100%; background:#fff"></iframe>
    </div>
  `;
  document.body.appendChild(wrap);
  wrap.addEventListener("click", (e)=>{ if(e.target===wrap) wrap.style.display="none"; });
  wrap.querySelector("#sgc-close").addEventListener("click", ()=> wrap.style.display="none");
})();
