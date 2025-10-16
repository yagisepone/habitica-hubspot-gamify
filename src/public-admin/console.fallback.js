// Minimal, safe boot if the real app didn't render anything.
// 1) guard: if something already drew meaningful content, do nothing
(function () {
  // provide noop for old calls
  window.removeSkeleton = window.removeSkeleton || function(){};

  function bodyLooksEmpty() {
    const t = (document.body.textContent || "").trim();
    // consider "Sales Gamify Console" header or any non-empty content as rendered
    return document.body.children.length === 0 || t.length === 0;
  }

  // Run after current task queue to allow earlier scripts to render first
  setTimeout(async () => {
    try {
      if (!bodyLooksEmpty()) return; // real app already rendered

      // Create minimal app container
      const root = document.getElementById("sgc-root") || document.createElement("div");
      root.id = "sgc-root";
      root.style.cssText = "max-width:1080px;margin:16px auto;padding:16px;font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;color:#222";
      root.innerHTML = "<h1 style='margin:0 0 12px'>Sales Gamify Console</h1><div id='sgc-status'>Loading…</div>";
      if (!root.isConnected) document.body.appendChild(root);

      const status = document.getElementById("sgc-status");

      async function j(p){ const r = await fetch(p, {credentials:"include"}); if(!r.ok) throw new Error(p+" "+r.status); return r.json(); }
      const [rules, labels] = await Promise.all([ j("/rules"), j("/labels") ]);

      // Simple render so it's not blank (keeps prod usable while we track real UI)
      const pre = document.createElement("pre");
      pre.style.cssText = "background:#f6f7f8;border:1px solid #e5e7eb;border-radius:8px;padding:12px;overflow:auto;max-height:60vh";
      pre.textContent = JSON.stringify({ rules, labels }, null, 2);
      status.textContent = "Loaded (fallback view)";
      status.style.opacity = "0.7";
      status.insertAdjacentElement("afterend", pre);
    } catch (e) {
      const err = document.createElement("div");
      err.style.cssText = "color:#b00020;margin-top:8px";
      err.textContent = "Failed to boot console: " + (e && e.message ? e.message : e);
      document.body.appendChild(err);
      // ensure we never leave user with a blank page
      console.error(e);
    }
  }, 0);
})();
