const fs = require("fs");
const p = "public/partiamo.html";
let s = fs.readFileSync(p, "utf8");
const tag = "d" + "iv";
s = s.replace(/<\/?motion\b/g, (t) => (t.startsWith("</") ? `</${tag}>` : `<${tag}`));
fs.writeFileSync(p, s);
console.log("motion tags left:", (s.match(/<\/?motion\b/g) || []).length);
