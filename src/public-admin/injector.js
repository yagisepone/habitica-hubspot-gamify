/* Sales Gamify – Injector (top-right fixed, robust open)
 * - 右上固定の「設定」ボタン（1個だけ）
 * - クリックでモーダル表示（iframe）
 * - iframe が X-Frame-Options/CSP でブロックされたら、別タブで自動オープン + ガイダンス表示
 * - BaseURL: UI保存 > ?base > 既定
 */
(function () {
  if (window.__SG_INJECTED__) return;            // 多重注入ガード
  window.__SG_INJECTED__ = true;

  const BTN_ID    = 'sg-settings-btn';
  const MODAL_ID  = 'sg-console-modal';
  const IFRAME_ID = 'sg-console-iframe';

  // ---------- BaseURL ----------
  function getSavedBase() {
    try {
      const v = localStorage.getItem('gamify_base_url');
      if (v && /^https?:\/\//.test(v)) return v.trim();
    } catch {}
    return '';
  }
  function getParamBase() {
    try {
      const self = document.currentScript || document.querySelector('script[src*="injector.js"]');
      const u = new URL(self ? self.src : location.href);
      const q = u.searchParams.get('base');
      if (q && /^https?:\/\//.test(q)) return q.trim();
    } catch {}
    return '';
  }
  const DEFAULT_BASE = 'https://sales-gamify.onrender.com';
  const BASE_URL = getSavedBase() || getParamBase() || DEFAULT_BASE;

  // ---------- utils ----------
  const doc = document;
  const $ = (id) => doc.getElementById(id);

  // ---------- 右上固定ボタン ----------
  function ensureButton() {
    let b = $(BTN_ID);
    if (b) return b;

    b = doc.createElement('button');
    b.id = BTN_ID;
    b.textContent = '設定';
    Object.assign(b.style, {
      position: 'fixed',
      top: '12px',           // ★右上固定
      right: '16px',
      zIndex: 2147483647,
      padding: '8px 12px',
      border: 'none',
      borderRadius: '12px',
      boxShadow: '0 6px 18px rgba(0,0,0,.20)',
      background: '#6c5ce7',
      color: '#fff',
      fontSize: '13px',
      lineHeight: '1',
      cursor: 'pointer'
    });
    b.addEventListener('click', openConsole, { passive: true });
    (doc.body || doc.documentElement).appendChild(b);
    return b;
  }

  // ---------- モーダル ----------
  function openConsole() {
    // 既に開いてたら前面へ
    const ex = $(MODAL_ID);
    if (ex) { ex.style.display = 'block'; ex.focus?.(); return; }

    const overlay = doc.createElement('div');
    overlay.id = MODAL_ID;
    Object.assign(overlay.style, {
      position: 'fixed',
      inset: '0',
      background: 'rgba(0,0,0,.35)',
      zIndex: 2147483647,
      display: 'block'
    });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeConsole(); });

    const shell = doc.createElement('div');
    Object.assign(shell.style, {
      position: 'absolute',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      width: 'min(960px, 94vw)',
      height: 'min(680px, 92vh)',
      background: '#fff',
      borderRadius: '16px',
      boxShadow: '0 24px 60px rgba(0,0,0,.35)',
      overflow: 'hidden'
    });

    const close = doc.createElement('button');
    close.textContent = '×';
    Object.assign(close.style, {
      position: 'absolute',
      right: '10px',
      top: '6px',
      width: '32px',
      height: '32px',
      border: 'none',
      background: 'transparent',
      fontSize: '20px',
      cursor: 'pointer',
      zIndex: 2
    });
    close.addEventListener('click', closeConsole);

    const iframe = doc.createElement('iframe');
    iframe.id = IFRAME_ID;
    iframe.src = `${BASE_URL}/admin/console?embed=1`;
    iframe.setAttribute('allow', 'clipboard-read; clipboard-write');
    Object.assign(iframe.style, {
      border: '0',
      width: '100%',
      height: '100%',
      background: '#fff'
    });

    // --- iframe ブロック検知 & フォールバック ---
    let fallbackShown = false;
    const showFallback = () => {
      if (fallbackShown) return;
      fallbackShown = true;
      // ガイダンス + 自動で別タブ
      const msg = doc.createElement('div');
      msg.innerHTML = 'ページのポリシーにより埋め込みできませんでした。<a target="_blank" rel="noopener" href="'+iframe.src+'">別タブで開く</a> をクリックしてください。';
      Object.assign(msg.style, {
        position: 'absolute',
        left: '16px',
        right: '16px',
        top: '48px',
        color: '#333',
        fontSize: '14px'
      });
      shell.appendChild(msg);
      // 自動で別タブ（ポップアップブロック回避のため遅延）
      setTimeout(() => { try { window.open(iframe.src, '_blank', 'noopener'); } catch {} }, 150);
    };

    // X-Frame-Options / frame-ancestors によるブロックは onload が来ないことが多い
    const t = setTimeout(showFallback, 2000);
    iframe.addEventListener('load', () => { clearTimeout(t); });

    shell.appendChild(close);
    shell.appendChild(iframe);
    overlay.appendChild(shell);
    (doc.body || doc.documentElement).appendChild(overlay);
  }

  function closeConsole() {
    const m = $(MODAL_ID);
    if (m) m.remove();
  }

  // 初回
  ensureButton();
})();
