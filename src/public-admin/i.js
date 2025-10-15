(function () {
  const p = new URLSearchParams(location.search);
  const qTenant = p.get("tenant");
  const savedTenant = (localStorage.getItem("gamify_tenant") || "").trim();
  const tenant = qTenant || savedTenant || "default";
  if (!savedTenant && tenant) localStorage.setItem("gamify_tenant", tenant);

  const baseURLMap = {
    default: "https://sales-gamify.onrender.com",
    // acme: "https://acme-gamify.onrender.com",
    // foo: "https://foo-gamify.onrender.com",
  };
  const base = baseURLMap[tenant] || baseURLMap.default;

  const u = `${base}/admin/console/injector.js?tenant=${encodeURIComponent(tenant)}&base=${encodeURIComponent(
    base
  )}&ts=${Date.now()}`;
  const s = document.createElement("script");
  s.src = u;
  s.crossOrigin = "anonymous";
  s.defer = false;
  s.onerror = () => alert("設定パネルの読み込みに失敗: " + u);
  (document.head || document.documentElement).appendChild(s);
})();
