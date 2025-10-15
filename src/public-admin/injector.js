/* Sales Gamify – Injector (robust, idempotent)
 * - 1回だけ注入（多重生成ガード）
 * - 右下フローティング「設定」ボタン（常に <body> に付与）
 * - クリックでモーダル（overlay+shell+iframe）を開く
 * - 既に開いていれば前面へ。閉じたら破棄
 * - BaseURL は「UI保存 > クエリ ?base > 既定」の優先順
 */

(function () {
  if (window.__SG_INJECTED__) return;           // 多重注入ガード
  window.__SG_INJECTED__ = true;

  const BTN_ID    = 'sg-settings-btn';
  const MODAL_ID  = 'sg-console-modal';
  const IFRAME_ID = 'sg-console-iframe';

  // --------- Base URL 決定 ----------
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

  // --------- 既存DOMの再利用 ----------
  const doc = document;
  function byId(id) { return doc.getElementById(id); }

  // --------- ボタン生成（必ず <body> 直下に） ----------
  function ensureButton() {
    let btn = byId(BTN_ID);
    if (btn) return btn;

    btn = doc.createElement('button');
    btn.id = BTN_ID;
    btn.textContent = '設定';
    Object.assign(btn.style, {
      position: 'fixed',
      right: '24px',
      bottom: '120px',
      zIndex: 2147483647,
      padding: '10px 14px',
      border: 'none',
      borderRadius: '12px',
      boxShadow: '0 6px 18px rgba(0,0,0,.25)',
      background: '#6c5ce7',
      color: '#fff',
      fontSize: '14px',
      cursor: 'pointer'
    });
    btn.addEventListener('click', openConsole, false);
    (doc.body || doc.documentElement).appendChild(btn);
    return btn;
  }

  // --------- モーダル生成 ----------
  function openConsole() {
    // 既にあれば前面に
    const exists = byId(MODAL_ID);
    if (exists) {
      exists.style.display = 'block';
      exists.focus?.();
      return;
    }

    const overlay = doc.createElement('div');
    overlay.id = MODAL_ID;
    Object.assign(overlay.style, {
      position: 'fixed',
      inset: '0',
      background: 'rgba(0,0,0,.35)',
      zIndex: 2147483647,
      display: 'block'
    });
    overlay.addEventListener('click', (e) => {
      // 背景クリックで閉じる（中クリックは無視）
      if (e.target === overlay) closeConsole();
    });

    const shell = doc.createElement('div');
    Object.assign(shell.style, {
      position: 'absolute',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      width: 'min(940px, 94vw)',
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
      zIndex: 2,
    });
    close.addEventListener('click', closeConsole, false);

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

    // ロード失敗時は案内を表示
    const tm = setTimeout(() => {
      if (!iframe.contentWindow) {
        const msg = doc.createElement('div');
        msg.textContent = '読み込みに時間がかかっています… うまく開かない場合は別タブで開いてください。';
        Object.assign(msg.style, {
          position: 'absolute', inset: '48px 12px auto 12px', color: '#333', fontSize: '13px'
        });
        const a = doc.createElement('a');
        a.href = iframe.src;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = '別タブで開く';
        a.style.marginLeft = '8px';
        msg.appendChild(a);
        shell.appendChild(msg);
      }
    }, 2500);
    iframe.addEventListener('load', () => clearTimeout(tm));

    shell.appendChild(close);
    shell.appendChild(iframe);
    overlay.appendChild(shell);
    (doc.body || doc.documentElement).appendChild(overlay);
  }

  function closeConsole() {
    const m = byId(MODAL_ID);
    if (m) m.remove();
  }

  // 初回ボタン設置
  ensureButton();
})();
