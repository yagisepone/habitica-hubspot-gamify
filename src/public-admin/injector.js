// src/public-admin/injector.js
// 全部入りローダー本体：⚙️コンソール + ジェム非表示（解除可）
// ページ読み込み時に一回だけ初期化。再実行するとオーバーレイをトグル。

(function () {
  const KEY = "sgc.profile.v3";
  const zTop = 2147483646;

  // ---- Profile: 未設定のときだけ初期値を入れる（既存値は尊重） ----
  try {
    const cur = JSON.parse(localStorage.getItem(KEY) || "null");
    if (!cur || !cur.baseUrl || !cur.tenant || !cur.token) {
      const p = {
        baseUrl: "https://sales-gamify.onrender.com",
        tenant: "ワビサビ株式会社",
        token: "wabisabi-habitica-hubspot-connection",
      };
      localStorage.setItem(KEY, JSON.stringify(p));
    }
  } catch {
    // ignore
  }

  const p = (() => {
    try {
      return JSON.parse(localStorage.getItem(KEY) || "{}") || {};
    } catch {
      return {};
    }
  })();

  // ---- Overlay Console ----
  function consoleUrl() {
    const qs = new URLSearchParams({
      tenant: String(p.tenant || ""),
      token: String(p.token || ""),
      base: String(p.baseUrl || ""),
    });
    return String(p.baseUrl || "") + "/admin/console/#" + qs.toString();
  }

  function openOverlay() {
    const old = document.getElementById("sgc-overlay");
    if (old) old.remove();

    const mask = document.createElement("div");
    mask.id = "sgc-overlay";
    mask.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,.20);z-index:${zTop}`;

    const fr = document.createElement("iframe");
    fr.src = consoleUrl();
    fr.allow = "clipboard-read; clipboard-write";
    fr.style.cssText =
      "position:absolute;top:60px;left:50%;transform:translateX(-50%);width:min(1120px,94vw);height:86vh;border:0;border-radius:14px;background:#fff;box-shadow:0 24px 48px rgba(0,0,0,.25)";

    const bt = document.createElement("button");
    bt.textContent = "×";
    bt.title = "閉じる";
    bt.style.cssText =
      "position:absolute;top:22px;right:22px;width:40px;height:40px;border:0;border-radius:10px;background:#fff;box-shadow:0 4px 12px rgba(0,0,0,.2);font-size:22px;cursor:pointer";
    bt.onclick = () => mask.remove();

    mask.append(fr, bt);
    document.body.appendChild(mask);
  }

  function toggleOverlay() {
    const cur = document.getElementById("sgc-overlay");
    if (cur) cur.remove();
    else openOverlay();
  }

  // ---- Gear Button ----
  function ensureGear() {
    if (document.getElementById("sgc-gear")) return;
    const gear = document.createElement("div");
    gear.id = "sgc-gear";
    gear.textContent = "⚙️ 設定";
    gear.title = "Sales Gamify Console";
    gear.style.cssText = [
      "position:fixed",
      "top:110px",
      "right:18px",
      `z-index:${zTop}`,
      "background:#6c5ce7",
      "color:#fff",
      "border-radius:14px",
      "padding:10px 14px",
      "box-shadow:0 6px 18px rgba(0,0,0,.25)",
      "font-weight:700",
      "display:flex",
      "gap:8px",
      "align-items:center",
      "cursor:pointer",
      "user-select:none",
    ].join(";");
    gear.onclick = toggleOverlay;
    document.body.appendChild(gear);
  }

  // ---- Hide Gem-paid items (shop & optional rewards) ----
  function installHideGems() {
    if (window.__hideGemsUnmount) return; // already installed

    const HCLS = "x-hide-gem-paid";
    const STYLE_ID = "x-hide-gem-style";
    const BTN_ID = "x-hide-gem-btn";
    let mo = null;

    function addStyle(txt, id) {
      let s = document.getElementById(id);
      if (!s) {
        s = document.createElement("style");
        s.id = id;
        document.head.appendChild(s);
      }
      s.textContent = txt;
    }

    function rm(id) {
      const el = document.getElementById(id);
      if (el) el.remove();
    }

    function candidates() {
      return document.querySelectorAll(
        `
        [data-page='shops'] li,
        [data-page='shops'] .item,
        [data-page='shops'] [class*="ShopItem"],
        .market li, .market .item,
        .shop .item, .items .item,
        [data-test="shopItem"],
        [class*="shop-item"], [class*="grid-item"], [class*="ItemCard"]
      `.trim()
      );
    }

    function markGemCard(root) {
      const txt = root.textContent || "";
      const isGem =
        !!(
          root.querySelector(
            '[data-test*="gem" i],[data-testid*="gem" i],[aria-label*="Gem" i],[aria-label*="ジェム"]'
          ) ||
          root.querySelector('svg[class*="gem" i],svg[aria-label*="Gem" i]') ||
          root.querySelector('img[alt*="Gem" i],img[alt*="ジェム"]') ||
          /(^|[^a-z])gem(s)?([^a-z]|$)/i.test(txt) ||
          txt.indexOf("ジェム") >= 0
        );
      if (isGem) root.classList.add(HCLS);
    }

    function sweep() {
      let n = 0;
      candidates().forEach((el) => {
        const card =
          el.closest(
            'li,.item,.shop-item,.grid-item,[class*="Item"],[class*="card"],[data-test="shopItem"]'
          ) || el;
        if (!card || card.classList.contains(HCLS)) return;
        markGemCard(card);
        if (card.classList.contains(HCLS)) n++;
      });
      return n;
    }

    function unmount() {
      if (mo) mo.disconnect();
      rm(STYLE_ID);
      const b = document.getElementById(BTN_ID);
      if (b && b.parentNode) b.parentNode.removeChild(b);
      document.querySelectorAll("." + HCLS).forEach((x) => x.classList.remove(HCLS));
      delete window.__hideGemsUnmount;
    }

    window.__hideGemsUnmount = unmount;

    function addRestoreButton() {
      if (document.getElementById(BTN_ID)) return;
      const b = document.createElement("button");
      b.id = BTN_ID;
      b.textContent = "💎 Paid hidden (click to restore)";
      Object.assign(b.style, {
        position: "fixed",
        right: "16px",
        bottom: "16px",
        zIndex: zTop + 1,
        padding: "6px 10px",
        borderRadius: "10px",
        border: "none",
        background: "#3a7",
        color: "#fff",
        fontSize: "12px",
        boxShadow: "0 2px 8px rgba(0,0,0,.25)",
        cursor: "pointer",
      });
      b.onclick = unmount;
      document.body.appendChild(b);
    }

    let hasHas = false;
    try {
      hasHas = !!(CSS && CSS.supports && CSS.supports("selector(:has(*))"));
    } catch {
      hasHas = false;
    }

    if (hasHas) {
      addStyle(
        `
        [data-page='shops'] .items-list > *:has([data-test*="gem" i],[data-testid*="gem" i],[aria-label*="Gem" i],[aria-label*="ジェム"]),
        [data-page='shops'] .item:has([data-test*="gem" i],[data-testid*="gem" i],[aria-label*="Gem" i],[aria-label*="ジェム"]),
        .task-column--rewards *:has([data-test*="gem" i],[data-testid*="gem" i],[aria-label*="Gem" i],[aria-label*="ジェム"])
        { display:none !important; }
      `.trim(),
        STYLE_ID
      );
      addRestoreButton();
      return;
    }

    addStyle("." + HCLS + "{display:none!important}", STYLE_ID);
    mo = new MutationObserver(() => sweep());
    mo.observe(document.body, { subtree: true, childList: true });
    sweep();
    addRestoreButton();
  }

  // ---- Boot ----
  function boot() {
    ensureGear();
    const mo = new MutationObserver(() => ensureGear());
    mo.observe(document.documentElement, { childList: true, subtree: true });

    installHideGems(); // ジェム非表示（必要なら右下ボタンで解除可）
    toggleOverlay(); // 実行毎にオーバーレイをトグル
  }

  // 1度だけ初期化し、以後はトグルだけとする
  if (!window.__SGC_LOADED__) {
    window.__SGC_LOADED__ = true;
    boot();
  } else {
    toggleOverlay();
  }
})();
