// Habitica 課金UIを非表示にする社内向けブックマークレットです。DOM構造変更時は再確認してください。
javascript:(()=>{const css=`
  [href="/shops"]{display:none!important;}
  .sidebar .rewards,.right-panel .rewards{display:none!important;}
  .gems,.gem-balance,[class*="gem"]{display:none!important;}
  .tasks-page .rewards,[data-test="rewards"],.reward-column,.shop,.tasks-page .tier-list,
  .task-column--rewards,[aria-label="ごほうび"],[data-testid="rewards"]{display:none!important;}
`;const s=document.createElement('style');s.textContent=css;document.documentElement.appendChild(s);alert('社内向け：Habiticaの課金UIを非表示にしました');})();
