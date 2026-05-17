const fs = require("fs");
const path = require("path");
const file = path.join(__dirname, "..", "public", "home.js");
let s = fs.readFileSync(file, "utf8");
const wrongClose = String.fromCharCode(60, 47, 109, 111, 116, 105, 111, 110, 62);
const rightClose = String.fromCharCode(60, 47, 100, 105, 118, 62);
const wrongOpen = String.fromCharCode(60, 109, 111, 116, 105, 111, 110, 32);
const rightOpen = String.fromCharCode(60, 100, 105, 118, 32);
let n = 0;
while (s.includes(wrongClose)) {
  s = s.replace(wrongClose, rightClose);
  n += 1;
}
s = s.split(wrongOpen).join(rightOpen);
fs.writeFileSync(file, s);
console.log("fixed closes:", n);
