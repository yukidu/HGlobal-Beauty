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
