/**
 * モバイルSuica の「SF（電子マネー）利用履歴」を開いて構造を調べる（読み取り・探索用）。
 * 実行: npx tsx scripts/suica-history.ts
 */
import type { Page } from "playwright";
import { loginWithPasskey } from "./lib/suica-auth.js";
import { getSuicaPage } from "./suica-browser.js";

const SF_LINK = 'a:has-text("SF（電子マネー）利用履歴")';

async function dump(page: Page, label: string) {
  const info = await page.evaluate(() => {
    const text = (document.body.innerText || "").replace(/\n{2,}/g, "\n").trim();
    const tables = Array.from(document.querySelectorAll("table"))
      .slice(0, 6)
      .map((t) => ({
        rows: t.querySelectorAll("tr").length,
        cols: t.querySelector("tr")?.querySelectorAll("th,td").length ?? 0,
        head: Array.from(t.querySelectorAll("tr"))
          .slice(0, 3)
          .map((r) =>
            Array.from(r.querySelectorAll("th,td"))
              .map((c) => (c.textContent || "").trim())
              .join(" | "),
          ),
      }));
    const links = Array.from(document.querySelectorAll("a"))
      .map((a) => ({ t: (a.textContent || "").trim().slice(0, 30), h: a.getAttribute("href") }))
      .filter((x) => x.h && !x.h.startsWith("javascript"));
    const selects = Array.from(document.querySelectorAll("select")).map((s) => ({
      name: s.name,
      id: s.id,
      value: s.value,
      options: Array.from(s.options)
        .slice(0, 20)
        .map((o) => ({ v: o.value, t: (o.textContent || "").trim(), sel: o.selected })),
    }));
    const buttons = Array.from(
      document.querySelectorAll("button, input[type=submit], input[type=button]"),
    ).map((b) => ({
      tag: b.tagName.toLowerCase(),
      type: (b as HTMLInputElement).type ?? null,
      name: b.getAttribute("name"),
      value: (b as HTMLInputElement).value ?? null,
      text: (b.textContent || "").trim().slice(0, 30),
    }));
    const formActions = Array.from(document.querySelectorAll("form")).map((f) => ({
      name: f.name,
      id: f.id,
      method: f.method,
      action: f.getAttribute("action"),
    }));
    return {
      title: document.title,
      url: location.href,
      textHead: text.slice(0, 1800),
      tables,
      links: links.slice(0, 30),
      selects,
      buttons,
      formActions,
    };
  });
  console.log(`\n===== ${label} =====`);
  console.log("title:", info.title);
  console.log("url  :", info.url);
  console.log("--- text ---\n" + info.textHead);
  console.log("--- tables ---\n" + JSON.stringify(info.tables, null, 2));
  console.log("--- selects ---\n" + JSON.stringify(info.selects, null, 2));
  console.log("--- buttons ---\n" + JSON.stringify(info.buttons, null, 2));
  console.log("--- forms ---\n" + JSON.stringify(info.formActions, null, 2));
  console.log("--- links ---\n" + JSON.stringify(info.links, null, 2));
}

async function main() {
  const { page, context } = await getSuicaPage();

  await page.goto("https://www.mobilesuica.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  let sfLink = page.locator(SF_LINK).first();
  if ((await sfLink.count()) === 0) {
    console.log("未ログイン → パスキーでログインします");
    await loginWithPasskey(page, context);
    sfLink = page.locator(SF_LINK).first();
  } else {
    console.log("ログイン済みセッションを再利用します");
  }

  console.log("sf link count:", await sfLink.count());
  console.log("sf href:", await sfLink.getAttribute("href").catch(() => null));

  page.on("request", (r) => {
    if (/history|rireki|SuicaChangeTransfer|sf|\.json|api|axd/i.test(r.url())) {
      console.log(`  [req] ${r.method()} ${r.url().slice(0, 160)}`);
    }
  });
  page.on("response", (r) => {
    if (/history|rireki|SuicaChangeTransfer|sf|\.json|api/i.test(r.url())) {
      console.log(`  [res] ${r.status()} ${r.url().slice(0, 160)}`);
    }
  });

  const before = context.pages().map((p) => p.url());
  await sfLink
    .evaluate((el) => (el as HTMLElement).click())
    .catch((e) => console.log("click err:", e.message));
  await page.waitForTimeout(9000);

  console.log(
    "\npages:",
    context.pages().map((p) => p.url()),
  );
  const cur =
    context.pages().find((p) => !before.includes(p.url())) ??
    context.pages()[context.pages().length - 1] ??
    page;

  // --month 2026/08 が渡されていれば、その月で検索して表示範囲を確認する
  const mi = process.argv.indexOf("--month");
  const month = mi >= 0 ? process.argv[mi + 1] : undefined;
  if (month) {
    console.log(`\n>> 月検索: ${month} day=31`);
    await cur
      .selectOption('select[name="specifyYearMonth"]', month)
      .catch((e) => console.log("selectYM err", e.message));
    await cur
      .selectOption('select[name="specifyDay"]', "31")
      .catch((e) => console.log("selectDay err", e.message));
    await Promise.all([
      cur.waitForNavigation({ waitUntil: "domcontentloaded" }).catch(() => {}),
      cur
        .locator('button[name="SEARCH"]')
        .click()
        .catch((e) => console.log("search err", e.message)),
    ]);
    await cur.waitForTimeout(5000);
  }

  await dump(cur, "after SF history click");
  process.exit(0);
}

main().catch((err) => {
  console.error("error:", err);
  process.exit(1);
});
