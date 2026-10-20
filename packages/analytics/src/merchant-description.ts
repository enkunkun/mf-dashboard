/**
 * クレジットカード明細の店名を読みやすい形に補正する。
 *
 * カード会社（DCカード・Kyash など）は明細の加盟店名を半角カナで送ってくる。
 * Money Forward はそれを全角カナに変換するが、そのとき小書き文字（ョ・ャ・ュ・ェ）が
 * 大きく、長音（ー）が「-」に潰れる。結果として「ショップインバース秋葉原1号店」が
 * 「シヨツプインバ-スアキハバライチゴウテ」になり、LLM が店名を読み取れず
 * confidence が上がらない。
 *
 * ここでは保存値は変えず、判断に渡す文字列だけを補正する。ルールの
 * descriptionContains は生の文字列に当てるため、補正でルールが外れることはない。
 */
const KATAKANA = /[\u30A1-\u30F6\u30FC]/;

const SMALL_KANA_BASES = [
  "シ",
  "チ",
  "ジ",
  "キ",
  "ニ",
  "ヒ",
  "ミ",
  "リ",
  "ビ",
  "ピ",
  "ギ",
] as const;

const SMALL_KANA_MAP: Record<string, string> = {
  ヨ: "ョ",
  ヤ: "ャ",
  ユ: "ュ",
  エ: "ェ",
};

const SMALL_KANA_PATTERN = new RegExp(`([${SMALL_KANA_BASES.join("")}])([ヨヤユエ])`, "g");

/** 全角カナに潰れた小書き文字を戻す（シヨ → ショ、キヤ → キャ）。 */
function restoreSmallKana(input: string): string {
  return input.replace(SMALL_KANA_PATTERN, (_match, base: string, small: string) => {
    return `${base}${SMALL_KANA_MAP[small] ?? small}`;
  });
}

/** 潰れた促音（シヨツプ → ショップ、ケンタツキー → ケンタッキー）を戻す。 */
function restoreSokuon(input: string): string {
  return input.replace(/(?<=[\u30A1-\u30F6])ツ(?=[プトクチ])/g, "ッ");
}

/** カナに挟まれた長音の潰れ（バ-ス → バース）を戻す。 */
function restoreLongVowel(input: string): string {
  let result = "";
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] as string;
    const isDash = char === "-" || char === "−" || char === "‐" || char === "－";
    if (isDash) {
      const before = input[index - 1];
      const after = input[index + 1];
      if (before && after && KATAKANA.test(before) && KATAKANA.test(after)) {
        result += "ー";
        continue;
      }
    }
    result += char;
  }
  return result;
}

export function correctMerchantDescription(raw: string): string {
  const normalized = raw.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return normalized;
  return restoreLongVowel(restoreSokuon(restoreSmallKana(normalized)));
}
