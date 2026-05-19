const fs = require("fs");
const p = "public/partiamo.html";
let s = fs.readFileSync(p, "utf8");

const howRe =
  /<section class="how">\s*<div class="how-inner">[\s\S]*?<\/section>\s*\n/;
const m = s.match(howRe);
if (!m) {
  console.error("how section not found");
  process.exit(1);
}
let howBlock = m[0]
  .replace('class="how"', 'class="how how--above-search" aria-labelledby="how-heading"')
  .replace("<h2>Come funziona</h2>", '<h2 id="how-heading">Come funziona</h2>');

s = s.replace(howRe, "");
const insertAfter = "      </p>\n\n      <div class=\"search-card\">";
if (!s.includes(insertAfter)) {
  console.error("insert marker not found");
  process.exit(1);
}
s = s.replace(insertAfter, `      </p>\n\n${howBlock}      <motion class="search-card">`.replace(/motion/g, "div"));

fs.writeFileSync(p, s);
console.log("ok");
