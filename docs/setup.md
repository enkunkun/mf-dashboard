# セットアップ

このガイドでは、ローカルPC上のDocker ComposeでWebダッシュボード、crawler、Cloudflare Tunnelを常時稼働させる。完了すると、許可されたGoogleアカウントでダッシュボードへアクセスでき、毎日6:30と15:30（JST）の自動更新と画面上からの手動更新を利用できる。

セットアップは次の順番で進める。

1. Money Forward MEと1Passwordを準備する
2. Cloudflare Zero TrustとGoogle OAuthを準備する
3. アプリとインフラの設定ファイルを作成する
4. Terraformを適用する
5. Docker Composeを起動して動作を確認する

## 必須要件

- [Money Forward ME](https://moneyforward.com/)
- [1Password](https://1password.com/jp)（Service Account）
- [Cloudflare](https://www.cloudflare.com/ja-jp/)アカウント（Zero Trustを有効化済み）
- 公開先FQDNのゾーンをCloudflareで管理していること
- ローカルPCが常時起動できる環境
- ローカルにインストール済みのツール:
  - **Docker Desktop**（System SettingsのLogin Itemsでログイン時起動を有効化）
  - `git`
  - `terraform`（1.6以上）
  - `openssl`

リポジトリを取得し、以降のコマンドを実行するディレクトリへ移動する。

```sh
git clone https://github.com/hiroppy/mf-dashboard.git
cd mf-dashboard
```

## 1. Money Forward MEと1Passwordの準備

- Money Forward MEでワンタイムパスワードを設定する（[設定方法](https://support.me.moneyforward.com/hc/ja/articles/7359917171481-%E4%BA%8C%E6%AE%B5%E9%9A%8E%E8%AA%8D%E8%A8%BC%E3%81%AE%E8%A8%AD%E5%AE%9A%E6%96%B9%E6%B3%95)）
- 1PasswordでService Accountを発行する（[設定方法](https://developer.1password.com/docs/service-accounts/get-started#create-a-service-account)）
  - Private、Personal、Familyなど、最初から用意されている保管庫へService Accountはアクセスできない。Money Forward MEのアカウントを自分で作成した保管庫へ移し、Service Accountへアクセス権を付与する。
  - Money Forward MEのログイン項目に、標準の`username`と`password`フィールド、およびワンタイムパスワードのフィールドを用意する。crawlerはこれらのフィールドを1Password SDKから読み取る。

## 2. Cloudflare Zero Trustの準備

### 2.1 Zero Trustの有効化とTeam domainの確認

CloudflareダッシュボードからZero Trustを有効化し、Team domain（`<team-name>.cloudflareaccess.com`）を控えておく。

Team domainは、独自に公開する`dashboard.example.com`のようなホスト名とは別の値である。Cloudflare Zero Trustの設定画面に表示される`cloudflareaccess.com`で終わるドメインを、`https://`や末尾の`/`を付けずに使用する。この値はGoogle OAuth clientの設定と、後述する`.env`の`CLOUDFLARE_ACCESS_TEAM_DOMAIN`で共通して使う。

### 2.2 Google OAuth clientの準備

Googleログイン用のWeb Application clientを作成する。

1. [Google Cloud Console](https://console.cloud.google.com/)でプロジェクトを作り、OAuth client IDを発行
   - APIs & Services > Credentials > Create Credentials
   - アプリケーションタイプ: `Web application`
   - 承認済みの JavaScript 生成元: `https://<your-team-name>.cloudflareaccess.com`
   - 承認済みのリダイレクト URI: `https://<your-team-name>.cloudflareaccess.com/cdn-cgi/access/callback`
2. `Client ID`と`Client Secret`を控える
3. 手順3.2で作成する`terraform/terraform.tfvars`の`google_oauth_client_id`と`google_oauth_client_secret`に設定する

TerraformがGoogle IdPをCloudflare Zero Trustへ登録し、Access ApplicationではこのIdPだけを許可する。

### 2.3 Cloudflare API Tokenの発行

Terraform用のAPI Tokenを発行する。必要な最小権限は次のとおり。

| スコープ | 権限                                                         |
| -------- | ------------------------------------------------------------ |
| Account  | `Cloudflare Tunnel:Edit`                                     |
| Account  | `Access: Apps and Policies:Edit`                             |
| Account  | `Access: Organizations, Identity Providers, and Groups:Edit` |
| Zone     | `Zone:Read`                                                  |
| Zone     | `DNS:Edit`（対象ゾーンを含む）                               |

発行したトークンをパスワードマネージャーなどへ保管し、手順3.2で作成するGit管理対象外の`terraform/terraform.tfvars`にある`cloudflare_api_token`へ設定する。Terraformは`.env`や1Passwordからインフラ設定を読み取らない。

`terraform.tfvars`とTerraform stateには秘密情報が含まれる。どちらもGitへ追加せず、ローカルディスクの暗号化とファイル権限`600`を維持する。

### 2.4 公開設定と既存リソースの確認

以下を決めておく。

- Cloudflareのゾーン（例: `example.com`）
- 公開するホスト名（例: `dashboard.example.com`）
- Cloudflare Accessで許可するメールアドレス

`terraform apply`の前に、Cloudflare上に同じホスト名のDNSレコードや、同名のTunnel、Access Application、Google IdPがないことを確認する。既存リソースを継続利用する場合は、重複作成せずTerraformへインポートする。

## 3. セットアップ

### 3.1 アプリ設定

`.env`を作成する。

```sh
cp .env.example .env
openssl rand -hex 32
```

この時点では、次の値を`.env`へ設定する。

```dotenv
OP_SERVICE_ACCOUNT_TOKEN=<1Password Service Accountのトークン>
OP_VAULT=<保管庫名またはUUID>
OP_ITEM=<項目名またはUUID>
OP_TOTP_FIELD=<TOTPフィールド名またはID>
REFRESH_TOKEN=<openssl rand -hex 32の出力>
CLOUDFLARE_ACCESS_TEAM_DOMAIN=<team-name>.cloudflareaccess.com
DASHBOARD_URL=https://dashboard.example.com
```

`REFRESH_TOKEN`はcrawlerとwebが共有するアプリ用の認証情報であり、Terraformでは管理しない。`CLOUDFLARE_ACCESS_TEAM_DOMAIN`にはCloudflare Zero Trustで確認したTeam domainを指定する。`DASHBOARD_URL`には、このあとTerraformの`hostname`へ指定する公開URLを設定する。

`CLOUDFLARE_ACCESS_AUD`はまだ空のままでよい。Access Applicationの作成後に確定するため、Terraform適用後の手順3.3で設定する。

| `.env`のキー                                 | 必須 | 設定タイミング       | 内容                                                                             |
| -------------------------------------------- | ---- | -------------------- | -------------------------------------------------------------------------------- |
| `REFRESH_TOKEN`                              | 必須 | Terraform適用前      | crawlerとwebが共有する内部API用Bearerトークン                                    |
| `CLOUDFLARE_ACCESS_TEAM_DOMAIN`              | 必須 | Terraform適用前      | Access JWTの発行者となる`<team-name>.cloudflareaccess.com`                       |
| `CLOUDFLARE_ACCESS_AUD`                      | 必須 | Terraform適用後      | Terraformが作成したAccess ApplicationのAUD                                       |
| `DASHBOARD_URL`                              | 必須 | Terraform適用前      | Open Graph / Twitter metadataと通知に使う公開ダッシュボードURL                   |
| `OP_SERVICE_ACCOUNT_TOKEN`                   | 必須 | Terraform適用前      | 1Password Service Accountのトークン                                              |
| `OP_VAULT` / `OP_ITEM` / `OP_TOTP_FIELD`     | 必須 | Terraform適用前      | Money Forward MEの保管先。日本語を含む場合はUUIDを指定                           |
| `AI_PROVIDER` / `AI_MODEL` / `AI_API_KEY`    | 任意 | 機能を有効にするとき | 財務インサイト、家計AIチャット、LLMカテゴリ推論。利用する機能では3項目すべて必須 |
| `SLACK_BOT_TOKEN` / `SLACK_CHANNEL_ID`       | 任意 | 通知を有効にするとき | Slack通知                                                                        |
| `DISCORD_WEBHOOK_URL` / `DISCORD_AVATAR_URL` | 任意 | 通知を有効にするとき | Discord通知                                                                      |
| `HOST_UID` / `HOST_GID`                      | 任意 | Compose起動前        | Linuxで`./data`とTunnel tokenを所有するユーザーのUIDとGID。既定値は`1000:1000`   |
| `AUTH_STATE_PATH`                            | 任意 | ローカル実行時       | ローカル実行時のブラウザーセッション保存先。Docker Composeでは設定しない         |

Linuxでは`id -u`と`id -g`で値を確認し、`1000:1000`と異なる場合は`.env`の`HOST_UID`と`HOST_GID`へ設定する。web、crawler、cloudflaredが同じUID/GIDで動作し、`./data`とowner-read-onlyのTunnel tokenへ必要な範囲だけアクセスする。

#### 1PasswordのIDを確認する

1Password SDKは日本語の保管庫名や項目名を扱えないため、日本語を含む場合はUUIDを使う。

- `OP_VAULT`: サイドバーで保管庫を右クリックし、「UUIDをコピー」を選ぶ
- `OP_ITEM`: アイテム画面右上のメニューから「UUIDをコピー」を選ぶ
- `OP_TOTP_FIELD`: 同じメニューの「アイテムのJSONをコピー」を選び、`u`の値が`TOTP_`で始まるフィールドIDを取り出す

### 3.2 インフラ設定

Cloudflare API TokenとGoogle OAuth clientを用意したら、Git管理対象外のインフラ設定ファイルを作成する。

```sh
cp terraform/terraform.tfvars.example terraform/terraform.tfvars
chmod 600 terraform/terraform.tfvars
```

`terraform/terraform.tfvars`に実値を設定する。

```hcl
cloudflare_api_token       = "..."
google_oauth_client_id     = "..."
google_oauth_client_secret = "..."

zone_name = "example.com"
hostname  = "dashboard.example.com"

allowed_emails = [
  "user-a@example.com",
]
```

`terraform/terraform.tfvars`、Terraform state、`secrets/cloudflared-token`はGit管理対象外。秘密情報を含むため、内容を表示したりコミットしたりしない。

### 3.3 インフラの適用

Terraformを初期化し、インフラを適用する。

```sh
terraform -chdir=terraform init
terraform -chdir=terraform apply
```

適用後にTerraformの出力とTunnelトークンファイルを確認する。

```sh
terraform -chdir=terraform output
ls -l secrets/cloudflared-token
```

`tunnel_id`、`tunnel_cname_target`、`hostname`、`google_identity_provider_id`、`access_application_aud`が出力され、`secrets/cloudflared-token`の権限が`-r--------`（mode `400`）なら成功。

Access ApplicationのAUDを取得する。

```sh
terraform -chdir=terraform output -raw access_application_aud
```

表示された値を`.env`の`CLOUDFLARE_ACCESS_AUD`へ設定する。前後に引用符や空白は付けない。

```dotenv
CLOUDFLARE_ACCESS_AUD=<上のコマンドで表示された値>
```

`Output "access_application_aud" not found`と表示された場合、現在のTerraform stateにはoutputがまだ反映されていない。特に以前のバージョンから更新した環境では、最新コードで再度`terraform plan`を確認してから`terraform apply`し、outputをstateへ反映する。Access Applicationを新規作成した直後も、`apply`が最後まで成功していることを確認する。

### 3.4 Docker Composeの起動

ビルド前にComposeの設定を検証する。

```sh
docker compose config --quiet
docker compose build
docker compose up -d
```

`docker compose config --quiet`が何も表示せず終了すれば、Composeが必要とする環境変数は設定済みである。`required variable ... is missing a value`と表示された場合は、メッセージに示されたキーが`.env`に存在し、`=`の右側が空でないことを確認する。

Terraformの適用が成功し、`secrets/cloudflared-token`が作成されたことを確認してからDocker Composeを起動する。`dc`などのシェルエイリアスは環境によって存在しないため、このガイドでは正式な`docker compose`コマンドを使用する。

以降はcrawlerコンテナ内のsupercronicが`crontab`のスケジュールで自動更新する。

各コンテナの役割は次のとおり。

- **migrate**: 起動時に共有データベースへマイグレーションを適用し、完了後に終了する
- **web**: ダッシュボードを配信し、共有データベースを読み取る
- **cloudflared**: Cloudflare Tunnelへ接続する
- **crawler**: 定期更新と手動更新を受け付け、取得したデータを共有データベースへ保存する

スケジュールを変更する場合は`docker/crawler/crontab`を編集し、`docker compose build crawler`でcrawlerを再ビルドする。

### 3.5 TunnelとAccessの動作確認

```sh
docker compose ps
docker compose logs -f
```

以下を確認する:

- `docker compose ps --all`で`migrate`が`Exited (0)`、ほかの3サービスが`Up`になっている
- ログに認証エラーやTunnel接続エラーがない
- 未ログインで`https://<hostname>/`へアクセスするとGoogleログインへ移動する
- 許可したアカウントではダッシュボードが表示される
- 許可していないアカウントではアクセスが拒否される
- Google以外のログイン方法が表示されない

```sh
# Cloudflare Access経由の応答を確認
curl -I https://<hostname>/
# → 302 + Location が <team-name>.cloudflareaccess.com 配下なら Access 動作中

# Terraform管理中のTunnel IDを確認
terraform -chdir=terraform output -raw tunnel_id
```

## 4. 運用

- **ホストを再起動する**: Docker Desktopの自動起動後、`restart: unless-stopped`を設定した各コンテナも自動復帰する
- **イメージを再ビルドする**: `docker compose build && docker compose up -d`
- **crawlerをすぐに実行する**: `docker compose exec crawler pnpm --filter @mf-dashboard/crawler start`
- **webの表示だけを更新する**: `docker compose exec crawler sh -c 'curl -fsS -X POST -H "Authorization: Bearer ${REFRESH_TOKEN}" "http://web:8765${NEXT_PUBLIC_BASE_PATH}/api/refresh/"'`

## 5. オプション設定

ここからの設定は、基本セットアップの完了後に必要なものだけ追加する。

### Slack通知

1. [Slack API](https://api.slack.com/apps)でBotを作成し、`xoxb-`から始まるトークンを発行する
2. Botへ`chat:write`権限を付与し、投稿先チャンネルへ招待する
3. `.env`の`SLACK_BOT_TOKEN`と`SLACK_CHANNEL_ID`を設定する

### Discord通知

1. 通知先チャンネルの「連携サービス」からIncoming Webhookを作成する
2. `.env`の`DISCORD_WEBHOOK_URL`へ、発行された`https://discord.com/api/webhooks/...`形式のURLを設定する

### 財務インサイトと家計AIチャット

財務インサイトと家計AIチャットを利用する場合は、`.env`に次の3項目を設定する。いずれかが空の場合、財務インサイトは生成されず、チャットUIも表示されない。

```dotenv
AI_PROVIDER=openai
AI_MODEL=<provider-model-id>
AI_API_KEY=<provider-api-key>
```

- `AI_PROVIDER`: `openai`、`anthropic`、`google`のいずれか
- `AI_MODEL`: 選択したプロバイダーで利用可能なモデルID
- `AI_API_KEY`: 選択したプロバイダーのAPIキー。ブラウザーへは公開せず、`.env`だけに保存する

ローカルでデモデータを使って確認する場合は、リポジトリルートで次を実行する。

```sh
pnpm install
pnpm --filter @mf-dashboard/db build:demo
DB_PATH=../../data/demo.db pnpm --filter @mf-dashboard/web dev
```

`pnpm build:demo`で生成する静的な公開デモにはAPI routeが含まれないため、家計AIチャットの確認には使用しない。

Docker Composeで設定を反映する場合は、webイメージを再ビルドして起動する。

```sh
docker compose build web
docker compose up -d web
```

起動後、ダッシュボード右下の「家計AIチャットを開く」ボタンを選び、質問を入力して送信する。チャットは現在のDrizzleスキーマから利用可能なテーブルとカラムを取得し、選択中のグループへread-only SQLを実行する。回答は本文として表示され、ユーザーが画面表示や遷移先を明示的に求めた場合だけ、検証済みのダッシュボード内部リンクを含む。該当データがない場合は、条件を勝手に変更したり金額を推測したりしない。

チャットの質問と、回答に必要な家計データは設定したAIプロバイダーへ送信される。会話はブラウザーのストレージへ保存されないが、AIプロバイダー側のデータ取扱方針を確認し、送信を許可できる場合だけ有効にする。本番環境では、Cloudflare Accessで認証された利用者だけがダッシュボードへアクセスできる構成を維持する。

回答生成に失敗した場合はチャット内にエラーが表示される。まず3つのAI環境変数、APIキーの権限・利用上限、モデルIDを確認する。家計データが未取得の場合はcrawlerを実行してから再度質問する。

#### Agent Observability

Grafana Cloud Agent ObservabilityへLLM generationを、同じGrafana CloudのOTLP endpointへtrace/metricを送る場合は、デプロイ先の`.env`へ次の値を設定する。API tokenはソース管理へ追加しない。

```dotenv
AGENTO11Y_ENDPOINT=https://agento11y-prod-ap-northeast-0.grafana.net
AGENTO11Y_PROTOCOL=http
AGENTO11Y_AUTH_MODE=basic
AGENTO11Y_AUTH_TENANT_ID=<instance-id>
AGENTO11Y_AUTH_TOKEN=<agent-observability-api-token>
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-prod-ap-northeast-0.grafana.net/otlp
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic <base64-tenant-and-token>
```

`OTEL_EXPORTER_OTLP_HEADERS`は`printf '%s' '<instance-id>:<token>' | base64 | tr -d '\n'`で作成する。これらの環境変数はwebとcrawlerの両コンテナへ渡され、家計AIチャット・財務インサイト・AIカテゴリ分類のgenerationをAgent ObservabilityとOTLPの両方へ送る。無効化する場合は7項目を`.env`から削除し、webとcrawlerを再起動する。

ローカルの SQLite データを MCP クライアントから直接参照する場合は、read-only の MCP サーバーを利用できる。セットアップとクライアント設定は [`apps/mcp/README.md`](../apps/mcp/README.md) を参照する。

### 未分類取引のカテゴリ決定

`data/category-rules.json`を作成すると、crawlerはデータベースへ保存する前に、新規の未分類取引へカテゴリを設定する。ファイルが存在しない場合、この機能は無効になり、取引を未分類のまま保存する。既存データは月別収支ページの「未分類をAI分類」から対象月だけを再処理できる。設定済みルール/LLMでMoneyForward MEのカテゴリを更新した後、その月の明細を再取得する。

```sh
cp data/category-rules.example.json data/category-rules.json
```

設定例:

```json
{
  "llm": {
    "enabled": false,
    "maxPerRun": 5,
    "minConfidence": 0.65
  },
  "rules": [
    {
      "accountName": "テスト口座",
      "category": "食費",
      "subCategory": "食料品"
    },
    {
      "descriptionContains": "動画サービス",
      "category": "趣味・娯楽",
      "subCategory": "動画・音楽"
    }
  ]
}
```

#### 固定ルール

- 通常の自動処理の対象は「新規」「未分類」「非振替」「計算対象」の取引のみ
- 月別ページから明示的に再処理した場合は、対象月の既存「未分類」取引も含める
- `accountName`は取引の口座名と完全一致する
- `descriptionContains`は取引内容と部分一致する
- 両方を指定した場合は、両条件に一致する取引だけを対象にする
- 固定ルールに一致した場合はそのカテゴリを優先し、LLMを呼び出さない
- `category`または`subCategory`がMoney Forward MEの候補に存在しない場合、そのルールを採用しない

#### LLMによる推論

固定ルールに一致しなかった取引だけをLLMで推論する場合は、`llm.enabled`を`true`へ変更し、`.env`に`AI_PROVIDER`、`AI_MODEL`、`AI_API_KEY`を設定する。

- Money Forward MEから取得した候補カテゴリの中から選択し、カテゴリIDは生成しない
- 通常のcrawler実行と月単位の分類では、`llm.maxPerRun`がAIへのリクエスト数を制限する。既定値は`5`。1リクエストで最大20件をまとめて分類する
- 明示的な全月一括分類では、このリクエスト上限を適用せず、DB内の既存明細を使って分類する。Money Forwardから月次履歴を再取得しない
- Anthropic利用時は固定指示とカテゴリ候補に5分間のプロンプトキャッシュを設定する。取引データはキャッシュ境界の後ろに置き、全月一括実行のログに読み書きトークン数を出す
- 推論結果の確信度が`llm.minConfidence`未満の場合は反映しない。既定値は`0.65`
- 取引の日付、種別、金額、内容、候補カテゴリのIDと名称を外部プロバイダーへ送信する
- 更新に失敗してもcrawlerは停止せず、対象取引を未分類のまま保存する

採用したカテゴリはMoney Forward MEの`/cf/update`へ反映する。その後、対象月を再取得してデータベースへ保存する。外部プロバイダーへ取引情報を送信してよい場合だけ、LLMによる推論を有効にする。

### PayPay 取引履歴の自動取込

PayPay の非公開 API から取引履歴 CSV を取得し、Money Forward ME の「PayPay」「PayPayカード」口座へ取り込む。API を利用するため**ログインだけは実 Chrome が必要**で、この工程は Mac 側で行う。以降の取得・取込は crawler コンテナが毎日 07:00（JST）に自動実行する。

#### 1Password にトークン項目を作る

`OP_VAULT`と同じ保管庫に、PayPay のトークンを保管する項目を作る。

- 項目の種類: `Login`または`Password`（任意）
- 項目名: `OP_PAYPAY_ITEM`に設定する値（例: `PayPay`）
- フィールド: `OP_PAYPAY_FIELD`（既定`tokens`）という名前のテキスト/Concealedフィールド

サービスアカウントにその項目への書き込み権限があると、refresh後のトークンが自動で書き戻される。読み取りのみでも動作するが、その場合はトークンの更新を手動で行う必要がある。

`.env`へ次を追加する。

```dotenv
OP_PAYPAY_ITEM=PayPay
OP_PAYPAY_FIELD=tokens
```

#### Mac でログインする（初回・失効時のみ）

1Passwordの項目へ1回ログインしたトークンを保存すれば、以降はrefreshで延命される。

```sh
# 認可ページを開く（実 Chrome が必要）
pnpm --filter @mf-dashboard/crawler exec tsx --env-file=../../.env scripts/paypay-fetch.ts login:start

# SMS に届く 4 桁を渡す（自動で 1Password に保存）
pnpm --filter @mf-dashboard/crawler exec tsx --env-file=../../.env scripts/paypay-fetch.ts login:otp 1234
```

#### サーバーでの動作

crawlerコンテナ内のsupercronicが`docker/crawler/crontab`のスケジュールで毎日07:00に実行する。手動で今すぐ実行する場合は次のコマンドを使う。

```sh
# 取得のみ（CSV を確認）
docker compose exec -w /app/apps/crawler crawler node --import tsx scripts/paypay-sync.ts --dry-run
# 取得 + 取込
docker compose exec -w /app/apps/crawler crawler node --import tsx scripts/paypay-sync.ts
```

- 手元（Mac）では `pnpm --filter @mf-dashboard/crawler sync:paypay` も使える（`--env-file` を読むため）

- 取得は直近35日のローリング窓でレポートを作り直す。取込は取引番号で重複排除する
- スケジュールを変更する場合は`docker/crawler/crontab`を編集し、`docker compose build crawler`でcrawlerを再ビルドする
- ログイン（実 Chrome）はデプロイ先のホストでは行えないため、トークンが失効した場合はローカルで再ログインして1Passwordを更新する

### FamiPay の残高・利用履歴の取込

ファミペイ Android アプリ（`jp.co.family.familymart_app`）の非公開 API を直接呼び、残高と利用履歴を取得する。アプリの静的解析で判明した仕様は次のとおり。

- すべて `https://famipay.family.co.jp/` への `application/x-www-form-urlencoded` の POST
- ただし `api/public/v1/...` 系（`getZandaka`、`authenticationCheck`）だけは `https://hcsep.famipay.family.co.jp/` にある
- 共通フィールドは `API_ENCRYPTION_KEY`（固定値）と `LOGIN_TERMINAL_ID`（端末識別子。端末 attestation ではなく任意の値でよい）
- 残高は `api/public/v1/getZandaka`（`MN_ZNDK` が残高、`PT_ZNDK` がボーナス、`ATOBARAI_ZNDK` があと払い）
- 履歴は `api/public/listFamipayHistory.jsp`、金額の内訳は明細 1 件ごとに `api/public/generateFamipayHistoryDetail.jsp`

認証は `KAIIN_HASH_KEY` を使うが、その初回発行だけは Web ログイン（`webview/login.html`）の遷移先 URL に載る `APPLICATION_AUTHENTICATION_TOKEN` から `api/public/acquireMemberInformation.jsp` を叩いて得る。**毎回のログインで SMS のワンタイムコード入力が必要**なため、この工程だけは実 Chrome で人が操作する。

#### 1Password に認証情報項目を作る

`OP_VAULT`と同じ保管庫に、ファミペイのログイン情報を保管する項目を作る。

- 項目の種類: `Login`または`Password`（任意）
- 項目名: `OP_FAMIPAY_ITEM`に設定する値（例: `FamiPay`）
- フィールド: `username`に**電話番号（11桁・ハイフンなし）**、`password`にパスワード

ログインフォームは電話番号とパスワードだけを求める（メールアドレスや会員番号ではない）。

`.env`へ次を追加する。

```dotenv
OP_FAMIPAY_ITEM=FamiPay
OP_FAMIPAY_VAULT=apps
```

#### ログインの仕組み（実物で確認済み）

`webview/login.html` の中身は次のとおり。

- 入力欄は `input[name="CP_NO"]`（電話番号）と `input[name="KAIIN_PASSWD"]`（パスワード）の 2 つ
- `LOGIN_HASH` はページ側の JS が `MD5(電話番号 + パスワード + "login_hash_seed")` で組み立てるので、値はそのまま入力すればよい
- 「ログイン」ボタン（`button.buttonPrimary`）は `send_with_sms()` を呼び、**必ず SMS 認証**へ進む
- 認証が通ると `APPLICATION_AUTHENTICATION_TOKEN` が
  `/webview/appaction.html?DESTINATION=...&APPLICATION_AUTHENTICATION_TOKEN=...`
  として URL に載る。アプリはこの URL を WebViewClient で拾っている（`LoginPresenterImpl.onReceiveQueryParam`）

SMS の送信回数は cookie で数えており、上限を超えると一時的に送れなくなる。ログインボタンは連打しないこと。

#### 残高と履歴を取得する

ブラウザは常駐させて 1 つだけ使う（毎回起動・終了しない）。先に常駐ブラウザを起こしておくと、以降のスクリプトは CDP でそこへ接続する。

```sh
# 常駐ブラウザを起動（Ctrl+C で終了するまで常駐）
npx tsx --env-file=../../.env apps/crawler/scripts/famipay-browser.ts

# 直近60日を取得（セッションが無効なら、常駐ブラウザでログインが始まる）
pnpm --filter @mf-dashboard/crawler famipay:fetch

# 期間を指定。--no-detail を付けると明細APIを叩かず履歴一覧だけ取る
pnpm --filter @mf-dashboard/crawler exec tsx --env-file=../../.env scripts/famipay-fetch.ts --from 20260101 --to 20260131
```

1Password の値が自動入力され、「ログイン」も自動で押される。SMS に届くワンタイムコードだけ手で入力する。セッションは `data/famipay-session.json`、ブラウザのプロファイルは `data/famipay-profile` に保存される。

取得結果は `data/famipay-balance.json` と `data/famipay-history.json` へ出力する。同時に取引の種類ごとの収入・支出の件数を表示するので、金額の向きの解釈が正しいかを確認できる。

#### Money Forward ME への取込

手動口座「ファミペイ」（区分はモバイルSuica と同じ `電子マネー・プリペイド`）を作り、履歴を収支として登録したうえで、残高を実際の値へ補正する。

取引の向きは `TORIHIKI_KBN` で決まる（1=支払い、2=チャージ、3=返金、9=その他）。金額は `MONEY_CASH + MONEY_PREPAID` を使う。これらはアプリの明細画面の実装（`DetailActivity` / `FamipayHistoryEntryModel`）と一致する。

```sh
# dry-run（取得と表示のみ）
pnpm --filter @mf-dashboard/crawler sync:famipay

# MF へ登録
pnpm --filter @mf-dashboard/crawler sync:famipay -- --apply

# 口座を作り直して全再取込
pnpm --filter @mf-dashboard/crawler sync:famipay -- --apply --reset
```

明細 API は 1 件 1 リクエストなので、結果を `data/famipay-details.json` に貯めて再利用する。取り直したいときは `--refresh-details` を付ける。取込済みの ID は `data/famipay-synced-ids.json` に記録し、二重登録を防ぐ。

`あと払い`（`ATOBARAI_ZNDK`）は取得しているが取り込んでいない。必要になったら口座を分けて追加する。

チャージは同期直後は「収入」として登録される。そのままだと家計簿上も収入として計上されるため、PayPay と同じく「PayPayカード → ファミペイ」の振替に直す。MF の画面操作（`enable_transfer` → 振替元の設定）を自動化している。

同時に、カード側に残る同額の支出（「ＦａｍｉＰａｙチャージ」）を計算対象外にする。振替にしただけだと、カード側の支出がそのまま家計簿の支出として残り、チャージ分が二重に引かれるため。明細は残したまま集計から外す。

```sh
# dry-run（対象の一覧のみ）
pnpm --filter @mf-dashboard/crawler famipay:fix-charges

# 振替に直す
pnpm --filter @mf-dashboard/crawler famipay:fix-charges --apply
```

振替元は、同じ日・同じ金額の支出が別口座にある場合にその口座を使う（既定は `PayPayカード`）。ファミペイ口座の残高は変えずに、収入の二重計上だけを外す。

### モバイルSuica 利用履歴の取込

モバイルSuica の SF（電子マネー）利用履歴を取得し、Money Forward ME の手動口座「モバイルSuica」へ取り込む。JRE ID へのログインはパスキー（1Password 保管）と CDP の WebAuthn 仮想認証器で自動化しており、**crawler コンテナが毎日 07:10（JST）に自動実行する**。

#### 1Password にパスキー項目を作る

`OP_VAULT`と同じ保管庫に、JRE ID のパスキーを保管する項目を作る。

- 項目名: `SUICA_OP_ITEM`に設定する値（既定`JRE ID passkey (Suica)`）
- 保管庫: `SUICA_OP_VAULT`に設定する値（既定`apps`）
- フィールド: `credentialId` `privateKey` `rpId` `userHandle` `signCount` `discoverable` `username`（`username`は任意）

パスキーは 1Password SDK（`OP_SERVICE_ACCOUNT_TOKEN`）→ `op` CLI → Bitwarden CLI（`BW_SESSION`があるとき）→ Bitwarden エクスポート（`--export`または`JRE_EXPORT`。既定は`~/Downloads`の最新`bitwarden_export_*.json`）の順に探す。コンテナは SDK 経路を使う。

#### サーバーでの動作

crawlerコンテナ内のsupercronicが`docker/crawler/crontab`のスケジュールで毎日07:10に実行する。手動で今すぐ実行する場合は次のコマンドを使う。

```sh
# 取得と表示のみ
docker compose exec -w /app/apps/crawler crawler node --import tsx scripts/suica-sync.ts
# 取得 + 取込
docker compose exec -w /app/apps/crawler crawler node --import tsx scripts/suica-sync.ts --apply
```

- 取込先は手動口座「モバイルSuica」（区分は`電子マネー・プリペイド`）。無ければ作成する
- 履歴は直近190日を、指定日から遡って最大100件ずつ取得する。取得後、明細から現在残高を再計算し Suica 表示の残高と突き合わせる
- 履歴を表示できるのは 5:00〜翌0:50 のみ。スケジュールはこの窓の内側に置く
- スケジュールを変更する場合は`docker/crawler/crontab`を編集し、`docker compose build crawler`でcrawlerを再ビルドする

#### ローカル（Mac）で実行する

Playwright 同梱の Chromium を headless で使うので、実 Chrome は不要。永続ブラウザを起動しておけば CDP で再利用する（画面を見たいときは`HEADED=1`）。

```sh
pnpm --filter @mf-dashboard/crawler exec tsx scripts/suica-browser.ts   # 常駐ブラウザ（HEADED=1 で画面あり）
pnpm --filter @mf-dashboard/crawler sync:suica -- --apply               # 取得 + 取込
```

- ログイン確認だけなら`scripts/suica-login.ts`、履歴ページの構造調査は`scripts/suica-history.ts`を使う

### enひかり電気料金の按分

enひかり電気の料金は enひかり本体（光回線）と合算され、NTT東日本の「光コラボ回収代行分」としてカードに月1件で計上される。そのままだと家計簿上は全額が通信費になるため、次の3つを行う。

1. 電気代の明細を「支出元なし」で登録する（分類: 水道・光熱費 / 電気代）
2. 残り（光回線など）の明細を「支出元なし」で登録する（分類: 通信費 / インターネット）
3. 元のカード明細を計算対象外にする（カードの残高と支出合計は変わらない）

#### 1Password に認証情報項目を作る

`OP_VAULT`と同じ保管庫に、enひかり電気の会員ページの認証情報を保管する項目を作る。

- 項目名: `OP_ENHIKARI_ITEM`に設定する値（既定`enhikari.jp`）
- 保管庫: `OP_ENHIKARI_VAULT`に設定する値（既定`apps`）
- フィールド: `username`（お客様ID）、`password`

#### 実行

```sh
# 会員ページのご利用明細から按分ファイルを作る（電気代を月ごとに取り直す）
pnpm --filter @mf-dashboard/crawler sync:enhikari
# 計画を確認（dry-run）
pnpm --filter @mf-dashboard/crawler sync:enhikari-alloc -- ~/.local/share/mf-dashboard/enhikari-alloc.json
# 反映
pnpm --filter @mf-dashboard/crawler sync:enhikari-alloc -- ~/.local/share/mf-dashboard/enhikari-alloc.json --apply
```

- 按分ファイルには個人の請求額が入るためリポジトリの外に置く（既定`~/.local/share/mf-dashboard/enhikari-alloc.json`）
- 会員ページの明細は過去24か月分。**明細の月 + 2か月後**のカード請求に対応する（例: 2026年7月分の明細 → 2026-09-24の請求）
- 電気代は enひかり電気の税込合計を四捨五入した額、残りが光回線分になる（実測で光回線分は月5,576円前後）
- 会員ページの明細が無い月は何もしない。`--only 2026-07,2026-08`で月を絞れる
- 反映は再実行できる。按分の明細が既にあれば登録せず、元の明細を計算対象外にするだけになる
- 元の明細だけが計算対象外になっている月（按分が欠けた状態）は、按分の明細を作り直す
- `--apply`は元の明細を外す前に、登録した2件が明細に出ているかを読み直して確認する。片方でも欠けていれば外さない
- 明細の登録は`updated_at`が`YYYY/MM/DD`でないと MF 側で黙って捨てられる。スクリプトはこの形式に変換して送る

#### サーバーでの動作

毎月の手動実行を前提にしており、`docker/crawler/crontab`には入れていない。翌月のカード請求が出たあとに次を実行する。

```sh
docker compose exec -w /app/apps/crawler crawler node --import tsx scripts/enhikari-billing.ts
docker compose exec -w /app/apps/crawler crawler node --import tsx scripts/enhikari-alloc.ts /app/data/enhikari-alloc.json --apply
```
