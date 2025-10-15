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
