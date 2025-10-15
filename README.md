# habitica-hubspot-gamify

## Bookmarklets

Habitica 上で Sales Gamify Console を開くための共通ブックマークレットです。

- 共通版

```javascript
javascript:(function(){var d=document,s=d.createElement('script');s.src='https://sales-gamify.onrender.com/i.js?t='+Date.now();s.crossOrigin='anonymous';(d.head||d.documentElement).appendChild(s);})();
```

- テナント固定例（acme）

```javascript
javascript:(function(){var d=document,s=d.createElement('script');s.src='https://sales-gamify.onrender.com/i.js?tenant=acme&t='+Date.now();s.crossOrigin='anonymous';(d.head||d.documentElement).appendChild(s);})();
```

## Console UI 操作ヒント

- タイトルバー右側のツールバーで Zoom（80–125%）、表示密度（標準/コンパクト）、フォントサイズ（S/M/L）、コントラスト（標準/高）を即時調整できます。設定はテナントごとに保存されます。
- 各テーブル左上の「⚙ 列」から表示列を切り替え、ヘッダー右端をドラッグして列幅を変更できます。変更内容はタブごとに保存されます。
- モーダルはヘッダーをドラッグして移動でき、最寄りの四隅へスナップします。右下グリップでリサイズし、位置とサイズは再利用時に復元されます。
- ショートカット: `Ctrl/Cmd + S` で保存（API保存ボタンと同等）、`Esc` でモーダルを閉じます。

## 動作確認フロー

1. `https://sales-gamify.onrender.com/i.js` が 200 (Content-Type: application/javascript) を返すことを確認します。
2. Habitica 上でブックマークレットを実行し、Network パネルで `i.js` → テナント配信中の `injector.js` がいずれも 200 になることを確認します。
3. 画面右下付近に「設定」ボタンが現れ、クリックで Sales Gamify Console が開くこと（ドラッグ移動・リサイズも動作すること）を確認します。

※ Habitica の CSP でスクリプト読み込みが制限される場合は、Tampermonkey 等で以下を `@require` に追加してください。

```
// @require https://sales-gamify.onrender.com/i.js
```
