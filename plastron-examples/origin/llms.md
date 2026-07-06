<!-- GENERATED from the guide segment (plastron/src/甲骨坑/library/guide/甲骨.json) by plastron/scripts/generate-llms.mjs — edit the guide cels, not this file. -->

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
  =help("", "text")        every verb + its one-line description, grouped by segment
  =help("charts", "text")  just one segment's verbs (as this cell's VALUE — no pane)
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
- **JSON** — data entry, starts with `{` or `[`:
    `{"name": "kirk", "age": 7}`   `[1, 2, 3]`
  The cell's VALUE is the parsed object/array (archives round-trip it as the
  same JSON). Unparseable `{`/`[` content stays a plain string.

They are equivalent in power. Infix is the Excel-compatible surface; S-expr is the
homoiconic one. Don't mix them inside one formula. Cell references are `A1`,
ranges are `A1:B3` or `seg!A1:B3`. Cel keys in formulas are ASCII `[\w.-]+`.

FORMAT BIG FORMULAS MULTI-LINE: newlines and tabs are IGNORED by the parser, so indent a
large nested formula and put one argument per line — a single long line is the #1 cause of
`expected ")"` (a miscounted paren). Indentation makes every `(` line up with its `)`.

STRINGS: use `"…"` or `'…'`. A second delimiter means a nested formula needs **no
escaping**, one level deep:
    `at("A1", '=dom("h1", "Tasks")')`   ✅   (not  `at("A1","=dom(\"h1\",\"Tasks\")")`)
  A cell whose content is itself a `=formula` MUST be quoted with the alternate
  delimiter — `at("B2", '=SCAN(0,A2:A6,LAMBDA(a,v,a+v))')` ✅; a BARE `at("B2", =SCAN(…))`
  is a parse error ("unexpected token ="). Only TWO string levels exist (`"` outside,
  `'` inside) — do NOT go a third level deep and NEVER use backticks. If you need depth
  (e.g. a chart inside a menu-spawned sheet), build that sheet as its OWN top-level
  `=cels(…)` and reference it, rather than inlining a third nested formula.

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
  NO ARRAY SPILL INTO CELLS: MAP/FILTER/SCAN/BYROW return ONE array VALUE. Put it in a single
  cell and it shows as a JSON dump ([100,250,…]) — it does NOT fill the cells below/beside it.
  (EXCEPTION — a DOM container flattens an array child, so MAP→dom IS how you render a list;
  see RENDER A LIST. The rule below is only about a raw array sitting in a sheet cell.) So:
    • collapse it to one value with an aggregate:  =SUM(MAP(A2:A9, LAMBDA(v, v*v)))  ✅
    • to DISPLAY a per-row column (running totals, row totals) write an EXPLICIT formula
      in EACH target cell with its own range — there is no fill-down and no `$`:
        running total:  at("B2",'=SUM(A2:A2)'), at("B3",'=SUM(A2:A3)'), at("B4",'=SUM(A2:A4)')
        row totals:     at("D2",'=SUM(A2:C2)'), at("D3",'=SUM(A3:C3)'), at("D4",'=SUM(A4:C4)')
    • if a task REQUIRES SCAN/BYROW for that column, each cell must STILL resolve to ONE
      number — extract it with a [position] index (0-based); never leave the raw array in a cell:
        at("C2",'=SCAN(0,B2:B2,LAMBDA(a,v,a+v))[0]'), at("C3",'=SCAN(0,B2:B3,LAMBDA(a,v,a+v))[1]') …
        at("D2",'=BYROW(A2:C4,LAMBDA(r,SUM(r)))[0]'), at("D3",'=BYROW(A2:C4,LAMBDA(r,SUM(r)))[1]') …
  A lone =SCAN(…)/=BYROW(…) sitting in one cell is the #1 way these tasks render wrong — don't.

DICTS & LISTS (structured values in cells + how to read them back)
  Literals (infix): `={name: "kirk", age: 7}` (keys bare or "quoted") and `=[1, "two", A1]`.
  Values are full expressions — a cel ref inside stays a REAL dependency (reactive).
  Typed-in data (no `=`): `{"a": 1}` / `[1,2,3]` — JSON content enters as the value itself.
  ACCESS from another cell — dot for members, [ ] for 0-BASED positions (JS-domain;
  INDEX() stays 1-based Excel-domain), negatives from the end, [from:to] slices:
    =A2.age          =A2.users[0].name        =fish!A1.species     (cross-sheet)
    =B2[0]  =B2[-1]  =B2[1:3]  =B2[:2]        =A2[B1]              (dynamic key)
    =LET(o, A2, o.age + o.xs[2])              (bound names walk the binding)
    =SUM(MAP(A2.xs, LAMBDA(x, x*10)))         (a dict's list feeds MAP/REDUCE/…)
  BROADCAST — dot over a RANGE of dict cells (or an array-of-dicts value) maps
  per item, skipping empty cells; brackets stay positional (raw, no skip):
    =D1:D9.age       =SUM(D1:D9.age)          =fish!A1:A9.species
    =D1:D9.user.name (chains re-broadcast)    =D1:D9[0]  (first CELL's value)
    =A2.rows.n       (array value broadcasts the same way as a range)
  A dotted name whose head ISN'T a cell ref (fg.g1.spec, viewport.mobile) is still an
  exact CEL KEY — only an A1-shaped head means member access. Missing members read as
  blank (like an empty cell), not an error. Objects/arrays display as raw JSON-ish text;
  wrap in =json(A2) to inspect, or MAP → dom() to render.
  TABLES & CONVERTERS (collections segment) — the hub form is the LIST OF DICTS:
    =rows(A2:C9, A1:C1)      header range + data range → list of dicts
    =table(rows(A2:C9, A1:C1))   render it as an HTML table in a view pane
    =unique(D1:D9.tag)       set discipline (order-preserving, structural)
    =jsonparse(s)            JSON string value → object/array (inverse of json())
    =dbseed('db', rows(A2:C9, A1:C1), 't')   …and into SQLite
  SEED YOUR INPUTS + LABEL THE OUTPUT: a formula over empty cells shows 0/blank, and a
  bare scalar answer is nothing to look at. If a task says "price in A1, qty in A2",
  build a LABELED sheet that seeds the inputs so the result is visible:
    =cels("inv",4,2, at("A1","Price"), at("B1",12), at("A2","Qty"), at("B2",3),
      at("A3","Subtotal"), at("B3",'=B1*B2'),
      at("A4","Grand total"), at("B4",'=LET(s, B1*B2, s + s*0.13)'))

RENDER A LIST (a collection → repeated DOM — this is how data becomes UI)
  dom() FLATTENS an array child, so turn a range into repeated elements by MAPping it:
    =dom("ul", MAP(todo!A1:A5, LAMBDA(t, dom("li", t))))            one <li> per row
  FILTER(range, LAMBDA(x, pred)) keeps only matching values — render a SUBSET:
    =dom("ul", MAP(FILTER(nums!A1:A9, LAMBDA(x, x>0)), LAMBDA(x, dom("li", x))))
  null/""/false items in the array are dropped (so a MAP that yields "" omits that child).
  To carry per-row IDENTITY (so a click/drag knows WHICH row it is), MAP over an ID column
  (seed col A = 1..N) and use the id to BUILD the cel key + READ the fields with INDEX:
    =dom("div",
      MAP(todo!A1:A5, LAMBDA(id,
        dom("div.row",
          on("click", "some.handler", CONCAT("todo.B", id)),     ← payload NAMES this row's cel
          INDEX(todo!B1:B5, id)))))                               ← INDEX reads this row's field
  MAP iterates a DATA RANGE or an inline list literal — for a FIXED, small set of sections
  (a few columns or tabs) MAP over the list, or define the section once as a LAMBDA (via
  LET) and CALL it per section:
    =dom("div", MAP(["Left", "Middle", "Right"], LAMBDA(name, dom("div.col", dom("h3", name)))))
    =LET(section, LAMBDA(name, dom("div.col", dom("h3", name), …use name…)),
      dom("div", section("Left"), section("Middle"), section("Right")))
  A LET-bound LAMBDA can call EARLIER LET names and see the calling LAMBDA's params, so a
  section can reuse a shared "card"/"row" LAMBDA and the section's own name together.

DRAG & DROP — "a drop writes a cel" (reusable: boards, buckets, file moves, assignment)
  Make an item DRAGGABLE and have it NAME a cel; make a drop ZONE carry a VALUE:
    item: =dom("div", attr("draggable","true"), on("dragstart","drag.grab","todo.B2"), "a task")
    zone: =dom("div", on("dragover","drag.over"), on("drop","drag.drop","Done"), "Done")
  Dropping the item runs drag.drop → sets todo.B2 := "Done". (on("dragover","drag.over") is
  REQUIRED on the zone — without it the browser fires no drop.) Movement is REACTIVE: if a
  view FILTERs/reads that cel, the item RE-RENDERS in its new place automatically — you never
  move it by hand. drag.active remembers the grabbed cel between grab and drop.

DATABASE (browser SQLite — persistent, runs in a Worker; the db NAME is the handle)
  =sql("mydb", "create table t(a,b)")     run SQL on a db; writes persist. The first arg is the db name
  =sql("mydb", "select * from t")         …or a handle from =db(); SELECT returns rows
  =dbseed("mydb", rows, "t")              bulk-load a JSON array of row-objects (or a range) into table t
  =schema("mydb")   =tables("mydb")       introspect tables/columns/PK·FK   ·   list table names

FILES (OPFS, in-browser)
  =write("/a.txt","hi")  =cat("/a.txt")  =ls("/")  =mkdir("/d")  =upload("/")

WINDOWS / LAYOUT
  =wopen(key,"title","body")   =jail(seed)     =doom()  (Doom in a wasm window, consent-gated)
  =cels("app",5,2, geom(40,40,520,360))   geom(x,y,w,h[,minW,minH]) sizes a sheet's own window

APP = DATA SHEET + WINDOW (one pasteable, shareable formula)
  =wopen(id, "Title", '=<formula>')    a draggable WINDOW whose body is a REACTIVE formula
  =segment(part, part, …)              compose cels()/wopen()/def() parts into ONE formula
  The idiomatic app is a data sheet + a window that reads it — one formula in, one link out:
    =segment(
      cels("todo", 4, 2, at("A1","Task"), at("B1","Status"),
        at("A2","Email Bob"), at("B2","To Do"), at("A3","Ship"), at("B3","Done")),
      wopen("todo", "To Do",
        "=dom('div', MAP(todo!A2:A3, LAMBDA(t, dom('div.card', t))))"))
  The window body reads the sheet by GLOBAL ref (todo!A2:A3) even though it is a different
  segment. Two string levels: top-level args are "…", the nested window body is '…'.

SEGMENTS — every workbook / window / app you make is a SEGMENT (a named layer)
  =segments()                  list the loaded segments
  =members("seg")              the cels in a segment
  =nav(viewport.mobile, item(…))  a navbar that switches between your segments/windows (see NAVBAR below)
  Each =cels/=wopen/=doom/=jail MINTS a document segment (kind workbook/window/
  wasm/jail); the substrate (net/dom/origin/…) is reserved and not exported.

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
        item("🥧 Pie", '=cels("pie",5,2, at("A1","Item"), at("B1","Value"), at("A2","Apples"), at("B2",10), at("A3","Pears"), at("B3",20), at("A4","Plums"), at("B4",15), at("A5", "=canvas(360,200, piechart(pie!A2:A4, pie!B2:B4))"))'),
        item("📈 Bar", '=cels("bar",5,2, at("A1","Item"), at("B1","Value"), at("A2","Q1"), at("B2",30), at("A3","Q2"), at("B3",45), at("A4","Q3"), at("B4",25), at("A5", "=canvas(360,200, barchart(bar!A2:A4, bar!B2:B4))"))')),
      item("元 Origin", "元"))
  A chart INSIDE a submenu sheet works WITHOUT a third quote level: a chart formula has
  no inner string quotes, so wrap the sheet action in '…' and the chart in "…" —
  `at("A5", "=canvas(360,200, barchart(bar!A2:A4, bar!B2:B4))")`. NEVER reach for
  backticks to get depth (`infix: unexpected character` — a hard parse error).

RESPONSIVE LAYOUT (the page is the product — use the whole viewport, don't cram)
  The result is a full plastron.ca PAGE, not just a cell. An app-like formula
  should claim space: open a sized window, or size DOM to the viewport.
  - viewport.w / viewport.h / viewport.mobile / viewport.orient — reactive cels;
    a formula that references them RE-RUNS on resize. =viewport() = a one-shot {…}.
  - =wopen("app", "App", body, geom(0, 0, viewport.w, viewport.h - 40))   fill the screen
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
SELF-SERVICE URLs (open one → it answers in PLAIN TEXT; no app runs):
- `https://plastron.ca/#check=<url-encoded-formula>`  → "✅ VALID" or "❌ INVALID + error".
- `https://plastron.ca/#encode=<url-encoded-formula>` → the compressed `#f=` link for it.
      Example: to share `=cels(3,3)` → open `https://plastron.ca/#encode=%3Dcels(3%2C3)`.

THE #f= CODEC — build a link by hand, no app needed. `#f=<payload>` where payload is:
      tag "0" + base64url(utf8(formula))              ← plain
      tag "1" + base64url(deflateRaw(utf8(formula)))  ← compressed (raw DEFLATE)
  Emit whichever is SHORTER; the leading tag char tells the decoder which. base64url =
  base64 with "+"→"-", "/"→"_", trailing "=" stripped. **No JSON wrapper.** Worked (plain):
      =1+1  →  utf8 3D 31 2B 31  →  base64url PTErMQ  →  #f=0PTErMQ

ENCRYPTED links — the URL param NAMES the method (a self-describing booter):
- `=encrypt(pass)`  → `#aes256gcm=<payload>`  (passphrase prompt on open)
      payload = base64url( salt[16] ‖ iv[12] ‖ AES-256-GCM(deflateRaw(formula)) )
      key = PBKDF2-HMAC-SHA256(pass, salt, 600k) → AES-256. Compress-THEN-encrypt.
- `=otpEncrypt()`   → `#otp=<padId>.<payload>`  (one-time **pad** = Vernam, NOT a password)
      payload = base64url( (formula XOR pad) ‖ oneTimeMAC[16] ). NO compression (would leak length).
      A one-time Carter–Wegman MAC over GF(2^127-1) makes integrity unconditional too. ONE pad
      = ONE message; never reuse a pad. `=otpDecrypt(url)` decodes it (file picker for the pad).

Opening any `#f= / #raw= / #aes256gcm= / #otp=` link is safe: it boots locked — every
dangerous fn (net/storage/db/code/secrets) is blocked until a human Allows it.

SEGMENT ARCHIVES — the lossless complement to formula-share (=link/=seed):
- `=export("seg")`            → a 甲骨 archive json string of one document segment
- `=export("seg","formula")`  → its re-minting =cels(…)/=def(…) formula
- `=export("seg","encrypt",p) → an `aes256gcm:<blob>` (encrypted archive)
- `=export()`                 → the whole document stack (substrate excluded)
- `=import('{…}')` / `=import(blob, pass)` → load it back: ADD or wholesale-REPLACE
  a same-named segment (refuses a reserved substrate name). Mix in, either form out.

────────────────────────────────────────────────────────────────────────────
WORKED ONE-TIME-PAD DEMO (the pad is PUBLIC → a codec demo, not a secret message)
────────────────────────────────────────────────────────────────────────────
[[OTP_DEMO]]

────────────────────────────────────────────────────────────────────────────
FULL VERB CATALOG (baked from the =help text mode at build time — current as of this deploy)
────────────────────────────────────────────────────────────────────────────
[[VOCAB_CATALOG]]
