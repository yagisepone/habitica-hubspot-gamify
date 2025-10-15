(() => {
  const IDS = {
    fab: "sgc-fab",
    modal: "sgc-console-modal",
    style: "sgc-console-style",
    lock: "sgc-console-lock",
  };
  if (document.getElementById(IDS.lock)) return;
  const lock = document.createElement("meta");
  lock.id = IDS.lock;
  document.head.appendChild(lock);

  // -------- BASE URL を決定
  let base = "";
  try {
    const script = document.currentScript;
    base = script ? new URL(script.src, location.href).origin : location.origin;
  } catch (_) {
    base = location.origin;
  }
  if (!base || base === "null" || base === "about:blank") {
    base = "https://sales-gamify.onrender.com"; // 必要に応じて変更
  }
  const CONSOLE_HTML_URL = `${base}/admin/console/console.html`;

  // -------- CSS（見やすいサイズ）
  if (!document.getElementById(IDS.style)) {
    const css = `
      #${IDS.fab}{
        position:fixed; right:18px; bottom:18px; z-index:2147483000;
        width:56px; height:56px; border-radius:50%;
        background:#4f46e5; color:#fff; box-shadow:0 6px 24px rgba(0,0,0,.2);
        display:flex; align-items:center; justify-content:center;
        cursor:pointer; font-size:28px; user-select:none;
      }
      #${IDS.modal}{
        position:fixed; inset:0; z-index:2147483001; display:none;
        background:rgba(0,0,0,.45); backdrop-filter:saturate(120%) blur(1px);
      }
      #${IDS.modal} .sgc-sheet{
        position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
        width:min(1100px,90vw); height:min(80vh,720px); border-radius:14px;
        background:#fff; box-shadow:0 20px 60px rgba(0,0,0,.25);
        overflow:hidden; display:flex; flex-direction:column;
      }
      #${IDS.modal} header{
        padding:14px 16px; font-size:16px; font-weight:600; background:#f8fafc;
        display:flex; justify-content:space-between; align-items:center;
        border-bottom:1px solid #eef2f7;
      }
      #${IDS.modal} iframe{ width:100%; height:100%; border:0; }
      #${IDS.modal} .close{ font-size:22px; line-height:1; cursor:pointer; color:#475569; }
    `;
    const style = document.createElement("style");
    style.id = IDS.style;
    style.textContent = css;
    document.head.appendChild(style);
  }

  // -------- FAB（歯車）
  function ensureFab() {
    if (document.getElementById(IDS.fab)) return;
    const b = document.createElement("div");
    b.id = IDS.fab;
    b.title = "Sales Gamify Console";
    b.innerHTML = "&#9881;";
    b.addEventListener("click", openModal);
    document.body.appendChild(b);
  }

  // -------- モーダル
  function ensureModal() {
    if (document.getElementById(IDS.modal)) return;
    const m = document.createElement("div");
    m.id = IDS.modal;
    m.innerHTML = `
      <div class="sgc-sheet">
        <header>
          <span>Sales Gamify Console</span>
          <span class="close" aria-label="close" title="閉じる">&times;</span>
        </header>
        <div style="flex:1;min-height:0">
          <iframe src="about:blank"></iframe>
        </div>
      </div>
    `;
    m.addEventListener("click", (e) => {
      if (e.target === m || (e.target && e.target.classList.contains("close"))) {
        m.style.display = "none";
      }
    });
    document.body.appendChild(m);
  }

  function openModal() {
    ensureModal();
    const m = document.getElementById(IDS.modal);
    const f = m.querySelector("iframe");
    f.src = CONSOLE_HTML_URL + "?ts=" + Date.now();
    m.style.display = "block";
  }

  ensureFab();
})();
