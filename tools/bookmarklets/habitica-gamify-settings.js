(() => {
  const D = document, W = window, KEY='sgc.profile.v3', POS='sgb.pos', NS='sgb', READY='sgc-ready';
  let p={}; try{ p=JSON.parse(localStorage.getItem(KEY)||'{}')||{} }catch(_){ }
  if(!p.baseUrl){
    const b = prompt('Base URL（例 https://sales-gamify.onrender.com）','https://sales-gamify.onrender.com');
    if(!b) return; p.baseUrl = b.replace(/\/+$/,''); localStorage.setItem(KEY, JSON.stringify(p));
  }
  const q = new URLSearchParams(); if(p.tenant) q.set('tenant',p.tenant); if(p.token) q.set('token',p.token); q.set('base',p.baseUrl);
  const URL_BASE=p.baseUrl, URL_CON=p.baseUrl+'/admin/console?embed=1#'+q.toString();

  const css = `#${NS}-gear{position:fixed;top:74px;right:12px;width:42px;height:42px;border-radius:999px;background:#6c5ce7;color:#fff;z-index:2147483601;display:flex;align-items:center;justify-content:center;font:700 16px/42px system-ui;box-shadow:0 10px 28px rgba(0,0,0,.25);cursor:pointer}
  #${NS}-mask{position:fixed;inset:0;background:rgba(0,0,0,.35);backdrop-filter:blur(1px);z-index:2147483600;display:none}
  #${NS}-panel{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:min(1100px,95vw);height:min(85vh,95vh);background:#fff;border-radius:12px;box-shadow:0 24px 64px rgba(0,0,0,.35);z-index:2147483601;display:none;overflow:hidden;display:flex;flex-direction:column}
  #${NS}-hd{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid #eee;background:#fafafa;font:600 14px system-ui}
  #${NS}-frm{border:0;width:100%;height:100%}
  #${NS}-x,#${NS}-open{border:1px solid #e3e3ef;background:#fff;border-radius:8px;padding:6px 10px;cursor:pointer}`;
  const sty=D.createElement('style'); sty.textContent=css; (D.head||D.documentElement).appendChild(sty);

  const g=D.createElement('div'); g.id=NS+'-gear'; g.textContent='⚙️'; (D.body||D.documentElement).appendChild(g);
  function loadPos(){ try{ return JSON.parse(localStorage.getItem(POS)||'{}') }catch(_){ return {} } }
  const pos=loadPos(); if(pos.top!=null) g.style.top=pos.top+'px'; if(pos.right!=null){g.style.right=pos.right+'px';g.style.left='auto'} if(pos.left!=null){g.style.left=pos.left+'px';g.style.right='auto'}
  let drag=null; g.addEventListener('mousedown',e=>{ if(!e.shiftKey) return; const cs=W.getComputedStyle(g); drag={sx:e.clientX,sy:e.clientY,t:parseInt(cs.top)||74,l:parseInt(cs.left)||NaN,r:parseInt(cs.right)||12}; e.preventDefault(); });
  W.addEventListener('mousemove',e=>{ if(!drag) return; if(!isNaN(drag.l)){ g.style.left=(drag.l+e.clientX-drag.sx)+'px'; g.style.right='auto'; } else { g.style.right=(drag.r-(e.clientX-drag.sx))+'px'; g.style.left='auto'; } g.style.top=(drag.t+e.clientY-drag.sy)+'px'; });
  W.addEventListener('mouseup',()=>{ if(!drag) return; const save={top:parseInt(g.style.top)||74}; if(g.style.left){ save.left=parseInt(g.style.left)||0 } else { save.right=parseInt(g.style.right)||12 } localStorage.setItem(POS,JSON.stringify(save)); drag=null; });

  const mask=D.createElement('div'); mask.id=NS+'-mask';
  const panel=D.createElement('div'); panel.id=NS+'-panel';
  panel.innerHTML='<div id="'+NS+'-hd"><div>Sales Gamify Console</div><div><button id="'+NS+'-open">別タブ</button> <button id="'+NS+'-x">閉じる</button></div></div>';
  const shell=D.createElement('div'); shell.style.cssText='position:relative;flex:1 1 auto;background:#fff;';
  (D.body||D.documentElement).appendChild(mask); (D.body||D.documentElement).appendChild(panel); panel.appendChild(shell);

  function injectScripts(root){ root.querySelectorAll('script').forEach(old=>{ const sc=D.createElement('script'); [...old.attributes].forEach(a=>sc.setAttribute(a.name,a.value)); if(old.textContent) sc.textContent=old.textContent; old.replaceWith(sc); }); }
  function inlineEmbed(){ try{ shell.innerHTML=''; panel.style.display='flex'; mask.style.display='block'; fetch(URL_BASE+'/admin/console?embed=1',{credentials:'omit'}).then(r=>r.text()).then(html=>{ shell.innerHTML=html; injectScripts(shell); }).catch(()=>{ window.open(URL_CON,'_blank','noopener'); }); } catch(_) { window.open(URL_CON,'_blank','noopener'); } }
  function iframeEmbed(){ shell.innerHTML='<iframe id="'+NS+'-frm" allow="clipboard-read; clipboard-write" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" style="border:0;width:100%;height:100%;background:#fff"></iframe>'; const f=shell.firstChild; let done=false; const t=setTimeout(()=>{ if(!done) inlineEmbed(); },1200); f.addEventListener('load',()=>{ done=true; clearTimeout(t); },{once:true}); try{ window.addEventListener('message',ev=>{ if(ev&&ev.data===READY){ done=true; clearTimeout(t); } },{once:false}); }catch(_){ }
    f.src=URL_CON;
  }
  function open(){ mask.style.display='block'; panel.style.display='flex'; iframeEmbed(); }
  g.onclick=open;
  panel.querySelector('#'+NS+'-x')?.addEventListener('click',()=>{ mask.style.display='none'; panel.style.display='none'; });
  panel.querySelector('#'+NS+'-open')?.addEventListener('click',()=>{ window.open(URL_CON,'_blank','noopener'); });
})();
