/**
 * ファミペイの電子レシート（印字テキスト）を商品行に分解する。
 *
 * レシートは `printedTextChunks: string[]` として返ってくる。構造化された商品データは
 * 無いので、印字行のレイアウトを頼りに「商品名 + 金額」を取り出す。
 *
 * 形式が変わると壊れるため、失敗した場合は null を返し、呼び出し側が
 * 「合計 1 カテゴリ」にフォールバックできるようにする。
 */

export type FamipayReceiptLine = {
  /** 印字された商品名（例: `伊右衛門２Ｌ`）。 */
  name: string;
  /** 金額。値引き・クーポンは負の値。 */
  amount: number;
  /** `軽` マーク（軽減税率対象）。 */
  taxReduced: boolean;
};

export type ParsedFamipayReceipt = {
  /** 商品行（正の金額）。 */
  items: FamipayReceiptLine[];
  /** 値引き・クーポン行（負の金額）。 */
  adjustments: FamipayReceiptLine[];
  /** 商品行の合計（値引き前）。 */
  itemTotal: number;
  /** 値引き・クーポンの合計（負の値）。 */
  adjustmentTotal: number;
  /** レシートの合計金額。商品行 + 値引き。 */
  total: number;
};

const DIGIT_RANGE = /[０-９]/g;

const normalizeDigits = (text: string): string =>
  text
    .replace(DIGIT_RANGE, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/，/g, ",");

/**
 * 1 行から「商品名 + 金額」を取り出す。
 *
 * 商品名と金額は 2 文字以上の空白（半角・全角）で区切られている。
 * 金額は `\1,234` / `￥１，２３４` / `-1,500` の形を許容し、末尾の `軽` を拾う。
 */
export function extractReceiptLine(line: string): FamipayReceiptLine | null {
  const original = line.trimEnd();
  const normalized = normalizeDigits(original);
  const match = normalized.match(/^(.*?)[\s　]{2,}[\\￥¥]?\s*(-?[\d][\d,\s]*)\s*(軽)?$/);
  if (!match) return null;

  // 正規化は 1 文字 → 1 文字なので、元の行を同じ長さで切れば印字どおりの名前が残る。
  const name = original.slice(0, match[1].length).trim();
  const amountText = match[2].replace(/[,\s]/g, "");
  if (!name || !amountText) return null;

  const amount = Number(amountText);
  if (!Number.isFinite(amount) || amount === 0) return null;

  return { name, amount, taxReduced: match[3] === "軽" };
}

/** レシートの合計行から金額を取り出す。 */
export function extractReceiptTotal(line: string): number | null {
  if (!/^合\s*計/.test(normalizeDigits(line).trim())) return null;
  const digits = normalizeDigits(line).replace(/[^\d]/g, "");
  if (!digits) return null;
  const total = Number(digits);
  return Number.isFinite(total) ? total : null;
}

/**
 * 印字行の配列を商品行・値引き行・合計に分解する。
 *
 * 商品行は「領収証」ヘッダと「合計」行の間に並ぶ。合計行が見つからない場合は
 * レイアウトを判断できないので null を返す（フォールバック必須）。
 */
export function parseReceiptText(chunks: readonly string[]): ParsedFamipayReceipt | null {
  const lines = chunks.map((line) => line.trimEnd()).filter((line) => line.length > 0);
  if (lines.length === 0) return null;

  const totalIndex = lines.findIndex((line) => extractReceiptTotal(line) !== null);
  if (totalIndex < 0) return null;

  const headerIndex = lines.findIndex((line) => line.includes("領収証"));
  const start = headerIndex >= 0 ? headerIndex + 1 : 0;

  const items: FamipayReceiptLine[] = [];
  const adjustments: FamipayReceiptLine[] = [];

  for (const line of lines.slice(start, totalIndex)) {
    // 商品合計・値引合計などの集計行は商品ではない
    if (/^[（(]?\s*(商品|値引)?合\s*計/.test(normalizeDigits(line).trim())) continue;
    const parsed = extractReceiptLine(line);
    if (!parsed) continue;
    if (parsed.amount < 0) adjustments.push(parsed);
    else items.push(parsed);
  }

  if (items.length === 0) return null;

  const itemTotal = items.reduce((sum, item) => sum + item.amount, 0);
  const adjustmentTotal = adjustments.reduce((sum, adjustment) => sum + adjustment.amount, 0);
  const printedTotal = extractReceiptTotal(lines[totalIndex]);
  const total = printedTotal ?? itemTotal + adjustmentTotal;

  return { items, adjustments, itemTotal, adjustmentTotal, total };
}

export type FamipayCategoryAllocation = {
  category: string;
  amount: number;
};

/**
 * 商品をカテゴリ別の金額に集約する。値引きは商品金額に比例配分し、
 * 合計がレシートの合計と一致するように端数を最大のカテゴリで吸収する。
 */
export function allocateReceiptByCategory(
  receipt: ParsedFamipayReceipt,
  categorize: (name: string) => string,
): FamipayCategoryAllocation[] {
  if (receipt.itemTotal <= 0) return [];

  const gross = new Map<string, number>();
  for (const item of receipt.items) {
    const category = categorize(item.name);
    gross.set(category, (gross.get(category) ?? 0) + item.amount);
  }

  const allocations = [...gross].map(([category, amount]) => ({
    category,
    amount: Math.round((amount * receipt.total) / receipt.itemTotal),
  }));

  const allocated = allocations.reduce((sum, allocation) => sum + allocation.amount, 0);
  const remainder = receipt.total - allocated;
  if (remainder !== 0 && allocations.length > 0) {
    allocations.sort((a, b) => b.amount - a.amount);
    allocations[0]!.amount += remainder;
  }

  return allocations.filter((allocation) => allocation.amount !== 0);
}
