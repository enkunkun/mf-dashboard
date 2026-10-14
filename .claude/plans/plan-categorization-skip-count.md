# AI 分類の反映件数と判定見送り件数を見せる

## 背景

AI 分類ボタンの完了表示は「分類と再取り込みが完了しました。」だけである。
LLM が decisions に含めなかった明細と、confidence が `minConfidence` 未満の明細は黙って捨てられるため、未分類が残ると失敗に見える。
2026-10-14 の全期間処理では 2,286 件中 693 件を反映し、1,593 件を見送った。
crawler のログも `Applied category decisions: N/M` の分母が「判定できた件数」で、見送りが数に出ない。

## spec

- 判定エンジンは、LLM に送った明細のうち次の 2 つを見送りとして数える。
  - 判定が返らなかった（decisions に index が無い、単発判定で null）: `skippedUndecided`
  - confidence が `minConfidence` 未満: `skippedLowConfidence`
  - LLM 呼び出しの失敗は見送りに数えない（既存の warn のまま）。
- MoneyForward に反映できた件数を `appliedDecisions` として数える。件数は実行全体の `CategoryDecisionUsage` に積む。
- crawler は月ごとに `info()` で「反映 N 件・見送り M 件（低 confidence L 件・判定なし U 件）」を出す。分類対象があった月だけ出す。
- 未分類分類の実行（`categorizeUncategorized` 付きの `month`・`months`・`allMonths`）は、終了時に実行状態へ `categorization: { applied, skipped }` を記録し、合計を `info()` で出す。
- 実行状態の `categorization` は省略できる（古い状態ファイルと分類なしの実行）。形が不正なら状態全体を不正として扱う（既存の検証と同じ方針）。
- web は表示にしか使わないので、`categorization` の形が不正なら欄だけ落として実行状態は読む。
- web の AI 分類ボタンは、成功時に `categorization` があれば「分類と再取り込みが完了しました。反映 N 件 / 判定見送り M 件」と出す。無ければ従来の文言のまま。

## テストリスト

- [x] engine（バッチ）: confidence 未満を `skippedLowConfidence` に数える
- [x] engine（バッチ）: 判定が返らなかった明細を `skippedUndecided` に数える
- [x] engine（単発）: null と confidence 未満を同じく数える
- [x] categorize: 反映件数を `appliedDecisions` に積み、月ごとの info に反映と見送りを出す
- [x] progress: `recordCategorization` が状態に `categorization` を書き、状態ファイルの検証が受け入れる（省略可、不正な形は拒否）
- [x] run: 未分類分類の実行は usage の件数を `categorization` に記録する
- [x] web: `parseCrawlerRefreshStatus` が `categorization` を読み、省略時は無しとして扱う
- [x] web: ボタンの完了表示に反映件数と見送り件数を出す
