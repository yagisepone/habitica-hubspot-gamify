// injector.js (modal版・仕上げ)
// - ⚙️を「パーティーを見る」の真下に固定（見つからなければ右上フォールバック）
// - オーバーレイはモーダル（元のサイズ/位置のまま）。中身は余白ゼロで拡大（console.html側）
// - ✖は“内側”に設置するため、postMessage('sgc:close') を受け取って閉じる
// - 💎トグルは⚙️の直下で追従

(function(){
  const KEY="sgc.profile.v3";
  const zTop=2147483600;

  // 初期プロファイル（未設定時のみ）
  try{
    const cur=JSON.parse(localStorage.getItem(KEY)||"null");
    if(!cur||!cur.baseUrl||!cur.tenant||!cur.token){
      localStorage.setItem(KEY,JSON.stringify({
        baseUrl:"https://sales-gamify.onrender.com",
        tenant:"ワビサビ株式会社",
        token:"wabisabi-habitica-hubspot-connection",
      }));
    }
  }catch{}
  const p=JSON.parse(localStorage.getItem(KEY)||"{}");

  // ---------- Overlay（モーダル枠は従来サイズ、内容はconsole側でフル拡大） ----------
  function consoleUrl(){
    const qs=new URLSearchParams({
      tenant:String(p.tenant||""), token:String(p.token||""), base:String(p.baseUrl||""),
      overlay:"1", mode:"modal"
    });
    return String(p.baseUrl||"")+"/admin/console/#"+qs.toString();
  }

  let msgHandler;
  function openOverlay(){
    closeOverlay();
    const mask=document.createElement("div");
    mask.id="sgc-overlay";
    mask.style.cssText=`position:fixed;inset:0;background:rgba(0,0,0,.28);z-index:${zTop}`;

    const fr=document.createElement("iframe");
    fr.src=consoleUrl();
    fr.allow="clipboard-read; clipboard-write";
    fr.style.cssText=[
      "position:absolute","top:60px","left:50%","transform:translateX(-50%)",
      "width:min(1120px,94vw)","height:86vh",
      "border:0","border-radius:14px","background:#fff",
      "box-shadow:0 24px 48px rgba(0,0,0,.25)"
    ].join(";");

    mask.appendChild(fr);
    document.body.appendChild(mask);

    msgHandler=(e)=>{
      if(e && e.data && (e.data.sgc==="close"||e.data==="sgc:close")){
        closeOverlay();
      }
    };
    window.addEventListener("message",msgHandler);
  }
  function closeOverlay(){
    const m=document.getElementById("sgc-overlay");
    if(m){ m.remove(); }
    if(msgHandler){ window.removeEventListener("message",msgHandler); msgHandler=null; }
  }
  function toggleOverlay(){ const e=document.getElementById("sgc-overlay"); e?closeOverlay():openOverlay(); }

  // ---------- ⚙️生成 & 「パーティーを見る」下に固定 ----------
  function ensureGear(){
    if(document.getElementById("sgc-gear")) return;
    const gear=document.createElement("button");
    gear.id="sgc-gear"; gear.setAttribute("aria-label","Sales Gamify Console"); gear.textContent="⚙️";
    gear.style.cssText=[
      "position:fixed","top:16px","right:16px",`z-index:${zTop+1}`,
      "width:40px","height:40px","border-radius:20px","background:#6c5ce7","color:#fff","border:none",
      "box-shadow:0 6px 18px rgba(0,0,0,.25)","font-size:18px","line-height:40px","text-align:center",
      "cursor:pointer","user-select:none","opacity:.96"
    ].join(";");
    gear.onmouseenter=()=>gear.style.opacity="1";
    gear.onmouseleave=()=>gear.style.opacity=".96";
    gear.onclick=toggleOverlay;
    document.body.appendChild(gear);

    if(!placeGearUnderParty()) placeGearSafely();
    positionGemToggleNearGear();
  }
  function findPartyButton(){
    const nodes=document.querySelectorAll('a,button,[role="button"],.btn,[class*="Button"],[class*="button"]');
    const keys=["パーティーを見る","パーティー","パーティ","Party","View Party"];
    let best=null,bestArea=0;
    nodes.forEach(el=>{
      const r=el.getBoundingClientRect(); if(!r||!r.width||!r.height) return;
      const t=(el.textContent||"").replace(/\s+/g,"").trim();
      if(keys.some(k=>t.includes(k.replace(/\s+/g,"")))){
        const area=r.width*r.height; if(area>bestArea){bestArea=area;best=el;}
      }
    });
    return best;
  }
  function placeGearUnderParty(){
    const gear=document.getElementById("sgc-gear"); if(!gear) return false;
    const btn=findPartyButton(); if(!btn) return false;
    const r=btn.getBoundingClientRect(); const GAP=8, SIZE=40, RIGHT_MIN=16, TOP_MIN=16;
    const right=Math.max(RIGHT_MIN, Math.round(window.innerWidth - r.right));
    let top=Math.round(r.bottom + GAP);
    const maxTop=Math.max(TOP_MIN,(window.innerHeight||800)-(SIZE+16));
    gear.style.right=right+"px"; gear.style.top=Math.min(top,maxTop)+"px";
    return true;
  }
  function placeGearSafely(){
    const gear=document.getElementById("sgc-gear"); if(!gear) return;
    const TOP_MIN=16, RIGHT=16, SIZE=40, GAP=8, W=360, H=260, MAX=10;
    const vw=window.innerWidth||document.documentElement.clientWidth;
    const zone={left:vw-W,right:vw,top:0,bottom:H};
    const q='a,button,[role="button"],[tabindex],.btn,[class*="Button"],[class*="button"],[class*="pill"],[class*="Chip"],[class*="Badge"],[class*="popover"],[class*="tooltip"],[class*="menu"]';
    const cs=[...document.querySelectorAll(q)].filter(el=>{const r=el.getBoundingClientRect();return r&&r.width&&r.height&&!(r.right<zone.left||r.left>zone.right||r.bottom<zone.top||r.top>zone.bottom);});
    cs.push(...[...document.querySelectorAll("*")].filter(el=>{const st=getComputedStyle(el); if(st.position!=="fixed")return false; const r=el.getBoundingClientRect(); return r&&r.width&&r.height&&!(r.right<zone.left||r.left>zone.right||r.bottom<zone.top||r.top>zone.bottom);}));
    let top=TOP_MIN,left=vw-RIGHT-SIZE,iter=0; const hit=(a,b)=>!(a.right<=b.left||a.left>=b.right||a.bottom<=b.top||a.top>=b.bottom);
    while(iter++<MAX){const box={left,right:left+SIZE,top,bottom:top+SIZE};let bump=false,bto=top;for(const el of cs){const r=el.getBoundingClientRect();if(r&&hit(box,r)){bump=true;bto=Math.max(bto,Math.ceil(r.bottom+GAP));}} if(!bump)break;top=bto;}
    const maxTop=Math.max(TOP_MIN,(window.innerHeight||800)-(SIZE+16)); gear.style.top=Math.min(top,maxTop)+"px"; gear.style.right=RIGHT+"px";
  }

  // ---------- 💎非表示（ON既定）＆トグルを⚙️直下へ ----------
  function installHideGems(){
    if(window.__hideGemsUnmount) return;
    const HCLS="x-hide-gem-paid", STYLE_ID="x-hide-gem-style", BTN_ID="x-hide-gem-btn";
    function addStyle(txt,id){let s=document.getElementById(id); if(!s){s=document.createElement("style");s.id=id;document.head.appendChild(s);} s.textContent=txt;}
    function rm(id){const el=document.getElementById(id); if(el) el.remove();}
    function candidates(){return document.querySelectorAll(`[data-page='shops'] li,[data-page='shops'] .item,[data-page='shops'] [class*="ShopItem"],.market li,.market .item,.shop .item,.items .item,[data-test="shopItem"],[class*="shop-item"],[class*="grid-item"],[class*="ItemCard"],[class*="ItemTile"]`);}
    function isGemCard(root){
      if(root.querySelector('[data-test*="gem" i],[data-testid*="gem" i]'))return true;
      if(root.querySelector('[aria-label*="Gem" i],[aria-label*="ジェム"]'))return true;
      if(root.querySelector('svg[class*="gem" i],svg[aria-label*="Gem" i]'))return true;
      if(root.querySelector('img[alt*="Gem" i],img[alt*="ジェム"]'))return true;
      const txt=(root.textContent||"").replace(/\s+/g," ").trim();
      if(/([^a-z]|^)gem(s)?([^a-z]|$)/i.test(txt))return true;
      if(txt.includes("ジェム")||txt.includes("💎"))return true;
      return false;
    }
    function mark(el){const card=el.closest('li,.item,.shop-item,.grid-item,[class*="Item"],[class*="card"]')||el; if(card&&!card.classList.contains(HCLS)&&isGemCard(card)) card.classList.add(HCLS);}
    function sweep(){candidates().forEach(mark);}
    let supportsHas=false; try{supportsHas=!!(CSS&&CSS.supports&&CSS.supports("selector(:has(*))"));}catch{}
    if(supportsHas){
      addStyle(`
        [data-page='shops'] .items-list>*:has([data-test*="gem" i],[data-testid*="gem" i],[aria-label*="Gem" i],[aria-label*="ジェム"]),
        [data-page='shops'] .item:has([data-test*="gem" i],[data-testid*="gem" i],[aria-label*="Gem" i],[aria-label*="ジェム"]),
        .task-column--rewards *:has([data-test*="gem" i],[data-testid*="gem" i],[aria-label*="Gem" i],[aria-label*="ジェム"])
        { display:none!important; }`, STYLE_ID);
    }else{
      addStyle(`.${HCLS}{display:none!important}`, STYLE_ID);
      const mo=new MutationObserver(()=>sweep()); mo.observe(document.body,{subtree:true,childList:true}); sweep();
    }
    function addToggle(){
      if(document.getElementById(BTN_ID)) return;
      const b=document.createElement("button"); b.id=BTN_ID;
      b.textContent="💎 ジェム非表示: ON（クリックで解除）";
      Object.assign(b.style,{position:"fixed",top:"64px",right:"16px",zIndex:zTop+1,padding:"8px 12px",borderRadius:"18px",border:"none",background:"#16a34a",color:"#fff",fontSize:"13px",boxShadow:"0 2px 8px rgba(0,0,0,.25)",cursor:"pointer"});
      b.onclick=()=>{ rm(STYLE_ID); document.querySelectorAll("."+HCLS).forEach(x=>x.classList.remove(HCLS)); b.remove(); delete window.__hideGemsUnmount; };
      document.body.appendChild(b);
      positionGemToggleNearGear();
    }
    window.__hideGemsUnmount=function(){ rm(STYLE_ID); const b=document.getElementById(BTN_ID); if(b) b.remove(); document.querySelectorAll("."+HCLS).forEach(x=>x.classList.remove(HCLS)); delete window.__hideGemsUnmount; };
    addToggle();
  }
  function positionGemToggleNearGear(){
    const b=document.getElementById("x-hide-gem-btn"); const gear=document.getElementById("sgc-gear"); if(!b||!gear) return;
    const gt=parseInt(getComputedStyle(gear).top,10)||16; const gr=parseInt(getComputedStyle(gear).right,10)||16;
    b.style.top=(gt+48)+"px"; b.style.right=gr+"px"; b.style.zIndex=(zTop+1).toString();
  }

  // ---------- Boot ----------
  function boot(){
    ensureGear();
    installHideGems();
    const reflow=()=>{ if(!placeGearUnderParty()) placeGearSafely(); positionGemToggleNearGear(); };
    window.addEventListener("resize",reflow);
    new MutationObserver(reflow).observe(document.body,{subtree:true,childList:true,attributes:true});
  }

  if(!window.__SGC_LOADED__){ window.__SGC_LOADED__=true; boot(); }
  toggleOverlay();
})();
