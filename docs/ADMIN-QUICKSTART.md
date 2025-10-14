# 管理者クイックスタート

Habitica × HubSpot ゲーミフィケーション運用を最小時間で立ち上げるためのメモです。サーバーの起動方法・コンソールの操作・監査/OPS API の確認手順を 1 つのページにまとめています。

## 必要な環境変数

- `SGC_TOKENS`  
  テナントごとの編集トークンを JSON で指定します。Render などのマネージド環境でもそのままコピー可能です。
  ```json
  {"default":"sample-admin-token","*":"fallback-token"}
  ```
- `PUBLIC_BASE_URL`  
  ブラウザからアクセスするベース URL。Render の場合はデプロイ URL を設定してください。
- その他  
  `PORT` (既定: 10000)、`DRY_RUN=1` で Habitica への書き込みを抑止できます。HubSpot / Zoom 連携向けのマッピングは `HUBSPOT_USER_MAP_JSON` などで注入します。

## サーバーの起動

1. 依存ライブラリをインストール: `npm install`
2. TypeScript ビルド: `npm run build`
3. サーバースタート: `npm start`  
   `PUBLIC_BASE_URL` を設定した状態で起動すると、コンソールからの API 呼び出しが正しいエンドポイントに向きます。

開発モードで実行したい場合は `npm run dev` を使用してください。

## 管理コンソールの使い方

1. Habitica か社内ポータルから `/admin/console/` を開きます。
2. 画面上部で `Tenant`, `BaseURL`, `Token` を入力し、「Ping」で疎通確認を行います。
3. タブ構成
   - **スコア設定** / **HubSpot連携** / **承認・売上** / **CSV取込** / **ダッシュボード**  
     従来どおりの設定・CSV インポート・ダッシュボード閲覧タブです。
   - **手動調整**  
     手動で XP を増減できます。クイックボタン「ミス架電 -1」「デモ +5」で頻出パターンを即時入力できます。下部の履歴テーブルは `GET /ops/logs` を利用して最新 50 件の調整・ショップ購入を表示します。`userId` フィルタで特定ユーザーのみ抽出可能です。
   - **ショップ**  
     左ペインでカタログ (`name / priceXp / stock / badge`) を編集し、「保存」で `PUT /ops/catalog` に反映します。右ペインでユーザー ID・品目・数量を指定し「購入処理」を実行すると `POST /ops/purchase` が呼ばれ、在庫と XP が更新されます。成功後は監査ログにも反映されます。
   - **監査ログ**  
     `GET /tenant/:id/audit` を表示します。手動調整・カタログ更新・購入処理のアクター・実行内容が確認できます。

アクセストークンは `Authorization: Bearer <token>` ヘッダに自動で付与されます。入力を変更した場合は「保存」でブラウザの LocalStorage に記録され、次回アクセス時も復元されます。

## 編集トークンの払い出し

- `SGC_TOKENS` を更新してテナント毎のトークンを登録してください。`*` エントリはワイルドカード (全テナント共通) です。
- トークンを共有する際は HTTPS 上で配布し、利用終了後は必ずトークンをローテーションします。
- トークンが一致しない場合、保存系 API は `401 Unauthorized` を返し、コンソール側にもエラーメッセージが表示されます。

## トラブルシューティング

- **Ping が失敗する**  
  `PUBLIC_BASE_URL` が未設定、または CORS 設定がブロックしていないか確認してください。
- **保存時に 401 が返る**  
  `Tenant` 名と `SGC_TOKENS` の組み合わせを確認します。Render の Secrets 反映には再デプロイが必要です。
- **購入処理が失敗する**  
  在庫不足 (`stock-shortage`) や品目無効 (`item-disabled`) の場合はレスポンスで詳細が返ります。カタログを再確認してください。
- **ログに反映されない**  
  `data/` ディレクトリの書き込み権限と、JSONL ファイルのアクセス権を確認します。`GET /ops/logs` を直接叩いて疎通を確認するのが早道です。

## curl での疎通確認

`<BASE>` は `PUBLIC_BASE_URL`、`<TOKEN>` は `SGC_TOKENS` に登録した編集トークンに置き換えてください。テナント指定がない場合は `default` が使用されます。

```bash
# health
curl -s <BASE>/healthz

# ルール / ラベル読み書き
curl -s <BASE>/tenant/default/rules
curl -s -X PUT <BASE>/tenant/default/rules \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{}'

# カタログ保存 → 取得
curl -s -X PUT <BASE>/ops/catalog \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"tenant":"default","items":[{"id":"demo","name":"デモ景品","priceXp":5}]}'
curl -s "<BASE>/ops/catalog?tenant=default"

# 手動調整とログ取得
curl -s -X POST <BASE>/ops/adjust \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"tenant":"default","userId":"u001","delta":-1,"note":"ミス架電"}'
curl -s "<BASE>/ops/logs?tenant=default&userId=u001&limit=10"
```

## ブックマークレット

`tools/bookmarklets/hide-habitica-paid-ui.js` をブラウザのブックマークとして保存すると、Habitica 上の課金 UI をワンクリックで非表示にできます。DOM 構造の変更に備え、利用時は動作を必ず目視確認してください。

---

アップデート時は `npm run build` → 再起動の順で反映されます。React 等のフレームワークを使っていないため、配信ファイルは `dist/public-admin/` にコピーされた静的 HTML/JS です。
