// check — the raw "is this formula valid?" test. No LLM. Feed it a formula or a
// plastron link (arg or stdin); it runs the SAME validator the eval uses (boot
// origin headless, commit it, report parse/eval result). Exit 0 = valid.
//   bun check.ts '=cels(3,3)'
//   bun check.ts 'https://plastron.ca/#raw=%3Dcels(3%2C3)'
//   echo '(dom "h1" "hi")' | bun check.ts
import { validate } from "./validate.ts";

const arg = process.argv.slice(2).join(" ").trim();
const input = arg || (await Bun.stdin.text()).trim();
if (!input) { console.error("usage: bun check.ts '<formula or #f=/#raw= link>'  (or pipe via stdin)"); process.exit(2); }

const v = await validate(input);
console.log(`${v.ok ? "VALID" : "INVALID"}  [${v.kind}]  ${v.note}`);
if (v.formula && v.formula !== input) console.log(`formula: ${v.formula}`);
process.exit(v.ok ? 0 : 1);
