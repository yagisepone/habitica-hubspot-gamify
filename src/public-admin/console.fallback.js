(() => {
  if (window.__CONSOLE_FALLBACK_ATTACHED__) return;
  window.__CONSOLE_FALLBACK_ATTACHED__ = true;

  // guard legacy errors
  if (typeof window.removeSkeleton !== "function") window.removeSkeleton = () => {};

  const isRendered = () => {
    if (window.__CONSOLE_MAIN_RENDERED__ === true) return true;
    const selectors = ["[data-console-root]", "#console-root", "#admin-console-root", "#root", "main"];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      if (el.childElementCount > 2) return true;
      const text = (el.textContent || "").trim();
      if (text.length > 50) return true;
    }
    return false;
  };

  const showFallback = async () => {
    if (window.__CONSOLE_FALLBACK_DONE__) return;
    window.__CONSOLE_FALLBACK_DONE__ = true;
    try {
      const [r1, r2] = await Promise.all([
        fetch("/rules",  { credentials: "include" }),
        fetch("/labels", { credentials: "include" })
      ]);
      const rules  = await r1.json().catch(() => null);
      const labels = await r2.json().catch(() => null);

      const wrap = document.createElement("div");
      wrap.style.cssText = "font:14px/1.5 system-ui,sans-serif;padding:16px;max-width:960px;margin:0 auto;";
      const h1 = document.createElement("div");
      h1.textContent = "Loaded (fallback view)";
      h1.style.cssText = "font-weight:700;font-size:18px;margin-bottom:6px;";
      const p = document.createElement("div");
      p.textContent = "メインUIの初期化に失敗したため、最低限のデータを表示しています。";
      p.style.cssText = "margin-bottom:12px;";
      const pre = document.createElement("pre");
      pre.style.cssText = "white-space:pre-wrap;background:#f6f8fa;border:1px solid #eaecef;border-radius:8px;padding:12px;overflow:auto;max-height:70vh;";
      pre.textContent = JSON.stringify({ rules, labels }, null, 2);

      document.body.innerHTML = "";
      document.body.appendChild(wrap);
      wrap.appendChild(h1);
      wrap.appendChild(p);
      wrap.appendChild(pre);

      try { window.parent && window.parent.postMessage("sgc-ready", "*"); } catch {}
    } catch (e) {
      console.error("console.fallback failed", e);
      const msg = document.createElement("div");
      msg.textContent = "Fallback failed to fetch data.";
      document.body.appendChild(msg);
    }
  };

  const decide = () => { if (!isRendered()) showFallback(); };

  if (document.readyState === "complete") {
    setTimeout(decide, 800);
    setTimeout(decide, 2800);
  } else {
    window.addEventListener("load", () => {
      setTimeout(decide, 800);
      setTimeout(decide, 2800);
    });
    setTimeout(decide, 3000);
  }
})();
