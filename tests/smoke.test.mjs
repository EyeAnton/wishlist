// Локальные проверки без сети и без Firebase: `npm test` (или `node --test`).
// app.js импортирует Firebase SDK по https-URL, поэтому целиком в Node его не загрузить.
// Вместо этого: 1) синтаксис app.js через `node --check`, 2) чистые функции-утилиты
// вырезаются из исходника по имени и проверяются отдельно, 3) JSON-конфиги и связность файлов.
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = f => readFileSync(join(ROOT, f), "utf8");
const APP = read("app.js");

// Вырезает `function name(...){...}` или `const NAME = ...;` из app.js по балансу скобок.
function extract(name){
  const fn = APP.indexOf(`function ${name}(`);
  if(fn !== -1){
    let i = APP.indexOf("{", APP.indexOf(")", fn)), depth = 0;
    for(; i < APP.length; i++){
      if(APP[i] === "{") depth++;
      else if(APP[i] === "}" && --depth === 0) return APP.slice(fn, i + 1);
    }
  }
  const line = APP.split("\n").find(l => l.startsWith(`const ${name} =`));
  if(line) return line;
  throw new Error(`не найдено в app.js: ${name}`);
}

function load(names, ret){
  const src = names.map(extract).join("\n") + `\nreturn { ${ret.join(", ")} };`;
  return new Function(src)();
}

const U = load(
  ["escapeHtml", "URL_REGEX", "linkifyText", "reservationKey", "daysWord", "parseLegacyPriceString", "CURRENCY_SYMBOL", "formatMoney"],
  ["escapeHtml", "linkifyText", "reservationKey", "daysWord", "parseLegacyPriceString", "formatMoney"],
);

test("app.js синтаксически корректен", () => {
  execFileSync(process.execPath, ["--check", join(ROOT, "app.js")]);
});

test("escapeHtml экранирует HTML", () => {
  assert.equal(U.escapeHtml(`<img src=x onerror="a('b')">&`), "&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;");
  assert.equal(U.escapeHtml(null), "");
});

test("linkifyText делает ссылки и не пропускает разметку", () => {
  const html = U.linkifyText("см. https://ozon.ru/t/abc. <b>x</b>");
  assert.match(html, /<a href="https:\/\/ozon\.ru\/t\/abc" target="_blank" rel="noopener">/);
  assert.match(html, /<\/a>\. &lt;b&gt;x&lt;\/b&gt;$/);
  assert.ok(!U.linkifyText("javascript:alert(1)").includes("<a"));
});

test("reservationKey не зависит от регистра и пробелов, ключ допустим для Firebase", () => {
  assert.equal(U.reservationKey(" Маша "), U.reservationKey("маша"));
  assert.match(U.reservationKey("Маша"), /^n[0-9a-f]+$/);
});

test("daysWord склоняет", () => {
  assert.deepEqual([1, 2, 5, 11, 21, 22, 112].map(U.daysWord), ["день", "дня", "дней", "дней", "день", "дня", "дней"]);
});

test("старые цены-строки и форматирование", () => {
  assert.deepEqual(U.parseLegacyPriceString("5,690 AMD"), { amount: 5690, currency: "AMD" });
  assert.deepEqual(U.parseLegacyPriceString("$46"), { amount: 46, currency: "USD" });
  assert.equal(U.parseLegacyPriceString("без цены"), null);
  assert.equal(U.formatMoney(46, "USD"), "$46");
  assert.equal(U.formatMoney(1234.5, "RUB"), "1234.50 ₽");
});

test("конфиги Firebase — валидный JSON, правила закрыты по умолчанию", () => {
  const rules = JSON.parse(read("database.rules.json")).rules;
  assert.equal(rules[".read"], false);
  assert.equal(rules.reservations[".read"].includes("auth != null"), true);
  JSON.parse(read("firebase.json"));
  JSON.parse(read(".firebaserc"));
});

test("страницы подключают существующие файлы", () => {
  for(const page of ["index.html", "admin.html"]){
    const html = read(page);
    assert.match(html, /href="style\.css"/);
    assert.match(html, /from '\.\/app\.js'/);
  }
  assert.ok(existsSync(join(ROOT, "style.css")));
});
