import { describe, expect, it } from "vitest";
import {
  classifyFamipayEntry,
  classifyFamipayRow,
  extractApplicationAuthToken,
  famipayApiUrl,
  famipayEntryContent,
  famipayEntryKey,
  needsFamipayDetail,
  parseHistoryDetail,
  parseHistoryPage,
  parseMemberInformation,
  parseTransactionKind,
  parseZandaka,
  toMoneyForwardDate,
  type FamipayHistoryRow,
} from "./famipay.js";

describe("famipayApiUrl", () => {
  it("v1 系は V2 ホストへ投げる", () => {
    expect(famipayApiUrl("api/public/v1/getZandaka")).toBe(
      "https://hcsep.famipay.family.co.jp/api/public/v1/getZandaka",
    );
    expect(famipayApiUrl("api/public/v1/authenticationCheck")).toBe(
      "https://hcsep.famipay.family.co.jp/api/public/v1/authenticationCheck",
    );
  });

  it(".jsp 系は HC_BASE_URL へ投げる", () => {
    expect(famipayApiUrl("api/public/listFamipayHistory.jsp")).toBe(
      "https://famipay.family.co.jp/api/public/listFamipayHistory.jsp",
    );
    expect(famipayApiUrl("api/public/acquireMemberInformation.jsp")).toBe(
      "https://famipay.family.co.jp/api/public/acquireMemberInformation.jsp",
    );
  });
});

describe("extractApplicationAuthToken", () => {
  it("クエリから取り出す", () => {
    const url =
      "https://famipay.family.co.jp/u/d/callback.html?DESTINATION=top&APPLICATION_AUTHENTICATION_TOKEN=abc123";
    expect(extractApplicationAuthToken(url)).toBe("abc123");
  });

  it("APPLICATION_AUTHENTICATION_TOKEN が末尾でも取り出す", () => {
    expect(
      extractApplicationAuthToken("https://example.com/x?APPLICATION_AUTHENTICATION_TOKEN=t-1"),
    ).toBe("t-1");
  });

  it("トークンが無ければ null", () => {
    expect(
      extractApplicationAuthToken("https://famipay.family.co.jp/u/d/callback.html"),
    ).toBeNull();
    expect(extractApplicationAuthToken("")).toBeNull();
  });

  it("エスケープされた値を復元する", () => {
    expect(
      extractApplicationAuthToken("https://example.com/?APPLICATION_AUTHENTICATION_TOKEN=a%2Fb"),
    ).toBe("a/b");
  });
});

describe("parseMemberInformation", () => {
  it("KAIIN_HASH_KEY をセッションキーとして取り出す", () => {
    const parsed = parseMemberInformation({
      RESULT_CODE: "000",
      KAIIN_HASH_KEY: "hash-key",
      KAIIN_NO: "member-no",
      KAIIN_HASH_NO: "hashed-no",
    });
    expect(parsed).toEqual({
      kaiinHashKey: "hash-key",
      kaiinNo: "member-no",
      hashedMemberNo: "hashed-no",
    });
  });

  it("失敗コードなら例外", () => {
    expect(() => parseMemberInformation({ RESULT_CODE: "002" })).toThrow(/RESULT_CODE=002/);
  });

  it("成功でも鍵が無ければ例外", () => {
    expect(() => parseMemberInformation({ RESULT_CODE: "000", KAIIN_NO: "x" })).toThrow(
      /KAIIN_HASH_KEY がありません/,
    );
  });
});

describe("parseZandaka", () => {
  it("残高・ポイント・あと払いを取り出す", () => {
    const balance = parseZandaka({
      RESULT_CODE: "000",
      MN_ZNDK: 12345,
      PT_ZNDK: 678,
      ATOBARAI_ZNDK: 900,
      PASSCD_OMISSION_FLAG: "1",
    });
    expect(balance).toEqual({
      money: 12345,
      points: 678,
      deferredPayment: 900,
      passcodeOmissionFlag: "1",
    });
  });

  it("数値が文字列でも解釈し、欠損は 0 にする", () => {
    const balance = parseZandaka({ RESULT_CODE: "000", MN_ZNDK: "1,234" });
    expect(balance.money).toBe(1234);
    expect(balance.points).toBe(0);
    expect(balance.deferredPayment).toBe(0);
  });

  it("エラーコードなら例外", () => {
    expect(() => parseZandaka({ RESULT_CODE: "103" })).toThrow(/RESULT_CODE=103/);
  });
});

describe("parseHistoryPage", () => {
  it("PT_RIREKI を整形し、URIAGE_NO の無い行は捨てる", () => {
    const page = parseHistoryPage({
      RESULT_CODE: "000",
      KENSU: 3,
      PT_RIREKI: [
        {
          URIAGE_NO: "U1",
          DENPYO_NO: "D1",
          TORIHIKI_BI: "20260115",
          TORIHIKI_TIME: "12:34:56",
          TORIHIKI_KBN: 2,
          GAIBU_KMT_KBN: 1,
          DETAIL_KBN: 3,
          PLACE: "Store A",
          SOUSA_RIYU: "支払い",
          FUYO_PT: 5,
          RIYO_PT: 10,
        },
        { DENPYO_NO: "D2" },
      ],
    });
    expect(page.recordCount).toBe(3);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toEqual({
      uriageNo: "U1",
      denpyoNo: "D1",
      date: "20260115",
      time: "12:34:56",
      transactionKind: 2,
      storeKind: 1,
      detailKind: 3,
      place: "Store A",
      reason: "支払い",
      addedPoints: 5,
      usedPoints: 10,
    });
  });

  it("履歴が空なら空配列", () => {
    expect(parseHistoryPage({ RESULT_CODE: "000", KENSU: 0 }).rows).toEqual([]);
  });
});

describe("parseHistoryDetail", () => {
  it("支払い内訳を取り出す", () => {
    const detail = parseHistoryDetail(
      {
        RESULT_CODE: "000",
        TORIHIKI_BI: "20260115",
        MONEY_CASH: 100,
        MONEY_PREPAID: 900,
        RIYO_PT_KEI: 50,
        ATOBARAI: "0",
        PLACE: "Store A",
      },
      "U1",
    );
    expect(detail.uriageNo).toBe("U1");
    expect(detail.prepaid).toBe(900);
    expect(detail.cash).toBe(100);
    expect(detail.usedPoints).toBe(50);
    expect(detail.deferredPayment).toBe("0");
  });
});

describe("parseTransactionKind", () => {
  it("TORIHIKI_KBN をアプリの区分に対応させる", () => {
    expect(parseTransactionKind(1)).toBe("purchase");
    expect(parseTransactionKind(2)).toBe("charge");
    expect(parseTransactionKind(3)).toBe("refund");
    expect(parseTransactionKind(9)).toBe("other");
  });

  it("未知の値や欠損は other", () => {
    expect(parseTransactionKind(99)).toBe("other");
    expect(parseTransactionKind(null)).toBe("other");
  });
});

describe("classifyFamipayEntry", () => {
  const base = {
    uriageNo: "U1",
    date: "20260115",
    time: null,
    storeKind: null,
    detailKind: null,
    place: null,
    reason: null,
    usedPoints: 0,
    deferredPayment: null,
  };

  it("支払いは支出", () => {
    expect(classifyFamipayEntry({ ...base, transactionKind: 1, cash: 0, prepaid: 1000 })).toEqual({
      kind: "purchase",
      amount: 1000,
      isIncome: false,
    });
  });

  it("チャージは収入。金額の符号に依存しない", () => {
    expect(classifyFamipayEntry({ ...base, transactionKind: 2, cash: 0, prepaid: -3000 })).toEqual({
      kind: "charge",
      amount: 3000,
      isIncome: true,
    });
    expect(classifyFamipayEntry({ ...base, transactionKind: 2, cash: 0, prepaid: 3000 })).toEqual({
      kind: "charge",
      amount: 3000,
      isIncome: true,
    });
  });

  it("返金は収入", () => {
    expect(classifyFamipayEntry({ ...base, transactionKind: 3, cash: 0, prepaid: -500 })).toEqual({
      kind: "refund",
      amount: 500,
      isIncome: true,
    });
  });

  it("区分が other のときだけ符号で向きを補う", () => {
    expect(classifyFamipayEntry({ ...base, transactionKind: 9, cash: 0, prepaid: -500 })).toEqual({
      kind: "other",
      amount: 500,
      isIncome: true,
    });
    expect(classifyFamipayEntry({ ...base, transactionKind: null, cash: 0, prepaid: 500 })).toEqual(
      {
        kind: "other",
        amount: 500,
        isIncome: false,
      },
    );
  });

  it("現金と残高の合計を金額にする", () => {
    expect(
      classifyFamipayEntry({ ...base, transactionKind: 1, cash: 200, prepaid: 800 }),
    ).toMatchObject({
      amount: 1000,
    });
  });

  it("増減が無ければ null", () => {
    expect(classifyFamipayEntry({ ...base, transactionKind: 1, cash: 0, prepaid: 0 })).toBeNull();
  });
});

describe("needsFamipayDetail", () => {
  const row = (detailKind: number | null): FamipayHistoryRow => ({
    uriageNo: "U1",
    denpyoNo: null,
    date: "20260115",
    time: null,
    transactionKind: 1,
    storeKind: null,
    detailKind,
    place: null,
    reason: null,
    addedPoints: null,
    usedPoints: null,
  });

  it("DETAIL_KBN=1 だけ明細を取る", () => {
    expect(needsFamipayDetail(row(1))).toBe(true);
  });

  it("チャージやポイント獲得は明細を取らない（008 になるだけ）", () => {
    expect(needsFamipayDetail(row(0))).toBe(false);
    expect(needsFamipayDetail(row(null))).toBe(false);
  });
});

describe("famipayEntryKey", () => {
  it("URIAGE_NO が同じでも区分と日付で区別する", () => {
    const base: FamipayHistoryRow = {
      uriageNo: "U1",
      denpyoNo: null,
      date: "20260115",
      time: null,
      transactionKind: 1,
      storeKind: null,
      detailKind: 1,
      place: null,
      reason: null,
      addedPoints: null,
      usedPoints: null,
    };
    // ポイント獲得行は利用行と URIAGE_NO を共有する
    expect(famipayEntryKey(base)).not.toBe(
      famipayEntryKey({ ...base, transactionKind: 9, detailKind: 0, date: "20260116" }),
    );
  });
});

describe("classifyFamipayRow", () => {
  const row = (over: Partial<FamipayHistoryRow>): FamipayHistoryRow => ({
    uriageNo: "U1",
    denpyoNo: null,
    date: "20260115",
    time: null,
    transactionKind: 1,
    storeKind: null,
    detailKind: 1,
    place: null,
    reason: null,
    addedPoints: null,
    usedPoints: null,
    ...over,
  });
  const detail = {
    uriageNo: "U1",
    date: "20260115",
    time: null,
    transactionKind: 1,
    storeKind: null,
    detailKind: 1,
    place: "ファミリーマート",
    reason: "利用",
    cash: 0,
    prepaid: 149,
    usedPoints: 149,
    deferredPayment: null,
  };

  it("明細があればその金額を使う", () => {
    expect(classifyFamipayRow(row({}), detail)).toEqual({
      kind: "purchase",
      amount: 149,
      isIncome: false,
    });
  });

  it("明細が無いチャージは FUYO_PT を金額にする", () => {
    expect(
      classifyFamipayRow(
        row({
          transactionKind: 2,
          detailKind: 0,
          addedPoints: 10000,
          reason: "クレジットカードでチャージ",
        }),
        null,
      ),
    ).toEqual({ kind: "charge", amount: 10000, isIncome: true });
  });

  it("ポイント獲得行（TORIHIKI_KBN=9）は取り込まない", () => {
    // 利用行と同じ URIAGE_NO を持ち、明細も同じものが返る可能性があるため必ず除外する
    expect(classifyFamipayRow(row({ transactionKind: 9, addedPoints: 2 }), detail)).toBeNull();
  });

  it("明細が無い利用行は判断できないので取り込まない", () => {
    expect(classifyFamipayRow(row({ detailKind: 0 }), null)).toBeNull();
  });

  it("チャージでも金額が 0 なら取り込まない", () => {
    expect(
      classifyFamipayRow(row({ transactionKind: 2, detailKind: 0, addedPoints: 0 }), null),
    ).toBeNull();
  });
});

describe("famipayEntryContent", () => {
  const base = {
    uriageNo: "U1",
    date: "20260115",
    time: null,
    transactionKind: 1,
    storeKind: null,
    detailKind: null,
    cash: 0,
    prepaid: 100,
    usedPoints: 0,
    deferredPayment: null,
  };

  it("店名と理由を並べる", () => {
    expect(famipayEntryContent({ ...base, place: "Store A", reason: "支払い" })).toBe(
      "Store A 支払い",
    );
  });

  it("片方だけならそれを使う", () => {
    expect(famipayEntryContent({ ...base, place: "Store A", reason: null })).toBe("Store A");
    expect(famipayEntryContent({ ...base, place: null, reason: "チャージ" })).toBe("チャージ");
  });

  it("どちらも無ければ取引の種類にする", () => {
    expect(famipayEntryContent({ ...base, place: null, reason: null })).toBe("支払い");
  });
});

describe("toMoneyForwardDate", () => {
  it("YYYYMMDD を YYYY/MM/DD に直す", () => {
    expect(toMoneyForwardDate("20260115")).toBe("2026/01/15");
    expect(toMoneyForwardDate("2026/01/15")).toBe("2026/01/15");
    expect(toMoneyForwardDate("2026-01-15")).toBe("2026/01/15");
  });

  it("不正な値は null", () => {
    expect(toMoneyForwardDate("2026")).toBeNull();
    expect(toMoneyForwardDate("20261301")).toBeNull();
  });
});
