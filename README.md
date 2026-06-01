# LINE x Square 予約確認ボット

LINEでお客様が自分のSquare予約を確認できる最小プロトタイプです。

## できること

- LINE Webhookを受け取る
- LINE署名を検証する
- 初回だけ「名前 + 電話番号下4桁」で本人確認する
- LINEユーザーIDとSquare顧客IDを保存する
- 次回以降は「予約確認」で今後の予約を返信する

## 使い方

1. `settings.env` にLINEとSquareの値を入れます。
2. 起動します。

```bash
npm start
```

3. LINE DevelopersのWebhook URLに以下を設定します。

```text
https://あなたの公開URL/webhook
```

ローカルで試す場合はngrokなどで `http://localhost:3000` を外部公開してください。
手元でだけ動かす場合は `.env` の `HOST` を `127.0.0.1` にしても大丈夫です。

## LINEでの使い方

初回:

```text
予約確認
```

ボットが本人確認を求めます。

```text
山田花子 1234
```

Square顧客情報と一致したら、今後の予約を返信し、LINEユーザーとSquare顧客IDを紐づけます。

2回目以降:

```text
予約確認
```

だけで確認できます。

## Square側で必要な権限

- `CUSTOMERS_READ`
- `APPOINTMENTS_READ`
- 店舗側の予約全体を読む場合は `APPOINTMENTS_ALL_READ` も必要です。

Square Bookings APIの `List bookings` は、`customer_id` で予約を絞り込めます。

## 注意

名前だけで予約を返す運用はおすすめしません。同姓同名やなりすましの危険があるため、このプロトタイプでは「名前 + 電話番号下4桁」で初回確認します。
