/**
 * ファミペイの電子レシートに印字された商品名から、MF の大カテゴリを決める。
 *
 * 方針（ユーザー確認済み）:
 * - たばこ（加熱式たばこ本体・スティックを含む） → 趣味・娯楽
 * - 衣類（パンツ・下着・靴下など） → 衣服・美容
 * - 日用品（レジ袋・ティッシュ・洗剤など） → 日用品
 * - 判別できないもの（食品・飲料など） → 食費
 *
 * 商品名はレシート印字のため、全角・半角・略称が混在する。NFKC 正規化してから照合する。
 */

export const FAMIPAY_CATEGORY_FALLBACK = "食費";

type CategoryRule = {
  category: string;
  pattern: RegExp;
};

const RULES: readonly CategoryRule[] = [
  {
    category: "趣味・娯楽",
    pattern:
      /(たばこ|タバコ|煙草|プルーム|メビウス|セブンスター|ウィンストン|キャメル|マールボロ|ラーク|ピース|アイコス|グロー|テリア|ニコチン)/,
  },
  {
    category: "衣服・美容",
    pattern:
      /(パンツ|ボクサー|ブリーフ|ショーツ|ソックス|靴下|シャツ|下着|インナー|衣類|レギンス|スパッツ)/,
  },
  {
    category: "日用品",
    pattern:
      /(レジ袋|ゴミ袋|カラムー|ティッシュ|トイレット|洗剤|マスク|除菌|アルコール|電池|ハンドソープ)/,
  },
];

/** 商品名から MF の大カテゴリ名を返す。該当が無ければ食費。 */
export function categorizeFamipayItem(name: string): string {
  const normalized = name.normalize("NFKC");
  for (const rule of RULES) {
    if (rule.pattern.test(normalized)) return rule.category;
  }
  return FAMIPAY_CATEGORY_FALLBACK;
}
