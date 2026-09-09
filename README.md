# ベースプル（Basepull）— エアテーブル → グーグルスプレッドシート 自動同期アドオン

グーグルスプレッドシートのエディタアドオン。エアテーブルのテーブル／ビューを指定したタブに書き出し、プロ版は1時間ごと・6時間ごと・毎日で自動更新する。データはユーザー自身のグーグルアカウント内のアップスクリプトから直接エアテーブルAPIを呼ぶため、こちらのサーバーを経由しない（プライバシー審査で有利）。

- 無料版: 1同期／手動実行／1,000行まで
- プロ版: 月19ドル（同期無制限・スケジュール・200,000行）

## 構成

```
addon/     アドオン本体（Code.gs, Lib.gs, Sidebar.html, appsscript.json）
backend/   ライセンス確認サーバー（GASウェブアプリ。ストライプのウェブフックを受けてスプレッドシートに記録）
site/      LP＋SEO記事（GitHub Pages）
test/      Node製テスト（純粋ロジック／GASモックE2E／サイドバーUI）
```

テスト: `node test/lib.test.js` は `node -e "require('module').Module._extensions['.gs']=require('module').Module._extensions['.js'];require('./test/lib.test.js')"`、`node test/gas-mock.test.js`、`NODE_PATH=$(npm root -g) node test/sidebar.test.js`

## 公開手順（キッシュさんのグーグルアカウントで行う作業）

### 1. バックエンドを先に出す（10分）
1. script.google.com → 新しいプロジェクト「Basepull License」。`backend/Code.gs` を貼り付け、プロジェクト設定 →「appsscript.json を表示」をオンにして `backend/appsscript.json` の内容に置き換える。
2. プロジェクト設定 → スクリプトプロパティに3つ追加:
   - `LICENSE_SECRET` … ランダム文字列（例: `openssl rand -hex 24` の出力）
   - `WEBHOOK_KEY` … 別のランダム文字列
   - `STRIPE_SECRET` … ストライプの秘密鍵（sk_live_…）※解約イベント時に顧客メールを引くためだけに使用
3. エディタで `setupAndGrantMe` を1回実行（権限承認）。台帳スプレッドシート「Basepull licenses」が作られ、自分がプロ扱いになる。
4. デプロイ → 新しいデプロイ → 種類「ウェブアプリ」→ 実行ユーザー「自分」、アクセス「全員」→ デプロイ。表示された **ウェブアプリURL** を控える。

### 2. ストライプ（10分）
1. 商品「Basepull Pro」月額 19 USD（継続）を作成し、決済リンクを作成。決済リンクの設定で「顧客のメールを収集」はデフォルトで有効。
2. 開発者 → ウェブフック → エンドポイント追加: URL は `＜ウェブアプリURL＞?key=＜WEBHOOK_KEY＞`。イベント: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`。
3. 設定 → 請求 → カスタマーポータル を有効にし、ポータルのログインリンク（billing.stripe.com/p/login/…）を控える。

### 3. アドオン本体（15分）
1. script.google.com → 新しいプロジェクト「Basepull」。`addon/Code.gs`, `addon/Lib.gs` を貼り、HTMLファイル `Sidebar` を追加して `addon/Sidebar.html` を貼る。`appsscript.json` を `addon/appsscript.json` で置き換える。
2. `Code.gs` 冒頭の `BP_CONFIG` を編集: `BACKEND_URL`（手順1のURL）、`BACKEND_SECRET`（LICENSE_SECRET と同じ値）、`CHECKOUT_URL`（決済リンク）、`PORTAL_URL`（ポータルリンク）、`SITE_URL`。
3. 動作確認: デプロイ → 「テストデプロイ」→ 種類「エディタ アドオン」→ 任意のスプレッドシートを選んで「テストを実行」。サイドバーでトークンを入れて同期できること、スケジュール保存でトリガーが作られること（トリガー画面で確認）、1時間後に自動実行されることを確認。
   - もし自動実行時に「Cannot open spreadsheet from the scheduler」と出る場合は、`appsscript.json` のスコープ `spreadsheets.currentonly` を `https://www.googleapis.com/auth/spreadsheets` に変更する（この場合マーケットプレイス審査で「機密スコープ」扱いになり、審査が2〜4週間伸びる）。

### 4. グーグルクラウドプロジェクトとOAuth（20分＋審査待ち）
1. console.cloud.google.com で新規プロジェクト「Basepull」を作成。APIとサービス → ライブラリで「Google Workspace Marketplace SDK」を有効化。
2. OAuth同意画面: 外部、アプリ名 Basepull、サポートメール、ロゴ、ホームページ `https://omoseka2525-pixel.github.io/basepull/`、プライバシー `…/privacy.html`、利用規約 `…/terms.html`、承認済みドメイン `github.io`。スコープは `appsscript.json` の4つ。
3. アップスクリプト側: プロジェクト設定 → 「Google Cloud Platform（GCP）プロジェクト」→ プロジェクト番号を入力して変更。
4. 同意画面で「確認のために送信」。非機密スコープのみなら通常は数日（ブランド確認）。※`spreadsheets` フルスコープにした場合は動画デモの提出を求められる。

### 5. マーケットプレイス公開（30分＋審査1〜2週間）
1. アップスクリプト: デプロイ → 新しいデプロイ → 種類「アドオン」→ 説明を入れてデプロイ。デプロイIDを控える。
2. クラウドコンソール → Google Workspace Marketplace SDK → 「アプリの設定」: アプリの可視性「公開」、インストール設定「個人＋管理者」、エディタアドオン → Sheets にチェック、デプロイIDを入力。
3. 「ストアの掲載情報」: アプリ名 Basepull、短い説明「Sync Airtable tables and views into Google Sheets on a schedule」、詳細説明（`site/index.html` の文言を流用）、カテゴリ「Productivity / Business tools」、スクリーンショット（1280×800 を最低1枚。テストデプロイでサイドバーを開いて撮る）、アイコン（128px, `site/favicon.svg` をPNG化）、サポートURL、プライバシー・利用規約URL。
4. 「公開」→ 審査申請。却下理由は大半が「スクリーンショット不足」「説明文とスコープの不一致」なので、説明文にスコープの理由（「同期先のスプレッドシートのみ書き込みます」等）を明記する。

### 6. サイト公開
GitHub リポジトリ `basepull` の `site/` 配下を GitHub Pages（Deploy from branch → main → /site が選べないので、`site` の中身をリポジトリ直下に置く）で公開。`index.html` の `#installBtn2` の URL を、承認後のマーケットプレイスURLに差し替える。

## 収益の目安
月50万円 ≒ 200ユーザー × 19ドル。無料→有料転換を4%と置くと5,000インストール。SEO記事（`site/airtable-to-google-sheets.html`, `airtable-importer-alternative.html`）と、閉鎖された Airtable Importer のレビュー欄・Airtable コミュニティ・Reddit r/Airtable での告知が主な集客。

## 既知の制約
- エディタアドオンの時間トリガーは1時間に1回まで、ユーザー×ドキュメントごとに1本まで（グーグルの制限）。
- 1回の実行は6分以内（無料ワークスペース）。200,000行の同期は約7〜8分かかるため、実際には10万行前後が上限。必要なら分割同期を実装する。
- GASウェブアプリはリクエストヘッダを読めないため、ストライプ署名検証の代わりに URL のシークレットキーで保護している。
