// Minimal, safe fallback for /admin/console
// - Do nothing if main UI rendered successfully
// - Provide no-op removeSkeleton (past error guard)
// - If main failed to render (likely due to <base> + relative paths), fetch and show JSON
(() => {
  if (window.__CONSOLE_FALLBACK_ATTACHED__) return;
  window.__CONSOLE_FALLBACK_ATTACHED__ = true;

  // Past log guard: "removeSkeleton is not defined"
  if (typeof window.removeSkeleton !== "function") {
    window.removeSkeleton = () => {};
  }

  const hasVisibleContent = () => {
    const candidates = [
      "[data-console-root]",
      "#console-root",
      "#admin-console-root",
      "#root",
      "main"
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && el.childElementCount > 0) return true;
    }
    const text = (document.body && document.body.innerText || "").trim();
    return text.length > 20;
  };

  const showFallback = async () => {
    if (window.__CONSOLE_FALLBACK_DONE__) return;
    window.__CONSOLE_FALLBACK_DONE__ = true;
    try {
      const [rulesRes, labelsRes] = await Promise.all([
        fetch("/rules", { credentials: "include" }),
        fetch("/labels", { credentials: "include" })
      ]);
      const rules = await rulesRes.json().catch(() => null);
      const labels = await labelsRes.json().catch(() => null);

      const wrap = document.createElement("div");
      wrap.style.cssText =
        "font:14px/1.5 system-ui,sans-serif;padding:16px;max-width:960px;margin:0 auto;";
      const h1 = document.createElement("div");
      h1.textContent = "Loaded (fallback view)";
      h1.style.cssText = "font-weight:700;font-size:18px;margin-bottom:6px;";
      const p = document.createElement("div");
      p.textContent =
        "本来のコンソールの読み込みに失敗したため、最低限のデータを表示しています。";
      p.style.cssText = "margin-bottom:12px;";
      const pre = document.createElement("pre");
      pre.style.cssText =
        "white-space:pre-wrap;background:#f6f8fa;border:1px solid #eaecef;border-radius:8px;padding:12px;overflow:auto;max-height:70vh;";
      pre.textContent = JSON.stringify({ rules, labels }, null, 2);

      document.body.innerHTML = "";
      document.body.appendChild(wrap);
      wrap.appendChild(h1);
      wrap.appendChild(p);
      wrap.appendChild(pre);

      try { window.parent && window.parent.postMessage("sgc-ready","*"); } catch {}
    } catch (e) {
      console.error("console.fallback failed", e);
      const msg = document.createElement("div");
      msg.textContent = "Fallback failed to fetch data.";
      document.body.appendChild(msg);
    }
  };

  const decide = () => {
    if (!hasVisibleContent()) {
      showFallback();
    }
  };

  if (document.readyState === "complete") {
    setTimeout(decide, 700);
  } else {
    window.addEventListener("load", () => setTimeout(decide, 700));
    setTimeout(decide, 2000);
  }
})();
