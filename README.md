# まちアリーナ（machi-arena）セットアップガイド

街そのものをゲーム盤にする、スマホ向けの位置情報リアルタイムゲームです。
リアル鬼ごっこ／リアルかくれんぼ／リアル陣取り合戦／リアルすごろくの4モードを収録しています。

## ファイル構成

```
machi-arena/
├── index.html            画面（ログイン・登録・PW変更・ロビー・待機室・ゲーム・結果）
├── style.css             スタイル
├── app.js                フロントエンドロジック（ESModule）
├── config.js             設定（GAS URL・バージョン・デバッグ等）
├── sw.js                 Service Worker（PWA）
├── manifest.webmanifest  PWA マニフェスト
├── icon.svg              アプリアイコン
└── gas/
    └── Code.gs           GAS バックエンド（GitHub Pages には不要。clasp 管理用）
```

## 全体構成

| 役割 | 使うもの |
|---|---|
| 画面・位置取得・地図・レーダー | GitHub Pages ＋ Geolocation API ＋ Leaflet/OpenStreetMap |
| 認証・ルーム・位置同期・判定 | GAS Web アプリ（`doPost`）＋ スプレッドシート |
| 実況・指令・ミッション文 | Gemini API（GAS 経由。キーはフロントに出さない） |
| 音声実況 | Gemini TTS（GAS 経由）。失敗時は端末の読み上げに自動切替 |
| 開始・占領・勝利の演出映像 | Google Earth Studio で書き出し → Google Drive（または GitHub）に配置 |

位置の同期は 5 秒ごとのポーリングです（`config.js` の `POLL_INTERVAL_MS`）。
捕獲・占領・到着の判定はすべてサーバー側で、サーバーに保存された最新位置（30 秒以内・精度条件あり）を使って行います。

---

## 1. スプレッドシートの準備

1. Google ドライブで新しいスプレッドシートを作成（名前は例：`machi-arena-db`）
2. 「拡張機能」→「Apps Script」を開く
3. 既存の `コード.gs` の中身をすべて消し、`gas/Code.gs` の内容を貼り付けて保存
4. 関数選択で `setup` を選んで「実行」→ 権限を承認
5. 以下の 7 シートが自動作成されます

### 列定義

**Users**（会員）

| 列 | 内容 |
|---|---|
| userId | `u_` + UUID |
| email | 小文字に正規化したメールアドレス |
| nickname | 表示名（1〜20文字） |
| passwordHash | SHA-256（ソルト付き・300回ストレッチ） |
| salt | ソルト |
| isFirstLogin | TRUE の間は本パスワード設定以外の操作を拒否 |
| failCount | 連続ログイン失敗回数（5回で15分ロック） |
| lockedUntil | ロック解除時刻（ミリ秒） |
| createdAt / updatedAt | 作成・更新時刻（ミリ秒） |

**Sessions**（ログイン中のトークン）: `token`, `userId`, `expiresAt`（14日）, `createdAt`

**Rooms**（ルーム）

| 列 | 内容 |
|---|---|
| roomId / code | 内部ID / 参加用6文字コード |
| name / mode | ルーム名 / `onigokko` `kakurenbo` `territory` `board` |
| hostId | ホストの userId |
| status | `waiting` → `playing` → `finished` |
| settingsJson | 制限時間・捕獲距離・隠れ時間などの設定 |
| centerLat / centerLng | 作成地点（近くのルーム検索に使用） |
| startedAt / endsAt | 開始・終了時刻（ミリ秒） |
| resultJson | 勝敗・ランキング |
| createdAt | 作成時刻 |

**Players**（ルーム参加者と位置）: `roomId`, `userId`, `nickname`, `role`（oni/runner）, `team`（red/blue）, `lat`, `lng`, `accuracy`, `locUpdatedAt`, `status`（active/caught）, `score`, `position`（すごろくの現在マス）, `target`（目的マス）, `mission`, `joinedAt`

**Spots**（セーフティゾーン／陣地／すごろくのマス）: `spotId`, `roomId`, `name`, `lat`, `lng`, `radius`, `type`（safe/territory/board）, `orderNo`, `ownerTeam`, `ownerUserId`, `capturedAt`, `createdAt`

**Events**（実況ログ）: `eventId`, `roomId`, `type`（start/catch/capture/dice/mission/order/finish/system）, `message`, `userId`, `visibility`（all/private）, `createdAt`

**Media**（演出素材）: `key`, `driveFileId`, `directUrl`, `mediaType`（video/image）, `note`
初期行として `start`・`capture`・`catch`・`win`・`board` が入ります。

## 2. スクリプトプロパティ

Apps Script の「プロジェクトの設定」→「スクリプト プロパティ」に追加します。

| キー | 必須 | 値 |
|---|---|---|
| `GEMINI_API_KEY` | ○ | Google AI Studio で発行したキー |
| `GEMINI_TEXT_MODEL` | | 省略時 `gemini-2.5-flash` |
| `GEMINI_TTS_MODEL` | | 省略時 `gemini-2.5-flash-preview-tts` |
| `GEMINI_TTS_VOICE` | | 省略時 `Kore`（`Puck`、`Charon`、`Fenrir` なども可） |
| `SPREADSHEET_ID` | | スタンドアロンのスクリプトにする場合のみ |

モデル名は提供状況に合わせて書き換えるだけで切り替えられます。キーが未設定でもゲームは動き、実況は定型文になります。

## 3. GAS のデプロイ

1. 右上「デプロイ」→「新しいデプロイ」
2. 種類の選択で「ウェブアプリ」
3. 設定
   - 次のユーザーとして実行：**自分**
   - アクセスできるユーザー：**全員**
4. 「デプロイ」→ 表示された URL（`https://script.google.com/macros/s/…/exec`）をコピー
5. 初回はメール送信（MailApp）と外部通信（UrlFetchApp）の権限承認が出るので許可

コードを修正したら「デプロイを管理」→ 鉛筆アイコン →「バージョン：新バージョン」で更新します（URL は変わりません）。

### 定期お掃除トリガー（推奨）

「トリガー」→「トリガーを追加」→ 関数 `cleanup`、時間主導型、日付ベース（1日1回）。
7日以上前のルーム・イベント・期限切れセッションを削除します。

### 動作確認

ブラウザで `…/exec` を開き、`{"ok":true,"app":"まちアリーナ","version":"v1.0.1",…}` が出れば OK です。

## 4. config.js の設定

```js
GAS_API_URL: 'https://script.google.com/macros/s/（デプロイID）/exec',
APP_VERSION: 'v1.0.1',
DEBUG_MODE: false,          // true で通信内容をコンソールに出力
TTS_ENGINE: 'gemini',       // 'browser' にすると API を使わず端末で読み上げ
```

`GEMINI_API_KEY` は空のままにしてください。リポジトリが公開されるため、キーは GAS 側だけで管理します。

## 5. Google Earth Studio 素材を Drive で使う

1. Google Earth Studio で、遊ぶ街の上空からズームインする映像などを作成
   - 推奨：縦長 1080×1920、10秒前後、MP4（H.264）
   - 例：`start`＝街全体からスタート地点へ急降下、`capture`＝陣地の周りを旋回、`win`＝上空へ引いていく
2. 書き出した連番画像は動画編集ソフトで MP4 にまとめる
3. Google ドライブにアップロード →「共有」→ 一般的なアクセスを **「リンクを知っている全員」・閲覧者** に変更
4. 共有リンク `https://drive.google.com/file/d/【ここがファイルID】/view` の ID 部分をコピー
5. スプレッドシートの **Media** シートの該当行 `driveFileId` に貼り付け

アプリは `drive.google.com/uc?export=download&id=…` で動画を直接再生し、再生できない場合は Drive のプレビュー画面に自動で切り替えます。
大きな動画は Drive 側で直接再生できないことがあるため、**10MB 以下の短い MP4 を GitHub リポジトリの `media/` フォルダに置き、`directUrl` に `./media/start.mp4` のように書く方法が最も安定します**（`directUrl` は `driveFileId` より優先）。
画像（`mediaType` を `image`）の場合は `lh3.googleusercontent.com/d/ID` 形式で表示します。

各スポットには「Google Earthで見る」リンクも付くので、下見やルール説明に使えます。

## 6. GitHub Pages で公開

1. GitHub で新しいリポジトリ `machi-arena` を作成（Public）
2. `gas/` 以外のファイル（`index.html` `style.css` `app.js` `config.js` `sw.js` `manifest.webmanifest` `icon.svg`）をリポジトリ直下に置いてプッシュ
   ```bash
   git init
   git add index.html style.css app.js config.js sw.js manifest.webmanifest icon.svg README.md
   git commit -m "まちアリーナ v1.0.1"
   git branch -M main
   git remote add origin https://github.com/kenken6291/machi-arena.git
   git push -u origin main
   ```
3. リポジトリの「Settings」→「Pages」→ Source：`Deploy from a branch`、Branch：`main` / `(root)` → Save
4. 数分後 `https://kenken6291.github.io/machi-arena/` で公開されます

位置情報は HTTPS でしか使えないため、GitHub Pages の URL でテストしてください。
バージョンを上げるときは `config.js` の `APP_VERSION` と `sw.js` の `CACHE` 名を同時に変えると、古いキャッシュが確実に入れ替わります。

## 7. 遊び方の流れ

1. 新規登録 → 画面に出る仮パスワード（メールにも届く）でログイン → 本パスワードを設定
2. ロビーでモードを選びルーム作成 → 6文字のルームコードを仲間に共有
3. 待機室でホストがスポットを追加（現在地 or 地図タップ）、必要なら鬼やチームを指定
4. 「ゲーム開始」で全員の画面が切り替わり、Earth Studio 映像と AI 実況でスタート

| モード | 操作 | 勝敗 |
|---|---|---|
| 鬼ごっこ | 鬼は捕獲距離内で「確保する」。逃走者は鬼の距離と方向がレーダーで見える | 全員確保で鬼の勝ち、時間切れで逃走者の勝ち |
| かくれんぼ | 鬼のレーダーは「近い・中くらい・遠い」の距離帯のみ。定期的に20秒間だけ全員の位置が公開 | 同上 |
| 陣取り合戦 | スポット半径内で「チェックイン」すると自チームが占領。奪われた直後は一定時間奪い返せない | 終了時の占領数 |
| すごろく | ダイス → 出たマスまで歩く → 到着チェックイン → AI ミッション → 完了で前進 | 最後のマスに最初に到着 |

右側のボタン：📡 レーダー切替、◎ 現在地へ、🎙 AI ゲームマスターに指令をもらう、🔊 音声オン/オフ、💬 実況ログ（ホストはここから強制終了）。

## 8. 運用メモ

- **GAS の実行回数**：参加者1人あたり 5 秒に1回 `syncRoom` が走ります。10人×30分で約3,600回。無料アカウントでも日次上限には余裕がありますが、大人数なら `POLL_INTERVAL_MS` を 8000 程度に。
- **同時処理**：書き込みは LockService で直列化しています。1ルーム10人程度までを想定しています。
- **GPS 精度**：捕獲・チェックインは精度 ±50m 以内（設定 `maxAccuracy`）でないと受け付けません。ビル街では精度が落ちるので、捕獲距離は 15〜20m 程度が遊びやすいです。
- **画面スリープ**：ゲーム中は Wake Lock で画面消灯を防ぎます。iPhone はブラウザを最前面にしておく必要があります（バックグラウンドでは位置送信が止まります）。
- **音声**：iPhone は最初に画面をタップするまで音が出ません。Gemini TTS が失敗した場合は端末の読み上げに自動で切り替わります。
- **メール送信**：MailApp は無料アカウントで1日100通まで。登録時はメールが届かなくても画面に仮パスワードが出ます。パスワード再発行はメールのみです。
- **安全**：AI の指令・ミッションには「交通ルール遵守・私有地に入らない・人にぶつからない」を前提にするようシステム指示を入れています。参加者にも事前に周知してください。
