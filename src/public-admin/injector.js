(function () {
  const BTN_ID = 'gamify-settings-btn';
  if (document.getElementById(BTN_ID)) return;

  // 1) BaseURL の決定（UI保存 > クエリ > 既定）
  function getSavedBase() {
    try {
      const raw = localStorage.getItem('gamify_base_url');
      if (raw && /^https?:\/\//.test(raw)) return raw.trim();
    } catch {}
    return '';
  }
  const scriptEl = document.currentScript || (function(){
    const s = document.getElementsByTagName('script'); return s[s.length-1];
  })();
  const u = new URL(scriptEl.src);
  const baseFromQuery = u.searchParams.get('base') || '';
  const baseURL = getSavedBase() || baseFromQuery || 'https://sales-gamify.onrender.com';

  // 2) フローティング設定ボタン
  const btn = document.createElement('button');
  btn.id = BTN_ID; btn.type = 'button'; btn.textContent = '設定';
  Object.assign(btn.style, {
    position: 'fixed', right: '24px', bottom: '120px',
    padding: '10px 14px', fontSize: '14px', lineHeight: '1',
    border: 'none', borderRadius: '12px', boxShadow: '0 6px 18px rgba(0,0,0,.25)',
    background: '#6c5ce7', color: '#fff', cursor: 'pointer',
    zIndex: '2147483647', userSelect: 'none', opacity: '0.95',
    transition: 'opacity .2s ease'
  });
  btn.onmouseenter = () => (btn.style.opacity = '1');
  btn.onmouseleave = () => (btn.style.opacity = '0.95');

  // 3) 開く処理（堅牢）
  function openConsoleHard() {
    if (typeof window.openSalesGamifyConsole === 'function') return window.openSalesGamifyConsole();
    if (typeof window.SalesGamifyConsole === 'function') return window.SalesGamifyConsole();
    window.dispatchEvent(new CustomEvent('open-sales-gamify-console'));
    if (!document.getElementById('gamify-console-iframe')) {
      const overlay = document.createElement('div');
      Object.assign(overlay.style, { position: 'fixed', inset: '0', background: 'rgba(0,0,0,.35)', zIndex: '2147483647' });
      overlay.id = 'gamify-console-overlay';
      const wrap = document.createElement('div');
      Object.assign(wrap.style, {
        position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
        width: 'min(900px,92vw)', height: 'min(640px,86vh)',
        background: '#fff', borderRadius: '16px', boxShadow: '0 24px 60px rgba(0,0,0,.35)', overflow: 'hidden'
      });
      const close = document.createElement('button');
      close.textContent = '×';
      Object.assign(close.style, {
        position: 'absolute', right: '10px', top: '6px', width: '32px', height: '32px',
        border: 'none', background: 'transparent', fontSize: '20px', cursor: 'pointer', zIndex: 2
      });
      close.onclick = () => overlay.remove();
      const iframe = document.createElement('iframe');
      iframe.id = 'gamify-console-iframe';
      iframe.src = `${baseURL}/admin/console?embed=1`;
      iframe.style.border = '0'; iframe.style.width = '100%'; iframe.style.height = '100%';
      wrap.appendChild(close); wrap.appendChild(iframe); overlay.appendChild(wrap);
      document.body.appendChild(overlay);
    }
  }

  // 4) ドラッグ/スナップ/保存
  const LS_KEY = 'gamify_settings_btn_pos_v2';
  const safeMargins = { top: 72, right: 24, bottom: 120, left: 24 };
  const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
  function applyPos(x, y) { btn.style.left = x+'px'; btn.style.top = y+'px'; btn.style.right = 'auto'; btn.style.bottom = 'auto'; }
  function savePos(x, y) { try { localStorage.setItem(LS_KEY, JSON.stringify({ x, y })); } catch {} }
  function loadPos() { try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch { return null; } }
  function initialPlace() {
    const saved = loadPos(); requestAnimationFrame(() => {
      const vw = innerWidth, vh = innerHeight;
      const x = saved ? clamp(saved.x, safeMargins.left, vw - safeMargins.right - btn.offsetWidth)
                      : vw - safeMargins.right - btn.offsetWidth;
      const y = saved ? clamp(saved.y, safeMargins.top, vh - safeMargins.bottom - btn.offsetHeight)
                      : vh - safeMargins.bottom - btn.offsetHeight;
      applyPos(x, y); savePos(x, y);
    });
  }
  let dragging=false, startX=0, startY=0, baseX=0, baseY=0, downAt=0;
  const CLICK_DIST=6, CLICK_TIME=250;
  function pointerDown(e){const r=btn.getBoundingClientRect();baseX=r.left;baseY=r.top;
    startX=(e.touches?e.touches[0].clientX:e.clientX); startY=(e.touches?e.touches[0].clientY:e.clientY);
    downAt=Date.now(); dragging=true;
    document.addEventListener('pointermove',pointerMove);
    document.addEventListener('pointerup',pointerUp,{once:true});
    document.addEventListener('touchmove',pointerMove,{passive:false});
    document.addEventListener('touchend',pointerUp,{once:true});
  }
  function pointerMove(e){ if(!dragging) return; e.preventDefault?.();
    const cx=(e.touches?e.touches[0].clientX:e.clientX), cy=(e.touches?e.touches[0].clientY:e.clientY);
    const vx=baseX+(cx-startX), vy=baseY+(cy-startY);
    const x=clamp(vx, safeMargins.left, innerWidth - safeMargins.right - btn.offsetWidth);
    const y=clamp(vy, safeMargins.top,  innerHeight - safeMargins.bottom - btn.offsetHeight);
    applyPos(x,y);
  }
  function pointerUp(e){
    const cx=(e.changedTouches?e.changedTouches[0].clientX:e.clientX), cy=(e.changedTouches?e.changedTouches[0].clientY:e.clientY);
    const dist=Math.hypot(cx-startX, cy-startY), time=Date.now()-downAt;
    dragging=false; document.removeEventListener('pointermove',pointerMove); document.removeEventListener('touchmove',pointerMove);
    if(dist<CLICK_DIST && time<CLICK_TIME){ openConsoleHard(); return; }
    const rect=btn.getBoundingClientRect(); const vw=innerWidth, vh=innerHeight;
    const distLeft=rect.left-safeMargins.left, distRight=vw-safeMargins.right-rect.right;
    const distTop=rect.top-safeMargins.top, distBottom=vh-safeMargins.bottom-rect.bottom;
    const snapLeft=distLeft<=distRight, snapTop=distTop<=distBottom;
    const x=snapLeft ? safeMargins.left : vw - safeMargins.right - rect.width;
    const y=snapTop  ? safeMargins.top  : vh - safeMargins.bottom - rect.height;
    applyPos(x,y); savePos(x,y);
  }
  btn.addEventListener('pointerdown',pointerDown);
  btn.addEventListener('touchstart',pointerDown,{passive:true});
  window.addEventListener('resize',()=>{const r=btn.getBoundingClientRect();
    const x=clamp(r.left, safeMargins.left, innerWidth - safeMargins.right - r.width);
    const y=clamp(r.top,  safeMargins.top,  innerHeight - safeMargins.bottom - r.height);
    applyPos(x,y); savePos(x,y);
  });
  (document.body||document.documentElement).appendChild(btn);
  initialPlace();
})();
