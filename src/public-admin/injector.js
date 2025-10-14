(() => {
  const PROFILE_KEY = "sgc.profile.v3";
  const ALWAYS_KEY = "sgc.alwaysShowFab";
  const HIDE_PAID_KEY = "sgc.hidePaidRewards";
  const STYLE_ID = "sgc-injector-style";
  const HIDE_STYLE_ID = "sgc-hide-paid-style";
  const HIDE_CSS = `
    [href="/shops"]{display:none!important;}
    .sidebar .rewards,.right-panel .rewards{display:none!important;}
    .gems,.gem-balance,[class*="gem"]{display:none!important;}
  `;

  const script = document.currentScript;
  let scriptOrigin = "";
  try {
    scriptOrigin = script ? new URL(script.src, window.location.href).origin : "";
  } catch {
    scriptOrigin = "";
  }

  function readProfile() {
    try {
      const raw = localStorage.getItem(PROFILE_KEY);
      if (!raw) return {};
      const data = JSON.parse(raw);
      return data && typeof data === "object" ? data : {};
    } catch {
      return {};
    }
  }

  function saveProfile(profile) {
    try {
      localStorage.setItem(PROFILE_KEY, JSON.stringify(profile || {}));
    } catch {
      /* noop */
    }
  }

  function getProfile() {
    const profile = readProfile();
    if (!profile.baseUrl && scriptOrigin) {
      profile.baseUrl = scriptOrigin.replace(/\/+$/, "");
      saveProfile(profile);
    }
    return profile;
  }

  function shouldShowFab() {
    const flag = localStorage.getItem(ALWAYS_KEY);
    return flag === "1" || flag === "true";
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #sgc-fab{
        position:fixed;
        top:110px;
        right:18px;
        z-index:2147483646;
        background:#6c5ce7;
        color:#fff;
        border-radius:14px;
        padding:10px 14px;
        box-shadow:0 6px 18px rgba(0,0,0,.25);
        font-weight:700;
        display:flex;
        gap:8px;
        align-items:center;
        cursor:pointer;
        user-select:none;
        font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans JP",sans-serif;
      }
      #sgc-fab:hover{filter:brightness(1.06);}
      #sgc-console-overlay{
        position:fixed;
        inset:0;
        background:rgba(0,0,0,0.4);
        display:none;
        align-items:center;
        justify-content:center;
        z-index:2147483647;
      }
      #sgc-console-overlay iframe{
        width:min(1200px,95vw);
        height:90vh;
        border:none;
        border-radius:14px;
        box-shadow:0 24px 48px rgba(0,0,0,0.25);
        background:#fff;
      }
      #sgc-console-overlay .sgc-console-close{
        position:absolute;
        top:24px;
        right:24px;
        width:44px;
        height:44px;
        border:none;
        border-radius:50%;
        font-size:24px;
        cursor:pointer;
        background:#fff;
        box-shadow:0 8px 24px rgba(0,0,0,0.2);
      }
    `;
    document.head.appendChild(style);
  }

  function applyHidePaidRewards() {
    const flag = localStorage.getItem(HIDE_PAID_KEY);
    const enabled = flag === "1" || flag === "true";
    let style = document.getElementById(HIDE_STYLE_ID);
    if (enabled) {
      if (!style) {
        style = document.createElement("style");
        style.id = HIDE_STYLE_ID;
        style.textContent = HIDE_CSS;
        document.head.appendChild(style);
      }
    } else if (style) {
      style.remove();
    }
  }

  function ensureFab() {
    if (!shouldShowFab()) return;
    injectStyles();
    if (document.getElementById("sgc-fab")) return;
    const fab = document.createElement("div");
    fab.id = "sgc-fab";
    fab.textContent = "⚙️ 設定";
    fab.setAttribute("role", "button");
    fab.setAttribute("tabindex", "0");
    const open = () => openConsole();
    fab.addEventListener("click", open);
    fab.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
    document.body.appendChild(fab);
  }

  function removeFab() {
    const fab = document.getElementById("sgc-fab");
    if (fab) fab.remove();
  }

  function openConsole() {
    const profile = getProfile();
    const base = (profile.baseUrl || scriptOrigin || "").replace(/\/+$/, "");
    if (!base) {
      window.alert("BaseURL が未設定です。ブックマークレットを実行してから再度お試しください。");
      return;
    }
    injectStyles();
    let overlay = document.getElementById("sgc-console-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "sgc-console-overlay";
      const iframe = document.createElement("iframe");
      iframe.id = "sgc-console-frame";
      iframe.title = "Sales Gamify Console";
      const tenant = profile.tenant || "default";
      const token = profile.token || "";
      const hash = `#tenant=${encodeURIComponent(tenant)}&token=${encodeURIComponent(token)}&base=${encodeURIComponent(base)}`;
      iframe.src = `${base}/admin/console/${hash}`;
      iframe.allow = "clipboard-write";
      const closeBtn = document.createElement("button");
      closeBtn.className = "sgc-console-close";
      closeBtn.type = "button";
      closeBtn.textContent = "×";
      closeBtn.addEventListener("click", () => closeConsole());
      overlay.appendChild(iframe);
      overlay.appendChild(closeBtn);
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) {
          closeConsole();
        }
      });
      document.body.appendChild(overlay);
    }
    overlay.style.display = "flex";
  }

  function closeConsole() {
    const overlay = document.getElementById("sgc-console-overlay");
    if (overlay) {
      overlay.style.display = "none";
    }
  }

  applyHidePaidRewards();
  if (shouldShowFab()) {
    ensureFab();
  }

  const observer = new MutationObserver(() => {
    if (shouldShowFab()) ensureFab();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener("storage", () => {
    applyHidePaidRewards();
    if (shouldShowFab()) ensureFab();
    else removeFab();
  });

  const allowedOrigin = scriptOrigin;
  window.addEventListener("message", (event) => {
    if (allowedOrigin && event.origin && event.origin !== allowedOrigin) return;
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "sgc.alwaysShowFab") {
      if (data.value) {
        localStorage.setItem(ALWAYS_KEY, "1");
        ensureFab();
      } else {
        localStorage.removeItem(ALWAYS_KEY);
        removeFab();
      }
    } else if (data.type === "sgc.hidePaidRewards") {
      if (data.value) {
        localStorage.setItem(HIDE_PAID_KEY, "1");
      } else {
        localStorage.removeItem(HIDE_PAID_KEY);
      }
      applyHidePaidRewards();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeConsole();
  });

  // expose for debugging
  window.SGCInjector = {
    open: openConsole,
    close: closeConsole,
  };
})();
