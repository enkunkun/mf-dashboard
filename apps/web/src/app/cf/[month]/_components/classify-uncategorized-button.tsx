"use client";

import { Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "../../../../components/ui/button";
import { withBasePath } from "../../../../lib/base-path";
import { parseCrawlerRefreshStatus } from "../../../../lib/crawler-refresh-status";

export function ClassifyUncategorizedButton({
  month,
  allMonths = false,
}: {
  month?: string;
  allMonths?: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [started, setStarted] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!started) return;
    const events = new EventSource(withBasePath("/api/crawler/refresh/"));
    events.onmessage = (event) => {
      try {
        const status = parseCrawlerRefreshStatus(JSON.parse(event.data) as unknown, true);
        if (status.running || !status.latestRun) return;

        setStarted(false);
        setMessage(
          status.latestRun.runStatus === "success"
            ? "分類と再取り込みが完了しました。"
            : "分類に失敗しました。更新アイコンから詳細を確認してください。",
        );
        events.close();
        router.refresh();
      } catch {
        // Ignore malformed progress events; the header control reports stream errors.
      }
    };
    return () => events.close();
  }, [router, started]);

  async function classify() {
    if (
      !window.confirm(
        allMonths
          ? "データがある全期間の未分類明細を設定済みの分類ルール/AIで処理します。AIを使う場合、明細の日付・種別・内容・金額とカテゴリ候補をAIプロバイダーへ送信します。分類結果はMoneyForward MEへ反映し、各月を順番に再取り込みします。続けますか？"
          : "この月の未分類明細を設定済みの分類ルール/AIで処理します。AIを使う場合、明細の日付・種別・内容・金額とカテゴリ候補をAIプロバイダーへ送信します。分類結果はMoneyForward MEへ反映し、その後この月を再取り込みします。続けますか？",
      )
    ) {
      return;
    }
    setPending(true);
    setMessage("");
    try {
      const response = await fetch(withBasePath("/api/crawler/refresh/"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(allMonths ? { allMonths: true } : { month }),
          categorizeUncategorized: true,
        }),
      });
      if (!response.ok) {
        setMessage(
          response.status === 409
            ? "同期処理が実行中です。完了後に再試行してください。"
            : "分類を開始できませんでした。",
        );
        return;
      }
      setStarted(true);
      setMessage("分類と再取り込みを開始しました。進行状況は右上の更新アイコンで確認できます。");
    } catch {
      setMessage("接続に失敗しました。再試行してください。");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button type="button" variant="outline" onClick={classify} disabled={pending || started}>
        <Sparkles aria-hidden="true" />
        {pending
          ? "開始中…"
          : started
            ? "分類を開始済み"
            : allMonths
              ? "未分類を全期間一括処理"
              : "未分類をAI分類"}
      </Button>
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {message ||
          (allMonths
            ? "データがある全期間を順番に処理します。LLM判定数は実行全体で設定上限に従います"
            : "設定済み分類ルール/LLMを使用します。LLM判定数は設定上限に従います")}
      </p>
    </div>
  );
}
