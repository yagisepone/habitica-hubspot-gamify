(() => {
  if (window.__SGC_LOADED__) { window.SGC?.toggle(); return; }
  window.__SGC_LOADED__ = true;

  // --- state & storage ---
  const LS_POS = "sgc.fab.pos.v1";
  const LS_CFG = "sgc.settings.v1";
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || "null") ?? d; } catch { return d; } };
  const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));
  const cfg = load(LS_CFG, { tenant:"", baseUrl:"https://sales-gamify.onrender.com", token:"" });
  const pos = load(LS_POS, { right: 18, bottom: 18 }); // 位置保存（右下デフォルト）

  // --- Shadow DOM (CSSを隔離) ---
  const host = document.createElement("div");
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: "open" });

  const css = document.createElement("style");
  css.textContent = `
    .sgc-fab { position: fixed; z-index: 999999; }
    .sgc-fab .btn {
      all: unset; background:#6b5b95; color:#fff; font:600 14px/1 system-ui;
      padding:10px 12px; border-radius:10px; box-shadow:0 2px 8px rgba(0,0,0,.2);
      cursor:pointer; user-select:none;
    }
    .sgc-mask { position: fixed; inset: 0; background: rgba(0,0,0,.35); z-index: 999998; }
    .sgc-modal {
      position: fixed; right: 24px; bottom: 72px; width: 760px; max-width: calc(100vw - 40px);
      max-height: calc(100vh - 120px); background:#fff; border-radius:12px; overflow:hidden;
      box-shadow: 0 10px 30px rgba(0,0,0,.25); display:flex; flex-direction:column; z-index: 999999;
    }
    .hd { display:flex; gap:10px; align-items:center; padding:12px 14px; background:#f6f7fb; border-bottom:1px solid #e8eaf2; }
    .hd .ttl { font:700 15px system-ui; color:#333; margin-right:auto; }
    .hd input { font:14px system-ui; padding:6px 8px; border:1px solid #dcdfea; border-radius:8px; width:180px; }
    .hd .token { width:230px; }
    .hd .btn { all:unset; background:#4c7ef3; color:#fff; padding:8px 10px; border-radius:8px; cursor:pointer; }
    .body { padding:12px 14px; overflow:auto; }
    .ft { padding:8px 14px; border-top:1px solid #e8eaf2; display:flex; justify-content:space-between; font:12px system-ui; color:#666; }
    .close { all:unset; background:#eee; padding:4px 8px; border-radius:6px; cursor:pointer; }
    .toast { position: fixed; right: 24px; top: 24px; background:#222; color:#fff; padding:10px 12px; border-radius:10px; z-index: 1000000; }
  `;
  root.append(css);

  const elFab = document.createElement("div");
  elFab.className = "sgc-fab";
  elFab.style.right = pos.right + "px";
  elFab.style.bottom = pos.bottom + "px";
  elFab.innerHTML = `<button class="btn" title="ドラッグで移動">⚙ 設定</button>`;

  const elMask = document.createElement("div");
  elMask.className = "sgc-mask"; elMask.hidden = true;

  const elModal = document.createElement("div");
  elModal.className = "sgc-modal"; elModal.hidden = true;
  elModal.innerHTML = `
    <div class="hd">
      <div class="ttl">Sales Gamify Console</div>
      <input placeholder="Tenant" value="${cfg.tenant}">
      <input placeholder="BaseURL" value="${cfg.baseUrl}">
      <input placeholder="Token" type="password" class="token" value="${cfg.token}">
      <button class="btn ping">Ping</button>
      <button class="btn save">保存</button>
      <button class="close">閉じる</button>
    </div>
    <div class="body">
      <p>背景のHabiticaは見えるまま、ここに設定UIを並べていきます。</p>
    </div>
    <div class="ft">
      <span>SGC v2.1</span>
      <span class="role"></span>
    </div>
  `;

  root.append(elFab, elMask, elModal);

  // --- 開閉 & Toast ---
  const show = () => { elMask.hidden = false; elModal.hidden = false; };
  const hide = () => { elMask.hidden = true;  elModal.hidden = true;  };
  const toast = (m, t=1800) => {
    const x = document.createElement("div");
    x.className = "toast"; x.textContent = m; root.append(x); setTimeout(()=>x.remove(), t);
  };

  // --- ボタン動作 ---
  root.querySelector(".btn")?.addEventListener("click", show);
  elMask.addEventListener("click", hide);
  elModal.querySelector(".close").addEventListener("click", hide);

  // --- Ping/保存 ---
  elModal.querySelector(".save").addEventListener("click", () => {
    const [tenant, baseUrl, token] = Array.from(elModal.querySelectorAll(".hd input")).map(i=>i.value.trim());
    save(LS_CFG, { tenant, baseUrl: baseUrl.replace(/\\/+$/,""), token });
    toast("保存しました");
  });
  elModal.querySelector(".ping").addEventListener("click", async () => {
    const [tenant, baseUrl, token] = Array.from(elModal.querySelectorAll(".hd input")).map(i=>i.value.trim());
    try {
      const r = await fetch(baseUrl.replace(/\\/+$/,"") + "/ping", { headers: { "x-sgc-token": token } });
      const j = await r.json().catch(()=>({}));
      elModal.querySelector(".role").textContent = "Role: " + (j.role || "unknown");
      toast(r.ok ? "Ping OK" : "Ping NG");
    } catch(e){ toast("Ping NG"); }
  });

  // --- FAB: ドラッグで位置変更（座標保存） ---
  (() => {
    const btn = elFab.querySelector(".btn");
    let dragging = false, sx=0, sy=0, sr=0, sb=0;
    btn.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0) return;
      dragging = true; sx = ev.clientX; sy = ev.clientY;
      sr = parseInt(elFab.style.right); sb = parseInt(elFab.style.bottom);
      ev.preventDefault();
    });
    window.addEventListener("mousemove", (ev) => {
      if (!dragging) return;
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      elFab.style.right  = Math.max(8, sr - dx) + "px";
      elFab.style.bottom = Math.max(8, sb - dy) + "px";
    });
    window.addEventListener("mouseup", () => {
      if (!dragging) return; dragging = false;
      save(LS_POS, { right: parseInt(elFab.style.right), bottom: parseInt(elFab.style.bottom) });
    });
  })();

  // --- public API（ブックマーク2回押しでトグル） ---
  window.SGC = { toggle: () => (elModal.hidden ? show() : hide()), unmount: () => { host.remove(); delete window.__SGC_LOADED__; } };
})();
