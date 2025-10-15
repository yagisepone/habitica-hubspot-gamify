(function () {
  const p = new URLSearchParams(location.search);
  const qTenant = p.get("tenant");
  const saved = localStorage.getItem("gamify_tenant") || "";
  const originMap = { "https://habitica.com": "default" };
  const tenant = qTenant || saved || originMap[location.origin] || "default";
  if (!saved && tenant) localStorage.setItem("gamify_tenant", tenant);

  // 各社RenderのBaseURLマップ（必要に応じて追加）
  const baseURLMap = {
    default: "https://sales-gamify.onrender.com",
    // acme: 'https://acme-gamify.onrender.com',
    // foo:  'https://foo-gamify.onrender.com',
  };
  const baseURL = baseURLMap[tenant] || baseURLMap.default;

  const u = `${baseURL}/admin/console/injector.js?tenant=${encodeURIComponent(tenant)}&base=${encodeURIComponent(
    baseURL
  )}&ts=${Date.now()}`;
  const s = document.createElement("script");
  s.src = u;
  s.crossOrigin = "anonymous";
  s.onerror = () => alert("設定パネルの読み込みに失敗: " + u);
  (document.head || document.documentElement).appendChild(s);
})();
