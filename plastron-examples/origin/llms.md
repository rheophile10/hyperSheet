# plastron — guide for LLMs & agents

This is the one canonical guide. It is served verbatim as plain text at
**https://plastron.ca/llms.txt**, mirrored in the repo `README.md`, and shown
(condensed) in the app's own readme. Paste it into a system prompt to author
plastron formulas without access to the source.

plastron is a **reactive spreadsheet made of cels**, shipped as one self-contained
`index.html`. A cell doesn't just compute — its formula can render DOM, spawn
grids, call an LLM, query SQLite, or build a whole app. **A formula IS the app,
and a formula fits in a URL**, so a whole running plastron is shareable as a link.

────────────────────────────────────────────────────────────────────────────
FIRST — RESEARCH, DON'T GUESS (plastron describes itself)
────────────────────────────────────────────────────────────────────────────
This guide lists the high-frequency verbs, but it is NOT the full set. Plastron
ships MANY more (charts, graphs, music/MIDI, peer/net, files, …). If you need a
capability that isn't spelled out below, DISCOVER it with a formula instead of
guessing a verb that may not exist:
  =vocab()            every verb + its one-line description, grouped by segment
  =vocab("charts")    just one segment's verbs
  =inspect("name")    one verb's full doc — signature, about, source
  =members("seg")     the cels in a segment
  =segments()         every loaded segment
Put one of these in a cell, read the result, THEN write the real formula. A wrong
guess surfaces as `#NAME?`; `=inspect("<verb>")` tells you the true signature.
(Full plain-text guide + complete catalog: https://plastron.ca/llms.txt)

────────────────────────────────────────────────────────────────────────────
THE TWO FORMULA LANGUAGES (pick one per cell; the leading char selects it)
────────────────────────────────────────────────────────────────────────────
- **infix** — Excel/function-call style, starts with `=`:
    `=1+1`   `=cels(8,5,"todo")`   `=dom("h1","hello")`   `=g!A1*2`   `=SUM(A1:A10)`
- **S-expression** — Lisp prefix, starts with `(`:
    `(+ 1 1)`   `(cels 8 5 "todo")`   `(dom "h1" "hello")`

They are equivalent in power. Infix is the Excel-compatible surface; S-expr is the
homoiconic one. Don't mix them inside one formula. Cell references are `A1`,
ranges are `A1:B3` or `seg!A1:B3`. Cel keys in formulas are ASCII `[\w.-]+`.

STRINGS: use `"…"` or `'…'`. A second delimiter means a nested formula needs **no
escaping**, one level deep:
    `at("A1", '=dom("h1", "Tasks")')`   ✅   (not  `at("A1","=dom(\"h1\",\"Tasks\")")`)

────────────────────────────────────────────────────────────────────────────
CORE FORMULAS (the high-frequency ones — full catalog at the bottom)
────────────────────────────────────────────────────────────────────────────
GRIDS / SHEETS
  =cels(rows, cols)                       one worksheet of editable cels
  =cels(rows, cols, "name")              a named worksheet
  =cels("in",4,3, "out",4,3)            a workbook of named sheets
  =cels(8,5,"todo", at("A1","Task"), at("B1","Status"))   seed cell contents
  at(addr, content)                       one cell's initial content (value or =formula)

VIEWS (DOM + canvas)
  =dom("h1", "hello")                     an element rendered in the cell
  =dom("div", style("color","red"), "hi")  style() = key/value attribute pairs
  =dom("button", on("click","origin.tone", 440), "♪")   on(event, verb, arg)
  =canvas(420,260, barchart(t!A2:A8, t!B2:B8))           a drawn chart

DATA + CHART TOGETHER (the right way)
  `cels()` is a GENESIS — it builds a sheet. It is **top-level**, NOT a child of
  `dom()`. Never write `dom("div", cels(...), ...)` — the grid won't materialize
  (it stringifies to "[object Object]") and any chart that reads it shows "no data".
  Instead, put the chart in a cell OF the same sheet so its range read is local:
    =cels("sales", 5, 2,
      at("A1","Item"),  at("B1","Value"),
      at("A2","Apples"),at("B2",10),
      at("A3","Pears"), at("B3",20),
      at("A4","Plums"), at("B4",15),
      at("A5", '=canvas(360,200, barchart(sales!A2:A4, sales!B2:B4))'))
  (Note the `'…'` delimiter on the nested chart formula — no escaping needed.)

LOGIC / DATA
  =1+1   =A1*2   =SUM(A1:A10)   =IF(A1>0,"yes","no")
  =LET(x, A1*2, x + x*x)                  name a sub-expression, reuse it (readability)
  =SUM(MAP(A1:A9, LAMBDA(v, v*v)))        LAMBDA + MAP/REDUCE/SCAN/BYROW over a range
  =db("main")   =sql("select * from t")   =tables()        browser SQLite
  =claude(chat!A1, apiKey("anthropic"))                    ask an LLM (reactive)
  =chat(prompt, apiKey("grok"))                            OpenAI-shaped endpoint

FILES (OPFS, in-browser)
  =write("/a.txt","hi")  =cat("/a.txt")  =ls("/")  =mkdir("/d")  =upload("/")

WINDOWS / LAYOUT
  =win(key,"title","body")     =winsize("keys","max")  (maximize)     =jail(seed)

NAVBAR / MENUS (a pasteable menu; one formula, mobile + desktop)
  item(label, action, ...children)   one menu node. label = emoji+text; action =
        a window KEY (click focuses it) or a '=formula' (click spawns a window);
        omit action for a submenu parent. children = nested item()s (WordPress-style).
  =nav(viewport.mobile, item(…), …)  renders the menu — pass viewport.mobile FIRST so
        it auto-switches: a collapsible ☰ left sidebar on mobile, desktop launcher
        icons otherwise. Example:
    =nav(viewport.mobile,
      item("📁 Files", "files"),
      item("📊 Charts",
        item("🥧 Pie", '=cels("p",3,2, at("A1","Apples"), at("B1",10), at("A2","Pears"), at("B2",20))'),
        item("📈 Bar", '=cels("b",3,2, at("A1","Q1"), at("B1",30))')),
      item("元 Origin", "元"))

RESPONSIVE LAYOUT (the page is the product — use the whole viewport, don't cram)
  The result is a full plastron.ca PAGE, not just a cell. An app-like formula
  should claim space: open a sized window, or size DOM to the viewport.
  - viewport.w / viewport.h / viewport.mobile / viewport.orient — reactive cels;
    a formula that references them RE-RUNS on resize. =viewport() = a one-shot {…}.
  - =win("app", "App", body, viewport.w, viewport.h - 40)         fill the screen
  - =IF(viewport.mobile, dom("h1","phone view"), bigDesktopUi)    branch on device
  Prefer a window or a sized canvas/dom over a widget squeezed into one tiny cell.

────────────────────────────────────────────────────────────────────────────
SHARE LINKS — how to make one (IMPORTANT: don't hand-encode)
────────────────────────────────────────────────────────────────────────────
A formula fits in a URL. To make a shareable link, **write the formula and let the
app encode it** — never hand-roll the compressed form.

- `=link()`                 → encode THIS whole sheet → https://plastron.ca/#f=<payload>
- `=link("元")`             → encode one cell's source
- `#raw=<url-encoded-formula>` → the simplest link YOU can build by hand:
      https://plastron.ca/#raw=%3Dcels(8%2C5%2C%22todo%22)   (just URL-encode a valid `=formula`)
- DO NOT construct `#f=` yourself. It is `tag + base64url(deflateRaw(formula))` — a
  compression format. There is **no JSON wrapper**. If you can't run `=link()`,
  use `#raw=`.

SELF-SERVICE TOOLS (open the URL → it answers in PLAIN TEXT; no app runs):
- `https://plastron.ca/#check=<url-encoded-formula>`  → "✅ VALID" or "❌ INVALID + error".
      Use this to TEST a formula before you share it.
- `https://plastron.ca/#encode=<url-encoded-formula>` → the compressed `#f=` link for it.
      This is how you give a `#f=` link without deflating yourself: build the `#encode=`
      URL, the page returns the real `#f=` link.
  Example: to share `=cels(3,3)` → open `https://plastron.ca/#encode=%3Dcels(3%2C3)`.

Encrypted variants (open one → it boots a LOCKED, sandboxed kernel):
- `=encrypt(passphrase)`    → `#aes256gcm=…`  (passphrase prompt on open; AES-256-GCM)
- `=otpEncrypt()`           → `#otp=<padId>.…` (one-time **pad** = the Vernam cipher,
                              NOT one-time-password; pick a pad file; unconditional secrecy)

Opening any `#f= / #raw= / #aes256gcm= / #otp=` link is safe: it boots locked — no
net/storage/code/secrets until a human grants them via the 🛡 trust controls.

────────────────────────────────────────────────────────────────────────────
WORKED ONE-TIME-PAD DEMO (the pad is PUBLIC → a codec demo, not a secret message)
────────────────────────────────────────────────────────────────────────────
[[OTP_DEMO]]

────────────────────────────────────────────────────────────────────────────
FULL VERB CATALOG (baked from =vocab() at build time — current as of this deploy)
────────────────────────────────────────────────────────────────────────────
[[VOCAB_CATALOG]]
