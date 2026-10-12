# 美力之星 StarBeauty

獨立 GitHub 專案：`yukidu/starbeauty`

正式部署名稱：`starbeauty`

正式網址：`https://starbeauty.yukidu.workers.dev`

## 功能

- 與「繁星回聲」共用同一個 Google 會員身分，使用一次性 SSO 授權碼登入。
- 學員作業列表、截止時間、補件、重新繳交與繳交紀錄。
- 文件、簡報、圖片、影片分段上傳到 Cloudflare R2。
- 發票／收據專用欄位。
- D1 保存課程、學員、作業、批改、通知與稽核紀錄。
- 老師／管理員後台：建立課程、建立作業、審核、補件、角色管理。
- LINE 綁定碼、Webhook 簽章驗證、LINE 檔案收件與作業歸檔。
- 私人檔案權限：只有本人或老師／管理員可讀取。

## Web First / Capacitor-ready

- 現在仍以 Web App 為正式產品，不建立 Android / iOS 專案。
- 不安裝 Capacitor、Firebase 或 Native plugin；目前 Web production 不載入任何 Native 程式。
- `public/platform.js` 集中登入、API URL、檔案、相機、通知、分享與裝置判斷。
- Web 預設繼續使用標準 Web API；未來若包 Capacitor，只需註冊 Native adapter，不必重寫會員、API 或資料庫。
- Cloudflare Workers / D1 / R2 架構與 API 路徑保持不變。
- 前端正式網址採 `location.origin`，API base、EchoStars 登入 URL、OAuth callback path 可由 `globalThis.__STARB_CONFIG__` 覆寫，避免散落在畫面程式。
- 裝置判斷只在 module 初始化時計算一次；platform layer 不新增 polling、全域 event listener 或背景 API request。
- 目前此 repository **沒有既存的 PWA manifest / Service Worker**；因此本次不新增或重寫 Service Worker，以免在沒有明確快取策略前改變現有 Web 行為。若後續要正式啟用 PWA，應沿用同一個 platform layer 與 Cloudflare backend。

核心原則：**Web First、PWA compatible、Capacitor-ready、Native Optional、Cloudflare Backend Shared。**

## Cloudflare 資源

- Worker：`starbeauty`
- D1：`starbeauty_db`
- R2：`starbeauty-files`

## GitHub Secrets

部署前需在此 repository 設定：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`（建議）
- `LINE_CHANNEL_SECRET`
- `LINE_CHANNEL_ACCESS_TOKEN`

LINE Webhook：`https://starbeauty.yukidu.workers.dev/api/line/webhook`
