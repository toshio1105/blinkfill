# BlinkFill - フォーム自動入力ツール

まばたきする間に、Webフォームを埋める Chrome 拡張機能。

- **個人情報のワンクリック入力** — 氏名・フリガナ・メール・電話・住所・勤務先・生年月日を登録しておき、ボタン1つ（または <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>）で入力
- **貼り付けた内容の一括入力** — 経費精算や勤怠のように、毎回同じ画面に同じ種類の項目を打つ作業を、JSON や「項目: 値」を貼るだけで一括入力
- **よく使う画面の入力先を記憶** — 一度確認した画面は、次回からAIに問い合わせずに一瞬で入力

**送信・保存ボタンは押しません。** 入力までで止めるので、確認と送信はご自身で行ってください。

## 日本のフォームに強い

- 郵便番号の 3桁＋4桁、電話番号の 3分割、生年月日の年・月・日プルダウン
- ひらがなで登録しても、フリガナ欄にはカタカナ、ふりがな欄にはひらがなで入力
- 都道府県のプルダウン、「ハイフンなし」指定の欄
- shadow DOM・iframe・React などで作られた画面にも対応

## インストール

> Chrome ウェブストアには未公開です。以下の手順で読み込んでください。

1. [Releases](../../releases) から最新の `blinkfill-x.y.z.zip` をダウンロードして展開する
2. Chrome で `chrome://extensions` を開く
3. 右上の **デベロッパー モード** をオンにする
4. **パッケージ化されていない拡張機能を読み込む** → 展開したフォルダを選ぶ
5. ツールバーのパズルアイコンから BlinkFill をピン留めする

更新するときは、新しい zip を同じ場所に展開し直して、`chrome://extensions` の更新ボタン（↻）を押します。

## AI の設定

どの欄に何を入れるかの判定に AI を使います（使わない設定もできます）。**APIキーは各自で用意して入力してください。** 拡張機能にキーは入っていません。

| AI | 特徴 | キーの取得 |
|---|---|---|
| **Jev（TypeSafe）おすすめ** | 「選ぶ」ことに特化した AI。最速で最安。確信度も返すので、自信のない欄は入力前に外せる。現在は招待制 | https://console.typesafe.ai/ |
| OpenAI | GPT-5.6 Luna が高速・低価格 | https://platform.openai.com/api-keys |
| Claude（Anthropic） | Haiku 4.5 は速く安い。Opus 5 は最も賢いが遅め | https://console.anthropic.com/ |
| Gemini（Google） | 無料枠あり | https://aistudio.google.com/apikey |

設定（歯車アイコン）で使う AI を選び、キーを貼って保存します。
「AIで欄を判定する」をオフにすると、記憶した入力先と欄の名前だけで入力します（外部通信なし・キー不要）。

### 速さの目安（23欄の会員登録フォーム、筆者の環境で計測）

| AI | かかった時間 |
|---|---|
| **Jev** | **約0.3秒** |
| Claude Haiku 4.5 | 約1.1秒 |
| GPT-5.6 Luna | 約1.3秒 |
| Claude Opus 5 | 約2.6秒 |

どの AI でも、テスト用のフォームでは同じ欄を同じ値で埋めました。

## プライバシー

- **登録した個人情報とAPIキーは、あなたのChromeの中（`chrome.storage.local`）だけに保存されます。** 作者を含め、誰にも送られません。暗号化はされないので、共用PCでは登録しないでください
- AI に送るのは「欄の名前・種類・選択肢」と「貼り付けた内容」だけです。**登録した個人情報の値や、画面にすでに入っている値は送りません**（テストで送信内容を検査しています）
- 記憶した入力先もあなたのChromeの中だけにあり、AIの学習などに使われることはありません
- パスワード欄とカード番号の欄には、登録も入力もしません
- 怪しいサイトでは使わないでください（Chrome 標準の自動入力と同じく、開いているページに情報が入ります）

## 開発

```bash
npm install                 # SDK と esbuild（vendor/ の再生成にだけ使う）
npm run vendor              # vendor/anthropic.js を作り直す
node test/serve.mjs         # http://localhost:5188 に模擬画面（/ 経費、/profile 会員登録、/panel サイドパネル）
ENV_FILE=path/to/.env node test/providers-e2e.mjs   # 各AIで割り当てと送信内容を検査
```

拡張機能そのものはビルド不要です。Claude 用の公式SDKは `vendor/anthropic.js` に1ファイルで同梱しています。

## 構成

```
manifest.json
src/core.js        ページ内で動く部分（欄の読み取り・入力。送信ボタンは押さない）
src/profile.js     個人情報の判定（autocomplete → 欄名のパターン → 分割欄 → AI）
src/plan.js        貼り付けた内容の割り当て（記憶済み → 名前一致 → AI）
src/ai.js          Jev / OpenAI / Claude / Gemini の呼び出し
src/config.js      AI の設定の保存
src/sidepanel.*    サイドパネルの画面
src/background.js  ショートカット（Alt+Shift+P）
```

## ライセンス

MIT License（[LICENSE](LICENSE)）。無保証です。入力内容は送信前に必ずご自身で確認してください。
