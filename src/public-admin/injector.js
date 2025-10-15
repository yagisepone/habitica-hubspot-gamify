/* Sales Gamify – Habitica header native button injector
 * - Habiticaのヘッダー右上アイコン列に“歯車アイコン”を一個だけ追加（非固定・非被り）
 * - SPA遷移でも自動復活（MutationObserver）
 * - クリックで埋め込みモーダル。ブロック時は自動で別タブ
 * - BaseURL: UI保存 > ?base > 既定
 */
(function () {
  if (window.__SG_INJECTED__) return;
  window.__SG_INJECTED__ = true;

  const BTN_ID    = 'sg-header-gear';
  const MODAL_ID  = 'sg-console-modal';
  const IFRAME_ID = 'sg-console-iframe';
  const DEFAULT_BASE = 'https://sales-gamify.onrender.com';

  // ---------- BaseURL ----------
  const getSavedBase = () => {
    try {
      const v = localStorage.getItem('gamify_base_url');
      if (v && /^https?:\/\//.test(v)) return v.trim();
    } catch {}
    return '';
  };
  const getParamBase = () => {
    try {
      const self = document.currentScript || document.querySelector('script[src*="injector.js"]');
      const u = new URL(self ? self.src : location.href);
      const q = u.searchParams.get('base');
      if (q && /^https?:\/\//.test(q)) return q.trim();
    } catch {}
    return '';
  };
  const BASE_URL = getSavedBase() || getParamBase() || DEFAULT_BASE;

  // ---------- DOM utils ----------
  const $id = (id) => document.getElementById(id);

  // Habitica のヘッダー右上“アイコン群”を推定して返す
  const findHeaderActions = () => {
    // できるだけ狭い→広い順に探索
    const candidates = [
      // 新UI/旧UIでよくあるパターン
      '.header .actions, .header-actions',
      '.navbar .navbar-right, .nav .navbar-right',
      '[class*="Header"] [class*="actions"]',
      '#app header [class*="right"]',
      'header [class*="icon"], header [class*="actions"]',
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && el.querySelector('svg, button, a, span')) return el;
    }
    // 最後の保険（ヘッダー全体）
    return document.querySelector('header') || null;
  };

  // ヘッダーに歯車ボタンを“溶け込む形で”追加
  const ensureHeaderGear = () => {
    if ($id(BTN_ID)) return true;
    const container = findHeaderActions();
    if (!container) return false;

    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.title = 'Sales Gamify 設定';
    btn.setAttribute('aria-label', 'Sales Gamify 設定');

    // 見た目は既存の丸アイコンに寄せる（継承 + 最小限の上書き）
    Object.assign(btn.style, {
      all: 'unset',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '32px',
      height: '32px',
      marginLeft: '8px',
      borderRadius: '50%',
      cursor: 'pointer',
      color: 'inherit',              // 既存色を継承
    });
    btn.onmouseover = () => (btn.style.background = 'rgba(0,0,0,.07)');
    btn.onmouseout  = () => (btn.style.background = 'transparent');

    // 歯車SVG（小さめ）
    btn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm9.94 3.06-.98-.28a8 8 0 0 0-.7-1.69l.6-.82a1 1 0 0 0-.12-1.28l-1.57-1.57a1 1 0 0 0-1.28-.12l-.82.6a8 8 0 0 0-1.69-.7l-.28-.98A1 1 0 0 0 12 2h-2a1 1 0 0 0-.96.72l-.28.98a8 8 0 0 0-1.69.7l-.82-.6a1 1 0 0 0-1.28.12L2.4 6.49a1 1 0 0 0-.12 1.28l.6.82a8 8 0 0 0-.7 1.69l-.98.28A1 1 0 0 0 1 12v2c0 .46.31.86.76.98l.98.28c.15.58.38 1.14.7 1.69l-.6.82a1 1 0 0 0 .12 1.28l1.57 1.57a1 1 0 0 0 1.28.12l.82-.6c.55.32 1.11.55 1.69.7l.28.98c.12.45.52.76.98.76h2c.46 0 .86-.31.98-.76l.28-.98c.58-.15 1.14-.38 1.69-.7l.82.6a1 1 0 0 0 1.28-.12l1.57-1.57a1 1 0 0 0 .12-1.28l-.6-.82c.32-.55.55-1.11.7-1.69l.98-.28c.45-.12.76-.52.76-.98v-2c0-.46-.31-.86-.76-.98Z"/>
      </svg>
    `;

    btn.addEventListener('click', openConsole, { passive: true });

    // 右端に自然に並ぶよう最後に追加
    container.appendChild(btn);
    return true;
  };

  // モーダル（iframe）を開く。ブロック時は自動で別タブ
  function openConsole() {
    const exist = $id(MODAL_ID);
    if (exist) { exist.style.display = 'block'; exist.focus?.(); return; }

    const overlay = document.createElement('div');
    overlay.id = MODAL_ID;
    Object.assign(overlay.style, {
      position: 'fixed',
      inset: '0',
      background: 'rgba(0,0,0,.35)',
      zIndex: 2147483647,
      display: 'block'
    });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeConsole(); });

    const shell = document.createElement('div');
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

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    Object.assign(closeBtn.style, {
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
    closeBtn.addEventListener('click', closeConsole);

    const iframe = document.createElement('iframe');
    iframe.id = IFRAME_ID;
    iframe.src = `${BASE_URL}/admin/console?embed=1`;
    iframe.setAttribute('allow', 'clipboard-read; clipboard-write');
    Object.assign(iframe.style, {
      border: '0',
      width: '100%',
      height: '100%',
      background: '#fff'
    });

    let fallbackShown = false;
    const showFallback = () => {
      if (fallbackShown) return;
      fallbackShown = true;
      const msg = document.createElement('div');
      msg.innerHTML =
        '埋め込みがブロックされたため、<a target="_blank" rel="noopener" href="' +
        iframe.src +
        '">別タブ</a>で開きます。';
      Object.assign(msg.style, {
        position: 'absolute',
        left: '16px',
        right: '16px',
        top: '48px',
        color: '#333',
        fontSize: '14px'
      });
      shell.appendChild(msg);
      setTimeout(() => { try { window.open(iframe.src, '_blank', 'noopener'); } catch {} }, 120);
    };
    const t = setTimeout(showFallback, 2000);
    iframe.addEventListener('load', () => { clearTimeout(t); });

    shell.appendChild(closeBtn);
    shell.appendChild(iframe);
    overlay.appendChild(shell);
    (document.body || document.documentElement).appendChild(overlay);
  }

  function closeConsole() {
    const m = $id(MODAL_ID);
    if (m) m.remove();
  }

  // 初回 & SPA復活
  const tryMount = () => { ensureHeaderGear(); };
  tryMount();

  // SPAでヘッダーが差し替わっても復活
  const obs = new MutationObserver(() => {
    if (!$id(BTN_ID)) tryMount();
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
})();
