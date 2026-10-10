# StarBeauty profile sync contract

美力之星登入時向繁星回聲交換一次性 SSO code，取得完整基本資料快照。

同步資料至少包含：姓名、Email、頭像、安麗編號、手機、居住地、中心、獎銜與審核狀態、加入/留下原因、推薦人、上手白金、上手鑽石、生日、星座、天賦數、生命靈數、註冊/審核/最後活動資訊，以及必要會員狀態。

StarBeauty 將快照保存於 `member_profiles.profileJson`，並以 `profileHash` 判斷是否真的變更；未變更時不重複寫入快照。KV 僅為可選快取層，未綁定 KV 時系統仍可完整運作。
