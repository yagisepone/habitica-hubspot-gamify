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
  const DEFAULT_BASE = "https://sales-gamify.onrender.com"; // TODO: wire env var override (SGC_DEFAULT_BASE)
  const POSITION_KEY = 'sgc.settings.position';

  const normalizePos = (pos) => {
    const top = Math.max(0, Math.round(Number(pos?.top ?? 120)));
    const left = Math.max(0, Math.round(Number(pos?.left ?? 18)));
    return { top, left };
  };
  const loadPosition = () => {
    try {
      const raw = localStorage.getItem(POSITION_KEY);
      if (!raw) return { top: 120, left: 18 };
      const parsed = JSON.parse(raw);
      return normalizePos(parsed);
    } catch {
      return { top: 120, left: 18 };
    }
  };
  const persistPosition = (pos, broadcast = true) => {
    const normalized = normalizePos(pos);
    localStorage.setItem(POSITION_KEY, JSON.stringify(normalized));
    if (broadcast) {
      try {
        window.top?.postMessage({ type: 'sgc.updateGearPosition', position: normalized }, '*');
      } catch {}
    }
    return normalized;
  };
  let gearPosition = loadPosition();

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

  window.addEventListener('message', (event) => {
    try {
      const data = event?.data;
      if (data && data.type === 'sgc.updateGearPosition' && data.position) {
        const saved = persistPosition(data.position, false);
        const btn = $id(BTN_ID);
        if (btn) applyGearPosition(btn, saved);
      }
    } catch {}
  });

  const applyGearPosition = (btn, pos) => {
    const target = normalizePos(pos || gearPosition);
    gearPosition = target;
    Object.assign(btn.style, {
      position: 'fixed',
      top: `${target.top}px`,
      left: `${target.left}px`,
      right: 'auto',
      bottom: 'auto',
      marginLeft: '0',
      zIndex: 2147483645,
    });
  };

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
    const mountTarget = document.body || findHeaderActions() || document.documentElement;
    if (!mountTarget) return false;

    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.title = 'Sales Gamify 設定 (Shift+ドラッグで移動)';
    btn.setAttribute('aria-label', 'Sales Gamify 設定');

    // 見た目は既存の丸アイコンに寄せる（継承 + 最小限の上書き）
    Object.assign(btn.style, {
      all: 'unset',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '32px',
      height: '32px',
      borderRadius: '50%',
      cursor: 'pointer',
      color: 'inherit',              // 既存色を継承
      boxShadow: '0 6px 18px rgba(0,0,0,.25)',
      background: 'rgba(34,34,34,0.85)',
      color: '#fff',
    });
    btn.onmouseover = () => (btn.style.background = 'rgba(34,34,34,0.9)');
    btn.onmouseout  = () => (btn.style.background = 'rgba(34,34,34,0.85)');

    // 歯車SVG（小さめ）
    btn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm9.94 3.06-.98-.28a8 8 0 0 0-.7-1.69l.6-.82a1 1 0 0 0-.12-1.28l-1.57-1.57a1 1 0 0 0-1.28-.12l-.82.6a8 8 0 0 0-1.69-.7l-.28-.98A1 1 0 0 0 12 2h-2a1 1 0 0 0-.96.72l-.28.98a8 8 0 0 0-1.69.7l-.82-.6a1 1 0 0 0-1.28.12L2.4 6.49a1 1 0 0 0-.12 1.28l.6.82a8 8 0 0 0-.7 1.69l-.98.28A1 1 0 0 0 1 12v2c0 .46.31.86.76.98l.98.28c.15.58.38 1.14.7 1.69l-.6.82a1 1 0 0 0 .12 1.28l1.57 1.57a1 1 0 0 0 1.28.12l.82-.6c.55.32 1.11.55 1.69.7l.28.98c.12.45.52.76.98.76h2c.46 0 .86-.31.98-.76l.28-.98c.58-.15 1.14-.38 1.69-.7l.82.6a1 1 0 0 0 1.28-.12l1.57-1.57a1 1 0 0 0 .12-1.28l-.6-.82c.32-.55.55-1.11.7-1.69l.98-.28c.45-.12.76-.52.76-.98v-2c0-.46-.31-.86-.76-.98Z"/>
      </svg>
    `;

    let movedWhileDragging = false;

    btn.addEventListener('click', (event) => {
      if (event.shiftKey || movedWhileDragging) {
        event.preventDefault();
        movedWhileDragging = false;
        return;
      }
      openConsole();
    });

    let dragging = false;
    let pointerId = null;
    let offset = { x: 0, y: 0 };

    btn.addEventListener('pointerdown', (event) => {
      if (!event.shiftKey) return;
      event.preventDefault();
      dragging = true;
      pointerId = event.pointerId;
      const rect = btn.getBoundingClientRect();
      offset = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      btn.setPointerCapture(pointerId);
      btn.style.transition = 'none';
      movedWhileDragging = false;
    });

    btn.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      const next = {
        top: event.clientY - offset.y,
        left: event.clientX - offset.x,
      };
      applyGearPosition(btn, next);
      movedWhileDragging = true;
    });

    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      btn.style.transition = '';
      const saved = persistPosition(gearPosition);
      applyGearPosition(btn, saved);
      if (pointerId != null) {
        try { btn.releasePointerCapture(pointerId); } catch {}
        pointerId = null;
      }
    };

    btn.addEventListener('pointerup', endDrag);
    btn.addEventListener('pointercancel', endDrag);

    mountTarget.appendChild(btn);
    applyGearPosition(btn, gearPosition);
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
      position:'absolute', right:'10px', top:'6px', width:'32px', height:'32px',
      border:'0', background:'transparent', fontSize:'20px', cursor:'pointer', zIndex:2
    });
    closeBtn.addEventListener('click', closeConsole);

    shell.appendChild(closeBtn);
    overlay.appendChild(shell);
    (document.body || document.documentElement).appendChild(overlay);

    function inlineEmbed() {
      try {
        shell.innerHTML = '';
        shell.appendChild(closeBtn);
        const holder = document.createElement('div');
        Object.assign(holder.style, { width:'100%', height:'100%', overflow:'auto', background:'#fff' });
        shell.appendChild(holder);
        fetch(`${BASE_URL}/admin/console?embed=1`, { credentials: 'omit' })
          .then(r => r.text())
          .then(html => {
            holder.innerHTML = html;
            holder.querySelectorAll('script').forEach(old => {
              const s = document.createElement('script');
              [...old.attributes].forEach(a => s.setAttribute(a.name, a.value));
              if (old.textContent) s.textContent = old.textContent;
              old.replaceWith(s);
            });
          })
          .catch(() => window.open(`${BASE_URL}/admin/console?embed=1`, '_blank', 'noopener'));
      } catch {
        window.open(`${BASE_URL}/admin/console?embed=1`, '_blank', 'noopener');
      }
    }

    function iframeEmbed() {
      const iframe = document.createElement('iframe');
      iframe.id = IFRAME_ID;
      iframe.src = `${BASE_URL}/admin/console?embed=1`;
      iframe.setAttribute('allow', 'clipboard-read; clipboard-write');
      iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
      Object.assign(iframe.style, { border:'0', width:'100%', height:'100%', background:'#fff' });
      shell.appendChild(iframe);
      let done = false;
      const t = setTimeout(() => { if (!done) inlineEmbed(); }, 1200);
      iframe.addEventListener('load', () => { done = true; clearTimeout(t); });
      window.addEventListener('message', (e) => {
        if (e?.data === 'sgc-ready') { done = true; clearTimeout(t); }
      }, { once:false });
    }

    iframeEmbed();
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
