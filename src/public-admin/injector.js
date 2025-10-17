// src/public-admin/injector.js
// Overlay Console + Hide-Gems (強化版)
// - ギア: 右上の小型丸ボタン。被りを最小化
// - オーバーレイ: 余白なしの全画面 iframe（overlay=1 を付けて内部UIの「設定」等を隠す）
// - ジェム非表示: :has() + Fallback監視。トグルは右上で視認性UP

(function () {
  const KEY = "sgc.profile.v3";
  const zTop = 2147483600;

  try {
    const cur = JSON.parse(localStorage.getItem(KEY) || "null");
    if (!cur || !cur.baseUrl || !cur.tenant || !cur.token) {
      localStorage.setItem(
        KEY,
        JSON.stringify({
          baseUrl: "https://sales-gamify.onrender.com",
          tenant: "ワビサビ株式会社",
          token: "wabisabi-habitica-hubspot-connection",
        })
      );
    }
  } catch {}
  const p = (() => {
    try {
      return JSON.parse(localStorage.getItem(KEY) || "{}") || {};
    } catch {
      return {};
    }
  })();

  function consoleUrl() {
    const qs = new URLSearchParams({
      tenant: String(p.tenant || ""),
      token: String(p.token || ""),
      base: String(p.baseUrl || ""),
      overlay: "1",
    });
    return String(p.baseUrl || "") + "/admin/console/#" + qs.toString();
  }
  function openOverlay() {
    closeOverlay();
    const mask = document.createElement("div");
    mask.id = "sgc-overlay";
    mask.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,.30);z-index:${zTop}`;

    const fr = document.createElement("iframe");
    fr.src = consoleUrl();
    fr.allow = "clipboard-read; clipboard-write";
    fr.style.cssText =
      "position:absolute;inset:0;width:100vw;height:100vh;border:0;border-radius:0;box-shadow:none;background:#fff";

    const close = document.createElement("button");
    close.textContent = "×";
    close.title = "閉じる";
    close.style.cssText = `position:fixed;top:14px;right:14px;width:40px;height:40px;border:0;border-radius:10px;background:#fff;box-shadow:0 4px 12px rgba(0,0,0,.2);font-size:20px;cursor:pointer;z-index:${zTop + 2}`;
    close.onclick = () => mask.remove();

    mask.append(fr, close);
    document.body.appendChild(mask);
  }
  function closeOverlay() {
    const e = document.getElementById("sgc-overlay");
    if (e) e.remove();
  }
  function toggleOverlay() {
    const e = document.getElementById("sgc-overlay");
    e ? closeOverlay() : openOverlay();
  }

function ensureGear(){
    if (document.getElementById("sgc-gear")) return;
    const gear = document.createElement("button");
    gear.id = "sgc-gear";
    gear.setAttribute("aria-label","Sales Gamify Console");
    gear.textContent = "⚙️";
    gear.style.cssText = [
      "position:fixed","top:16px","right:16px",`z-index:${zTop+1}`,
      "width:40px","height:40px","border-radius:20px",
      "background:#6c5ce7","color:#fff","border:none",
      "box-shadow:0 6px 18px rgba(0,0,0,.25)",
      "font-size:18px","line-height:40px","text-align:center",
      "cursor:pointer","user-select:none","opacity:.96"
    ].join(";");
    gear.onmouseenter = ()=> gear.style.opacity = "1";
    gear.onmouseleave = ()=> gear.style.opacity = ".96";
    gear.onclick = toggleOverlay;
    document.body.appendChild(gear);
    placeGearSafely();
  }

function installHideGems() {
    if (window.__hideGemsUnmount) return;

    const HCLS = "x-hide-gem-paid";
    const STYLE_ID = "x-hide-gem-style";
    const BTN_ID = "x-hide-gem-btn";

    const addStyle = (txt, id) => {
      let s = document.getElementById(id);
      if (!s) {
        s = document.createElement("style");
        s.id = id;
        document.head.appendChild(s);
      }
      s.textContent = txt;
    };
    const rm = (id) => {
      const el = document.getElementById(id);
      if (el) el.remove();
    };

    const candidates = () =>
      document.querySelectorAll(
        `
        [data-page='shops'] li,
        [data-page='shops'] .item,
        [data-page='shops'] [class*="ShopItem"],
        .market li, .market .item,
        .shop .item, .items .item,
        [data-test="shopItem"],
        [class*="shop-item"], [class*="grid-item"], [class*="ItemCard"], [class*="ItemTile"]
      `
      );
    const isGemCard = (root) => {
      if (root.querySelector('[data-test*="gem" i],[data-testid*="gem" i]')) return true;
      if (root.querySelector('[aria-label*="Gem" i],[aria-label*="ジェム"]')) return true;
      if (root.querySelector('svg[class*="gem" i],svg[aria-label*="Gem" i]')) return true;
      if (root.querySelector('img[alt*="Gem" i],img[alt*="ジェム"]')) return true;
      const txt = (root.textContent || "").replace(/\s+/g, " ").trim();
      if (/([^a-z]|^)gem(s)?([^a-z]|$)/i.test(txt)) return true;
      if (txt.includes("ジェム") || txt.includes("💎")) return true;
      return false;
    };
    const markGemCard = (root) => {
      const card =
        root.closest('li,.item,.shop-item,.grid-item,[class*="Item"],[class*="card"]') || root;
      if (card && !card.classList.contains(HCLS) && isGemCard(card)) {
        card.classList.add(HCLS);
      }
    };
    const sweep = () => {
      let n = 0;
      candidates().forEach((el) => {
        markGemCard(el);
        if (el.classList.contains(HCLS)) n++;
      });
      return n;
    };

    let supportsHas = false;
    try {
      supportsHas = !!(CSS && CSS.supports && CSS.supports("selector(:has(*))"));
    } catch {
      supportsHas = false;
    }
    if (supportsHas) {
      addStyle(
        `
        [data-page='shops'] .items-list > *:has([data-test*="gem" i],[data-testid*="gem" i],[aria-label*="Gem" i],[aria-label*="ジェム"]),
        [data-page='shops'] .item:has([data-test*="gem" i],[data-testid*="gem" i],[aria-label*="Gem" i],[aria-label*="ジェム"]),
        .task-column--rewards *:has([data-test*="gem" i],[data-testid*="gem" i],[aria-label*="Gem" i],[aria-label*="ジェム"])
        { display:none !important; }
      `,
        STYLE_ID
      );
    } else {
      addStyle(`.${HCLS}{display:none!important}`, STYLE_ID);
      const mo = new MutationObserver(() => sweep());
      mo.observe(document.body, { subtree: true, childList: true });
      sweep();
    }

    const addToggle = () => {
      if (document.getElementById(BTN_ID)) return;
      const b = document.createElement("button");
      b.id = BTN_ID;
      b.textContent = "💎 ジェム非表示: ON（クリックで解除）";
      Object.assign(b.style, {
        position: "fixed",
        top: "64px",
        right: "16px",
        zIndex: zTop + 1,
        padding: "8px 12px",
        borderRadius: "18px",
        border: "none",
        background: "#16a34a",
        color: "#fff",
        fontSize: "13px",
        boxShadow: "0 2px 8px rgba(0,0,0,.25)",
        cursor: "pointer",
      });
      b.onclick = () => {
        rm(STYLE_ID);
        document.querySelectorAll("." + HCLS).forEach((x) => x.classList.remove(HCLS));
        b.remove();
        delete window.__hideGemsUnmount;
      };
      document.body.appendChild(b);
    };
    window.__hideGemsUnmount = () => {
      rm(STYLE_ID);
      const b = document.getElementById(BTN_ID);
      if (b) b.remove();
      document.querySelectorAll("." + HCLS).forEach((x) => x.classList.remove(HCLS));
      delete window.__hideGemsUnmount;
    };
    addToggle();
  }

  function placeGearSafely(){
    const gear = document.getElementById("sgc-gear");
    if (!gear) return;
    const SAFETY_GAP = 8;
    const TOP_MIN = 16;
    const RIGHT_EDGE = 220;
    const TOP_SCAN = 120;
    let top = TOP_MIN;
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const nodes = Array.from(
      document.querySelectorAll(
        'a,button,[role="button"],[tabindex],.btn,[class*="Button"],[class*="button"]'
      )
    ).filter((el) => {
      const r = el.getBoundingClientRect();
      if (!r || r.width === 0 || r.height === 0) return false;
      const nearRight = vw - r.right < RIGHT_EDGE;
      const nearTop = r.top < TOP_SCAN;
      return nearRight && nearTop;
    });
    let maxBottom = 0;
    for (const el of nodes) {
      const r = el.getBoundingClientRect();
      if (r.bottom > maxBottom) maxBottom = r.bottom;
    }
    const desiredTop = Math.max(TOP_MIN, Math.ceil(maxBottom + SAFETY_GAP));
    const maxTop = Math.max(TOP_MIN, (window.innerHeight || 0) - 56);
    top = Math.min(desiredTop, maxTop);
    gear.style.top = `${top}px`;
  }

  function boot() {
    ensureGear();
    const mo = new MutationObserver(() => ensureGear());
    mo.observe(document.documentElement, { childList: true, subtree: true });
    installHideGems();
    placeGearSafely();
    window.addEventListener("resize", placeGearSafely);
    new MutationObserver(() => placeGearSafely()).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
    });
  }

  if (!window.__SGC_LOADED__) {
    window.__SGC_LOADED__ = true;
    boot();
  }
  toggleOverlay();
})();
