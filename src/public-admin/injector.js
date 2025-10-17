// src/public-admin/injector.js
// Overlay Console + Hide-Gems（強化版）
// - ギア: 「パーティーを見る」ボタン直下にアンカー（見つからない場合は右上安全配置）
// - オーバーレイ: 全画面 iframe（overlay=1 で内部UIの二重設定を抑制）
// - ジェム非表示: :has() 優先 + Fallback 監視。トグルは常に⚙️の真下へ追従

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

  function ensureGear() {
    if (document.getElementById("sgc-gear")) return;
    const gear = document.createElement("button");
    gear.id = "sgc-gear";
    gear.setAttribute("aria-label", "Sales Gamify Console");
    gear.textContent = "⚙️";
    gear.style.cssText = [
      "position:fixed",
      "top:16px",
      "right:16px",
      `z-index:${zTop + 1}`,
      "width:40px",
      "height:40px",
      "border-radius:20px",
      "background:#6c5ce7",
      "color:#fff",
      "border:none",
      "box-shadow:0 6px 18px rgba(0,0,0,.25)",
      "font-size:18px",
      "line-height:40px",
      "text-align:center",
      "cursor:pointer",
      "user-select:none",
      "opacity:.96",
    ].join(";");
    gear.onmouseenter = () => (gear.style.opacity = "1");
    gear.onmouseleave = () => (gear.style.opacity = ".96");
    gear.onclick = toggleOverlay;
    document.body.appendChild(gear);
    if (!placeGearUnderParty()) placeGearSafely();
    positionGemToggleNearGear();
  }

  function findPartyButton() {
    const nodes = document.querySelectorAll(
      'a,button,[role="button"],.btn,[class*="Button"],[class*="button"]'
    );
    const keys = ["パーティ", "パーティー", "Party", "ViewParty", "ViewPartyButton"];
    let best = null;
    let bestArea = 0;
    nodes.forEach((el) => {
      if (!el.isConnected) return;
      const r = el.getBoundingClientRect();
      if (!r || r.width === 0 || r.height === 0) return;
      const t = (el.textContent || "").replace(/\s+/g, "").trim();
      if (keys.some((k) => t.includes(k))) {
        const area = r.width * r.height;
        if (area > bestArea) {
          bestArea = area;
          best = el;
        }
      }
    });
    return best;
  }

  function placeGearUnderParty() {
    const gear = document.getElementById("sgc-gear");
    if (!gear) return false;
    const btn = findPartyButton();
    if (!btn) return false;
    const r = btn.getBoundingClientRect();
    const GAP = 8;
    const SIZE = 40;
    const RIGHT_MIN = 16;
    const TOP_MIN = 16;

    const rightOffset = Math.max(RIGHT_MIN, Math.round(window.innerWidth - r.right));
    let top = Math.round(r.bottom + GAP);
    const maxTop = Math.max(TOP_MIN, (window.innerHeight || 800) - (SIZE + 16));
    top = Math.min(top, maxTop);

    gear.style.right = `${rightOffset}px`;
    gear.style.top = `${top}px`;
    positionGemToggleNearGear();
    return true;
  }

  function placeGearSafely() {
    const gear = document.getElementById("sgc-gear");
    if (!gear) return;
    const TOP_MIN = 16;
    const RIGHT_MARGIN = 16;
    const SIZE = 40;
    const GAP = 8;
    const RIGHT_ZONE_W = 360;
    const TOP_ZONE_H = 260;
    const MAX_ITER = 10;

    const vw = window.innerWidth || document.documentElement.clientWidth;
    const zone = {
      left: vw - RIGHT_ZONE_W,
      right: vw,
      top: 0,
      bottom: TOP_ZONE_H,
    };

    const candidates = Array.from(
      document.querySelectorAll(
        'a,button,[role="button"],[tabindex],.btn,[class*="Button"],[class*="button"],[class*="pill"],[class*="Chip"],[class*="Badge"],[class*="popover"],[class*="tooltip"],[class*="menu"]'
      )
    ).filter((el) => {
      const r = el.getBoundingClientRect();
      if (!r || r.width === 0 || r.height === 0) return false;
      return !(
        r.right < zone.left ||
        r.left > zone.right ||
        r.bottom < zone.top ||
        r.top > zone.bottom
      );
    });

    candidates.push(
      ...Array.from(document.querySelectorAll("*")).filter((el) => {
        const st = window.getComputedStyle(el);
        if (st.position !== "fixed") return false;
        const r = el.getBoundingClientRect();
        if (!r || r.width === 0 || r.height === 0) return false;
        return !(
          r.right < zone.left ||
          r.left > zone.right ||
          r.bottom < zone.top ||
          r.top > zone.bottom
        );
      })
    );

    let top = TOP_MIN;
    const left = vw - RIGHT_MARGIN - SIZE;
    let iterations = 0;

    const intersects = (a, b) =>
      !(
        a.right <= b.left ||
        a.left >= b.right ||
        a.bottom <= b.top ||
        a.top >= b.bottom
      );

    while (iterations++ < MAX_ITER) {
      const box = { left, right: left + SIZE, top, bottom: top + SIZE };
      let bumped = false;
      let bumpTo = top;
      for (const el of candidates) {
        const r = el.getBoundingClientRect();
        if (!r) continue;
        if (intersects(box, r)) {
          bumped = true;
          bumpTo = Math.max(bumpTo, Math.ceil(r.bottom + GAP));
        }
      }
      if (!bumped) break;
      top = bumpTo;
    }

    const maxTop = Math.max(TOP_MIN, (window.innerHeight || 800) - (SIZE + 16));
    gear.style.top = `${Math.min(top, maxTop)}px`;
    gear.style.right = `${RIGHT_MARGIN}px`;
    positionGemToggleNearGear();
  }

  function positionGemToggleNearGear() {
    const toggle = document.getElementById("x-hide-gem-btn");
    const gear = document.getElementById("sgc-gear");
    if (!toggle || !gear) return;
    const cs = window.getComputedStyle(gear);
    const top = parseInt(cs.top, 10) || 16;
    const right = parseInt(cs.right, 10) || 16;
    toggle.style.position = "fixed";
    toggle.style.top = `${top + 48}px`;
    toggle.style.right = `${right}px`;
    toggle.style.zIndex = `${zTop + 1}`;
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
      if (card && !card.classList.contains(HCLS) && isGemCard(card)) card.classList.add(HCLS);
    };
    const sweep = () => {
      candidates().forEach((el) => markGemCard(el));
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

    function addToggle() {
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
      positionGemToggleNearGear();
    }

    window.__hideGemsUnmount = () => {
      rm(STYLE_ID);
      const b = document.getElementById(BTN_ID);
      if (b) b.remove();
      document.querySelectorAll("." + HCLS).forEach((x) => x.classList.remove(HCLS));
      delete window.__hideGemsUnmount;
    };

    addToggle();
  }

  function reflowUI() {
    if (!placeGearUnderParty()) placeGearSafely();
    positionGemToggleNearGear();
  }

  function boot() {
    ensureGear();
    const ensureMo = new MutationObserver(() => ensureGear());
    ensureMo.observe(document.documentElement, { childList: true, subtree: true });
    installHideGems();
    reflowUI();
    window.addEventListener("resize", reflowUI);
    new MutationObserver(reflowUI).observe(document.body, {
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
