# 🐢 plastron

a spreadsheet app in a single index.html — Apache-2.0 licensed.

**[What it is, and the problem it solves → the wiki](https://www.tinygnomes.com/qwiki.cgi?mode=previewSynd&uuid=W29CUCASQE4T43B8QDCP8B95S7QT)**

**[Try it live — with all the example formulas → plastron.ca](https://plastron.ca)**

**🤖 LLMs / agents:** how to use plastron — the verb catalog, share-link formats (`#f=`, `#aes256gcm=`, `#otp=`), and worked example formulas — is served as plain text at **[plastron.ca/llms.txt](https://plastron.ca/llms.txt)**. Fetch that URL directly; the in-page guide is hidden DOM that most extractors strip.

<!-- Discussion: add the Show HN link here once posted, e.g.
**Discussion:** [Show HN: Plastron](https://news.ycombinator.com/item?id=...) -->

**Everything is a dag.**

**The contract: the grid is the entire program.** Every decision — every rule, parameter, and composition — is authored in a cell and referenceable as one. Native verbs supply mechanism only: pure, generic, one-sentence contracts, zero policy. Bulk state may live off-grid, but only as a derived cache of on-grid decisions, probeable through cells.

We will have won when some new spreadsheet jockey or a buck private under a shelter half with a toughbook almost a brick for the quality of the software on it implements a better version of vlookup in wat for fun.

---

<!--LLMS_GUIDE_START-->
<!-- GENERATED from plastron-examples/origin/llms.md by bun bundle.ts — edit llms.md, not here. -->
<details>
<summary><b>📖 Full LLM / agent guide</b> — the plastron formula reference (also at <a href="https://plastron.ca/llms.txt">plastron.ca/llms.txt</a>)</summary>

~~~
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
  formula  =dom("h1", "🐢 turtles all the way down")
  pad      https://plastron.ca/card.png  (237084 bytes — download it, load it in the picker)
  link     https://plastron.ca/#otp=card.png.tDQhKiUocjsiLCAvudfU8CB0ccJ0bGcFKGNsbCC0Sokrd2FpIC0rNjpatQy315CfU1qkRszr88szruI

────────────────────────────────────────────────────────────────────────────
FULL VERB CATALOG (baked from the =help text mode at build time — current as of this deploy)
────────────────────────────────────────────────────────────────────────────
functions (call as (name …) or =name(…)), grouped by segment:

[asset-loader]
  asset.fetch  — (state, name [, {base?, cache?, onProgress?}]) → Uint8Array. Fetch a named binary asset from base+name, cached in OPFS at /plastron/assets/<name> so it downloads once and reloads instantly. The one mechanism behind every heavy lazy tier (doom WAD, and rapier/maplibre/occt/three to come). cache:false skips the cache; caching is best-effort — a missing file-store/OPFS silently degrades to a plain fetch.

[buffer-schema]
  buffers_dehydrate
  buffers_hydrate
  buffers_isChanged

[builtins]
  *  — Variadic product. Coerces args via Number(); 0 args → 1.
  +  — Variadic sum. Coerces args via Number(); 0 args → 0.
  -  — Variadic subtract. 0 args → 0; 1 arg → negation; ≥2 args → left fold.
  /  — Variadic divide. 0 args → NaN; 1 arg → reciprocal; ≥2 args → left fold.
  json  — (value) — turn any value into a pretty-printed JSON string (JSON.stringify(value, null, 2)). Use it to read an object/array cel as text instead of "[object Object]": =json(clients.C1) renders the chat message list as readable JSON.
  parseRange  — Parse range notation ("Seg!A1:B3", "1,1:2,2") → Range { at, shape }. Passes a Range struct through; null when unparseable.
  rangeToKeys  — Enumerate a Range (struct or notation string) into row-major member cel keys — the Key[] shape inputMap accepts.

[charts]
  barchart  — (labels, values [, x] [, y] [, w] [, h]) - bar-chart ops for canvas(): one bar per row, value above, label below. labels/values are column ranges: =canvas(420, 260, barchart(turtles!A2:A8, turtles!B2:B8)). Default box 0,0,420,260; pass x/y/w/h to place several charts on one canvas. Edits to the range re-render the chart.
  linechart  — (labels, values [, x] [, y] [, w] [, h]) - line-chart ops for canvas(): one series as a polyline with point dots, gridlines with value ticks, labels along the x axis. =canvas(420, 260, linechart(turtles!A2:A8, turtles!C2:C8)).
  piechart  — (labels, values [, x] [, y] [, w] [, h]) - pie-chart ops for canvas(): wedges from 12 o'clock + a legend with each row's value and share. Non-positive values drop out. =canvas(420, 260, piechart(turtles!A2:A8, turtles!D2:D8)).

[checkpoint]
  checkpoint  — (name) - vocabulary head: value is a checkpoint request; the channel drain takes the snapshot.
  checkpoint.delta  — (state, from, to?) - {added, removed, changed} cel keys between two snapshots, or snapshot vs live when to omitted.
  checkpoint.drain  — (items) - take dehydrate snapshots for enqueued checkpoint requests; ring capped at 20.
  checkpoint.list  — (state) - snapshot names in ring order.
  checkpoint.restore  — (state, name?) - DISPATCHED ONLY: wipe non-kernel user-space, rehydrate the named (or latest) snapshot, precompute, cycle.
  checkpoint.snapshot  — (state, name) - imperative snapshot (gestures/drains call this directly).

[cli-segment-export]
  exportToDir  — CLI-only. Async. (state, targetDir, opts?) -> { exportedSegments, targetDir }. Copies the plastron/ store (mirroring its layout) to targetDir/plastron/. opts.onlySegments?: Key[] (default: everything except the kernel closure); opts.includeTransitiveDeps?: boolean (default true when onlySegments is set); opts.includeKernel?: boolean (default false); opts.overwrite?: boolean (default false — refuses if targetDir/plastron exists). Rebuilds targetDir/plastron/index.json from the copied set. Pure file op; does not touch state.cels. Installed only when file-store.backend === 'node-fs'.
  importFromDir  — CLI-only. Async. (state, sourceDir, opts?) -> { importedSegments }. Reads sourceDir/plastron/segments/<name>/<version>/{manifest,segment}.json and writes each into the local segment-store. Refuses role:kernel pairs (kernel comes from the local bundle). Throws on name@version collision unless opts.overwrite is true. Installed only when file-store.backend === 'node-fs'.

[collections]
  jsonparse  — (s) - parse a JSON STRING VALUE into the object/array it encodes — the runtime twin of typed-in `{…}`/`[…]` data entry, and the inverse of json(). A non-string passes through unchanged (already parsed); invalid JSON is a #VALUE!-style cel error IFERROR can catch. =jsonparse(cat('/data.json')).users[0].name.
      e.g. =jsonparse(cat('/data.json')).users[0].name
      Entry routes differ by TIER, not representation: typed-in
      {"a":1} mints a writable ValueCel, ={a:1} mints a derived
      FormulaCel — same shape, different writability. jsonparse is the
      runtime route for JSON that arrives as a STRING value (cat(),
      fetch, sql text): parse once at the boundary, then the one
      access algebra applies.
  rows  — (data, headers?) - tabular data → a LIST OF DICTS (the hub form the collections doctrine converges on). data: nested row arrays whose FIRST row is the header ([["name","age"],["ada",36]] — the S-expr range shape, or BYROW output), OR a flat value list plus an explicit headers array (=rows(A2:C4, A1:C1) — the infix range shape: headers give the column count, the flat data chunks into rows), OR an already-dict list (identity). Empty rows are dropped. Feed the result to table()/dbseed()/broadcast dot access (=rows(...).age).
      e.g. =rows(A2:C4, A1:C1)  →  [{name:"ada", age:36}, …]
      The collections doctrine converges every tabular shape on this
      ONE hub form so the access algebra never changes as data moves
      between forms: =sql/supabase results already ARE it, dbseed
      consumes it, broadcast dot access (=D1:D9.age) reads it. Convert
      at the boundary with rows() instead of reshaping by hand —
      nothing else does range→dicts.
  table  — (rowsOrData, opts?) - render a LIST OF DICTS as an HTML table vnode (class pl-table) for a view pane: columns are the union of row keys in first-seen order, header from the keys. Accepts anything rows() accepts (nested header-row arrays convert automatically). opts: {cols: ["name","age"]} selects/orders columns; {limit: n} caps rows (a '… N more' footer row shows the truncation). Values render via json-ish text; nested objects stringify. =view('people', table(rows(A1:C9))).
      e.g. =view('people', table(rows(A2:C9, A1:C1), {limit: 20}))
      Tables are VIEWS over plain JSON-shaped values, not a storage
      shape — there is no table object to mutate. Edit the value/range
      the table reads and the view re-renders reactively. And no
      value→range spill: ranges are authored, never exploded into (the
      no-spill doctrine).
  unique  — (list) - SET discipline for a list value: drop duplicates, keep first occurrence, preserve order. Primitives compare by value; dicts/lists by structural (JSON) equality. Non-array input returns a one-item list (or [] for blank). =unique(D1:D9.tag) → the distinct tags.
      e.g. =unique(D1:D9.tag)  →  the distinct tags, first-seen order
      Sets are lists with a uniqueness DISCIPLINE, not a fifth storage
      form — keep set semantics in this verb rather than reaching for
      a new container (no DICT()/ARRAY(): literals + JSON entry cover
      construction).

[crdt]
  crdt.append  — (stack, record) — grow-only insert of a layer into a diff stack, returning a NEW array sorted by (ts, author, id) and deduped by id. Idempotent: re-appending the same record (same id) is a no-op. The stack is the CRDT value; hold it in a ValueCel.
  crdt.apply  — (text, ops) — apply an array of hunks { at, del, ins } to a string and return the new string. Total/defensive: clamps out-of-range at/del so a stale hunk never throws (it just lands as close as it can). Hunks apply high-index-first so earlier `at` stay valid.
  crdt.diff  — (before, after) — minimal LINE-LEVEL diff between two strings as an array of hunks { at, del, ins:[lines] }: at line `at`, delete `del` lines and insert `ins`. One result covers multiple lines. Invariant: (crdt.apply before (crdt.diff before after)) === after.
  crdt.layer  — (before, after, author, ts [, parent]) — one diff-stack layer: { id, author, ts, parent, ops } where ops = (diff before after) and id = `ts.author.<hash(ops)>` (deterministic; identical edits dedup). ts is caller-supplied (pass a Lamport counter or a `now` cel) so the verb stays pure & replayable. parent = id of the head this edit saw (causality).
  crdt.resolve  — (stack [, n]) — fold a diff stack from the empty string over its layers (sorted by ts, author, id) to the current text. With n, apply only the first n layers — n edits up from 0 (time-travel / undo). Every replica folds the same set the same way → convergent. =crdt.resolve(msg.stack) renders live text; recomputes whenever the stack cel changes.

[crypto]
  crypto.datakey  — () - mint a fresh random AES-256-GCM data key (base64 raw bytes) - the per-epoch symmetric key a shared segment wraps to recipients.
  crypto.decrypt  — (dataKeyB64, 'ivB64.cipherB64') - AES-256-GCM decrypt; returns the utf8 plaintext.
  crypto.encrypt  — (dataKeyB64, plaintext) - AES-256-GCM encrypt; returns 'ivB64.cipherB64'.
  crypto.forget  — (handle) - drop a key from the keystore (rotation / revoke); returns whether it existed.
  crypto.keygen  — (kind?) - Tier 1: mint a NON-EXTRACTABLE private key (Ed25519 'sign' default, or P-256 'ecdh' for wrap/unwrap) in the keystore; returns a CryptoKeyHandle (id + public). The private key is never a cel value.
  crypto.keys  — () - list the keyring as handles (public material only; private keys never surface).
  crypto.prfAvailable  — () - Tier 2 probe: is WebAuthn PRF (passkey) available in this host? (browser-only; false in Bun).
  crypto.prfWrapKey  — (credentialId?, saltB64?) - Tier 2 SCAFFOLD: derive a wallet-blob wrapping key from a passkey's PRF secret via KDF. Deep integration is a browser e2e follow-up; reports status when PRF is unavailable.
  crypto.pubkey  — (handle) - the PUBLIC key as a cel-storable base64 string (the keyring's shareable currency).
  crypto.seedExport  — () - Tier 3 RECOVERY ONLY (not login): export a 12-word recovery phrase for account recovery / device migration.
  crypto.seedImport  — (phrase) - Tier 3 RECOVERY ONLY: validate + import a 12-word recovery phrase (identity re-derivation is the device-migration follow-up).
  crypto.sign  — (handle, message) - Ed25519 sign; the private key is resolved at the effect site from the keystore, never surfaced. Returns base64 signature.
  crypto.unwrap  — (myEcdhHandle, senderPubB64, 'ivB64.cipherB64') - ECDH P-256 unwrap; returns the data key (base64).
  crypto.verify  — (publicKeyB64|handle, message, signatureB64) - Ed25519 verify against a public key; returns boolean.
  crypto.wrap  — (myEcdhHandle, recipientPubB64, dataKeyB64) - ECDH P-256 derive + AES-GCM wrap the data key to a recipient; returns 'ivB64.cipherB64'.

[defn]
  defn.drain  — (items) - commit binder requests: setCel EditableLambdaCels (definedBy/origin stamped), enforce ownership + overwrite flag, retire renames and orphans (binders are authoritative for a name's existence).

[docgraph]
  wiki  — (name?) - a button that opens the wiki window on `name` (a cel key, function, segment, or win.<id> layer). =wiki("runCycle"). The article shows summary/doc metadata, the formula source, links to the functions it calls and its input cels (from inputMap), backlinks, a force-directed neighborhood graph, and an editable note saved to metadata.note. Navigation: click any link or graph node.
  wiki.open  — dispatch (state, key) - assemble the wiki article for `key` (a window state ref like win.x.state articles its layer), stash it in wiki.article, lazily create + open + raise the win.wiki window (the frame only when origin's mount resolves), paint. The W titlebar button and every in-article link dispatch this.
  wiki.openSource  — dispatch (state, key) - open the ⧉ source window on a node: live source + github link, in its own draggable window (lazy win.wikisrc, the win.wiki pattern).
  wiki.saveDesc  — dispatch (state) - write the wiki.descDraft buffer to the current entry's metadata.description (metadata-only setCel). The wiki is editable: every render (inspect, vocab, wiki, skill) reads the same field. Runtime-local until the document dehydrates.
  wiki.saveNote  — dispatch (state) - write the wiki.noteDraft buffer to the current entry's metadata.note (metadata-only setCel: merges, never touches structure). Layer-1 set-policy refusals surface in the draft box instead of throwing.
  wikidoc  — (article) - passthrough for the wiki window's content cel: renders the article vnode wiki.open assembled, or a hint when none is open.
  wikisrc  — (doc) - the source window's content: a node's LIVE source (formula f, or the bound native's toString - always the running code) + its github link. GitHub cannot be iframed (X-Frame-Options deny); the live source is strictly better anyway.

[dom]
  attr  — (name value …) - HTML attributes (href, target, type, id, …); pass as a child of dom().
  dom  — (tag, ...children) - a presentation vnode value. tag.class is emmet sugar; string children → text, nested dom(…) → elements, (style …)/(attr …)/(on …) → that element's style/attributes/events. An ARRAY child is FLATTENED in place, so a collection from MAP/FILTER renders as sibling children: (dom 'div' (MAP tasks!A1:A6 (LAMBDA t (dom 'div.card' t)))); null/''/false items are dropped. Children must be vnodes/strings/arrays/style/attr/on — NOT a genesis: cels()/segment() build sheets and don't nest here (they'd stringify to "[object Object]"); make the grid top-level instead.
  dom.applyListenerDelta  — Global-listener reconciliation: diff prev vs next listener-spec arrays and add/remove on the named global targets.
  dom.applyPatch  — DOM-mutating patch applier (browser only): (target, mounted, patch, reg, state, doc) → new mounted node. Maintains the per-element listener registry.
  dom.diffVNodes  — Pure vnode diff: (prev, next) → JSON Patch. Positional children by default; keyed reconciliation when both lists are fully keyed.
  dom.paint.drain  — Channel drain: forwards each buffered view cel's render-spec to the painter's batched enqueue.
  drag.drop  — drop handler: assigns the zone's VALUE to the cel named in drag.active, then clears it. A drop zone carries its value as the payload - (on 'drop' 'drag.drop' 'Done'). Movement is reactive: any formula referencing the assigned cel re-renders the item in its new place.
  drag.grab  — dragstart handler: records WHICH cel the dragged item names into drag.active. Make an item draggable with (attr 'draggable' 'true') and (on 'dragstart' 'drag.grab' <celKey>).
  drag.over  — dragover handler: preventDefault so the browser allows a drop. REQUIRED on any drop zone - (on 'dragover' 'drag.over'). No drop event fires without it.
  img  — (src... , style()/attr() children) - an image element. String args form a src fallback chain (first non-empty wins). A "/path" src references a file in OPFS: the painter hydrates it to an objectURL via file-store after paint, so formulas reference images by filesystem path - (img desktop.A2 windows.wallpaper (style ...)). data:/http(s)/blob srcs pass straight through.
  on  — (event handlerKey [payload]) - bind a dom event to a handler cel; pass as a child of dom(). =dom("button", on("click", "origin.tone", 440), "♪"). The handler runs (state, payload, event).
  replay.canvas2d  — (el, state) - the 2-D replayer: parse the element's data-ops draw-spec and replay it onto the 2d context (plastron-canvas vocabulary); animated ops (frames/draggable) get a self-cancelling rAF loop. The per-element half of the old drawCanvases walk.
  style  — (prop value …) - inline styles for a dom element; pass as a child of dom().

[doom]
  doom  — () - open a DOOM window: a wasm app (canvas) running Doom, lazy-fetching doom.wasm + the WAD from plastron.ca. Arrow keys / Ctrl (fire) / Space (use) drive the player when the window is focused. =doom()
  doom.arm  — (state) - fired when the DOOM window materialises; RAF-defers doom.boot so the canvas is mounted before the engine grabs it.
  doom.boot  — (state) - the browser boot: consent-gate the asset load, fetch doom.wasm + WAD, createDoomHarness, hydrate the kind:wasm engine cel, start the RAF tick loop.

[ecs]
  automaton  — (grid, w, h, rule) - one generation of a toroidal 8-neighbour cellular automaton on a flat w*h grid. The RULE lives in a cell (grid-program contract): a KERNEL callable (alive, count) -> 0|1 - author it as =LAMBDA(alive, n, ...) or a wat lambda (same ABI) - or a B/S rulestring as policy-as-data ('B3/S23' = Conway, 'B36/S23' = HighLife). The mechanism is only the neighbour count. Returns a NEW array so a skipEqual commit freezes cleanly on still lifes.
  bufstats  — (buffers, gen) - probe the dense interior: {gen, n, meanSpeed, maxSpeed} summary of a SoA buffers struct. Reference the generation cel as gen so the probe re-derives on every committed frame - gen is part of the output (stats as-of generation gen), which is what makes the off-grid buffer observable through the grid.
  flockSeed  — (n, seed, w, h, d) - a deterministic seeded flock: the SoA buffers struct {n, positions: Float32Array(3n), velocities: Float32Array(3n)} for n entities in a centered w*h*d box (mulberry32 - same seed, byte-identical flock). Meant as a pump effect's init so archives never carry the floats; bind metadata.schema:'buffers' on the cel for snapshot round-trips.
  gridops  — (op, grid, w, h, cell, ...args) - render the truthy cells of a flat w*h grid: op(px, py, cell-1, cell-1, ...args) per live cell. With rect that is a filled square per cell; the -1 leaves a hairline grid gap.
  integrate  — (positions, velocities, dt) - Euler step over pair tables: [[x,y],...] + [[vx,vy],...] -> [[x+vx*dt, y+vy*dt],...].
  neighbors  — (positions, radius, ...tables) - per-entity spatial query over a [[x,y],...] table: for entity i, an array of [pos_j, ...table_j] rows for every OTHER entity j within radius. Extra tables let a rule see neighbors' velocities etc. Naive O(n^2) - fine for hundreds of entities.
  opmap  — (op, table, ...args) - render a component table with an existing canvas-op builder: each row is spread into op, trailing args appended. =canvas(w, h, opmap(circle, positions, 3, '#4fc3f7')) draws one dot per entity (canvas flattens op arrays).
  param.set  — (state, celKey, event) - generic input->cel binding for on(): writes the event target's value to the cel named by the payload. Ranges/numbers write valueAsNumber, checkboxes write checked, everything else the string value. =dom('input', attr('type','range',...), on('input', 'param.set', 'ecs.cohesion')).
  sim.run  — (state, configKey) - start the tick pump named by a config cel: { commits?: [{to, from, every?, skipEqual?}], effects?: [{fn, kernel?, buffers, params?, gen, init?, initArgs?}], while?, fps? }. COMMITS route derived *.next cels back into table cels through the graph (the formula-tier loop). EFFECTS are the dense-interior loop: call fn(buffers, params, kernel) to mutate SoA typed arrays IN PLACE, seed via init(...initArgs) when the buffer cel is empty, and write gen=frame - the generation write re-fires sceneframe cels so scene.paint drains dirty instances; per-frame entity state never crosses the graph. fn / kernel / init are CALLABLES - reference the verb and lambda cels in the config formula (fn: swarmstep, kernel: E1, init: flockSeed) so the reference IS the dependency edge; never name them as strings. buffers/gen are cel-KEY strings (write targets the pump owns); params is an embedded object or a cel-key string read live. every=N commits on every Nth frame; skipEqual skips content-equal writes; while names a window state cel - the pump stops when it closes. The config cel is re-read every frame, so fps and every knob it derives from are live. Returns 'running' or 'already running'.
  sim.stop  — (state, configKey) - stop the tick pump started by sim.run for this config cel.
  swarmstep  — (buffers, params, kernel) - one simulation step over the SoA struct, IN PLACE, as pure MECHANISM: spatial-hash neighbor aggregates per entity (cell = radius, params.maxNeighbors cap, default 24), then the KERNEL decides each new velocity, then commit + integrate + toroidal wrap in the centered box. The kernel is the RULE and lives in a cell (the grid-program contract): an infix =LAMBDA for the legible tier or a wat lambda cel for the compiled tier - same ABI: kernel(px,py,pz, vx,vy,vz, n, cx,cy,cz, ax,ay,az, sx,sy,sz, cohesion, alignment, separation, maxSpeed) -> [vx,vy,vz], where n = neighbors found, c* = neighbor centroid, a* = mean neighbor velocity, s* = inverse-square separation sum (all zeros when n=0). params = {cohesion, alignment, separation, maxSpeed, radius, dt, w, h, d, maxNeighbors?} - author it as an infix object-literal FormulaCel over sheet cells and the sim re-derives on every edit. Deterministic (no RNG). Use as a sim.run effect: {fn: swarmstep, kernel: E1, ...}.
  sysmap  — (rule, ...args) - run a per-entity rule over parallel component tables (entity = array index). N comes from the first array arg; any array of exactly length N is sliced per entity, everything else (params, dt, colors) broadcasts; the entity index arrives as the rule's last argument. A lambda cel referenced in the formula contributes its CALLABLE, so =sysmap(D6, positions, velocities, ...) receives a real function - author the rule as a =LAMBDA cell (the grid-program contract: rules are cells, never native). Returns the length-N result table.
  workbook  — (id, title, geom?, ...'kind:title:ref') - a formula-friendly wbopen: genesis a self-mounting gen-2 WORKBOOK window over EXISTING content cels. Tab specs are flat strings because infix cannot author {ref,title}[] arrays: 'sheet:params:ecsv.params' fills the left celBook (worksheets), 'view:fish:ecsv.fish' the right cardBook (dom views). =workbook('ecs', 'ECS', geom(0.3, 0.06, 900, 560), 'sheet:params:ecsv.params', 'view:fish:ecsv.fish').
  wrap  — (positions, w, h) - toroidal wrap of a [[x,y],...] table into the box [0,w)x[0,h).

[file-explorer]
  download  — (path) - a button that downloads an OPFS file to your disk.
  explorer  — (cwd, preview, listing) - a PURE OPFS file-explorer vnode: renders the folders (📁, click→explorer.nav to descend) and files (📄, click→explorer.open to preview) from `listing` ({entries,previewText}) at cwd, plus a '..' row and an upload input. The async OPFS read lives in the nav/open handlers (which write explorer.listing); this fn is pure so the window content formula (explorer explorer.cwd explorer.preview explorer.listing) re-fires reactively.
  explorer.delete  — (state, path) - dispatch target for the explorer's 🗑 button: fs.delete the file, clear explorer.preview if it was showing that file, then refresh explorer.listing (reactive via the content formula — no hand-rolled repaint).
  explorer.download  — (state, path) - dispatch target for the explorer's ⬇ buttons (per-file + binary-preview) and the standalone download() button: read OPFS bytes → browser file save.
  explorer.nav  — (state, path) - dispatch target: set explorer.cwd to path (descend a folder / climb via '..'); the explorer content formula references explorer.cwd so the listing re-fires.
  explorer.open  — (state, path) - dispatch target: set explorer.preview to a file path; the explorer content formula re-fires and the listing cats it into the preview pane.
  explorer.openSheet  — (state, path) - dispatch target on a file row's DOUBLE-click: a .csv/.xlsx/.甲 file is read from OPFS and opened as a NEW standalone sheet window via sheet-host's openAsSheet (format detected by extension: csv->values grid, xlsx->fromXlsx, 甲->rich archive with cels+formulas). Any other file falls back to the single-click text-preview behavior.
  explorer.refresh  — (state) - populate explorer.listing from the current explorer.cwd/preview (one OPFS read). Host-called once at boot so the explorer window shows its initial listing; the nav/open handlers refresh it thereafter. The listing's preview is GUARDED: a known-binary extension (.wasm/.wad/.png/.甲/.xlsx/fonts/...) OR a file over 256 KB OR bytes that aren't valid UTF-8 are NEVER read as text (that would blow out browser memory) — the preview shows a 'binary file — <ext>, <size> — download to inspect' placeholder instead; only small valid-UTF-8 text files are decoded into the preview pane.
  explorer.rename  — (state, path) - dispatch target for the explorer's ✎ button: prompt() for a new name in the same dir, fs.rename the file, follow explorer.preview if it moved, then refresh explorer.listing. No-op off-DOM (no prompt available).
  explorer.rmdir  — (state, path) - dispatch target for the 🗑 on a DIRECTORY row: confirm (browser confirm() when present), fs.rmdir the tree recursively, clear any preview under it, refresh the listing. Segment-store docs are directories under /plastron/segments — prefer the Sheets 📂 picker's 🗑 for those (it also maintains the store index).
  explorer.upload  — (state, dir, event) - dispatch target for the explorer's upload input and the standalone upload() picker: write the picked file's bytes into OPFS, then refresh the explorer if open.
  explorerwin  — () GENESIS: a gen-2 file-explorer WINDOW. Seeds explorer.cwd/.preview/.listing + the (explorer …) content formula, and a self-mounting wframe window (win.explorer.state/.content/.frame). The 📁 Files launcher calls it; origin.navOpen restoreWindow-s and explorer.refresh-es it on open.
  upload  — (dir?) - a file picker; the chosen file is written into OPFS (default /).

[file-store]
  file-binary_isChanged  — isChanged protocol for file-binary. (oldV, newV) → boolean. Byte-by-byte compare; short-circuits on length mismatch.
  file-binary_mime  — mime protocol for file-binary. (v) → string. Returns 'application/octet-stream' — specialized schemas (file-image, file-doc-*) in Phase B override per type.
  file-binary_size  — size protocol for file-binary. (v) → number. Returns v.length when v is Uint8Array, 0 otherwise.
  fs.command  — (op, path [, to] [, text]) - the file-op vocabulary (ls/tree/mkdir/rm/mv/cat/write/touch/stat) as one fn over the OPFS backend; returns a formatted string. Host file verbs delegate here.
  fs.delete  — Async. (path) → void. File only — use fs.rmdir for directories. No-op if missing.
  fs.exists  — Async. (path) → boolean. True if the path resolves to any entry under the root.
  fs.list  — Async. (path) → string[]. Child names only (no slashes). Throws if path is not a directory.
  fs.mkdir  — Async. (path, recursive?) → void. Defaults recursive=true. No-op if the dir already exists.
  fs.read  — Async. (path) → Uint8Array. Throws if missing or if the path is a directory.
  fs.readText  — Async. (path) → string. UTF-8 decode of the file's bytes.
  fs.rename  — Async. (oldPath, newPath) → void. Files and directories. OPFS uses .move() with a read-write-delete fallback for older browsers.
  fs.rmdir  — Async. (path, recursive?) → void. Defaults recursive=true. No-op if missing.
  fs.stat  — Async. (path) → { size, isDir, mtime }. mtime is ms epoch; OPFS returns 0 for directories.
  fs.write  — Async. (path, content) → void. content: Uint8Array | string. Overwrites in place; auto-creates missing parent dirs.
  fs.writeText  — Async. (path, content) → void. UTF-8 encodes string before write; auto-creates parent dirs.

[forcegraph]
  fg.arm  — dispatch (state, id) - click into a graph to ARM it: while armed it owns the mousewheel (zoom, page does not scroll - the maps-embed convention). fg.disarm releases on pointerleave.
  fg.click  — dispatch (state, {id,key}, event) - a node click re-dispatches spec.onNode.dispatch with the node key, UNLESS the pointer travelled (a drag is not a click).
  fg.disarm  — dispatch (state, id) - release the wheel back to the page (pointer left the graph).
  fg.drop  — dispatch (state) - end the drag: hold the dropped node, relax the rest until no two nodes overlap, then a label anti-collision pass to spread overlapping label pills apart, then FREEZE.
  fg.grab  — dispatch (state, {id,key}, event) - start dragging a node (pointer capture; the windows pattern).
  fg.move  — dispatch (state, _, event) - the grabbed node follows the pointer; the rest relax around it live (a few iterations per move). Writes fg.<id>.pos - the formula re-renders.
  fg.set  — dispatch (state, {id, spec}) - create the fg.<id> layer cels (spec/pos/zoom) if missing, run the layout to OVERLAP-FREE (springs + repulsion + node-circle collision separation; spec.pin held at center), then a LABEL anti-collision pass that pushes overlapping label boxes apart along their least-overlap axis so the rendered text pills don't sit on top of each other, then freeze. Re-set keeps surviving node positions as warm seeds. There is no ticker - the sim runs at set time and during drags only.
  fg.toggleKind  — dispatch (state, {id,kind}) - toggle a node KIND in fg.<id>.hide (the legend chips dispatch this); hidden kinds drop their nodes and incident edges from the render. The pin never hides.
  fg.wheel  — dispatch (state, id, wheelEvent) - zoom the instance (0.35-3x) around the box center.
  fgview  — (id, spec, pos, zoom) - render a force-directed graph: canvas edges under draggable node chips (drag to move, scroll to zoom, click to act). Use IN A FORMULA with the instance cels as args so interactions re-render reactively: (fgview "g1" fg.g1.spec fg.g1.pos fg.g1.zoom). spec = { nodes: [{key,label?,size?}], edges: [[a,b]...], pin?, onNode?: {dispatch} }. Set up an instance with fg.set.
      The {nodes, edges} spec is the CANONICAL graph form (collections
      doctrine): converters from adjacency/edge-list values should
      target it rather than minting a new graph shape.

[formula-compiler]
  formula  — kind "formula" — a defn whose body is a parameterized plastron formula, not JS. Header form (p1, p2, …) => body; the body is compiled via the kernel's compileFormula and called positionally with params bound to the call args, non-param symbols (verbs, cel refs) resolved from the registry live. Lets you define reusable verbs (layout, note, glue macros) from the formula surface; the definition lives on cel.f so it is editable and wiki-visible. A formula verb is a function of its parameters — body cel refs are read live but do NOT wire reactivity into callers (pass reactive data as a parameter). Interpreted per call: cheap for UI/glue, not for hot inner loops.

[genesis]
  genesis.drain  — (items) - commit generator requests via setCelBatch: ownership + overwrite, regeneration diff (structural identity; seeds at creation, user data plane preserved), layer segment stamping, orphan sweep, unsuppressed refire of stale consumers.

[grok]
  addbot  — (name, persona?, model?) GENESIS: mint a chat bot as a grok.roster.<handle> cel — a {name, persona, model} dict merged into the bestiary (grok.bots + roster). Formula-owned document recipe: it dehydrates with the sheet that authored it, and deleting the formula sweeps the bot away. '@handle …' in the chat routes a message to it.
      e.g. =addbot("advisor", "terse formula expert", "grok-4")
  chatpane  — (transcript, draft, opts?) -> vnode. THE pure chat renderer (sheetbar pattern: instance cels as args) — author the whole chat from a GRID CELL by wrapping it in =view; referencing the cels IS the reactivity. Appkit-styled: opts.authed=false (pass signedIn(sb.<p>.auth)) gates to the login card (near-black header band, Email/Password, Sign in); signed in renders the thread — bot chips, slate-50 stream, Telegram bubbles (user solid #334155, bot/peer white-bordered — human:true dicts show 👤 name — receipts amber chips), rounded-full composer, Enter sends. opts: {project, authed, bots, bot, status, email, password} + instance wiring {title, draftCel, send, key, placeholder, chips:false} so a sibling surface (the room chat) reuses the renderer with its own verbs/cels. Inputs dispatch grok.field; buttons grok.signin/<send>/grok.pickbot/grok.signout.
      e.g. =view("chat", chatpane(grok.transcript, grok.question, {project:"default", authed:signedIn(sb.default.auth), bots:grok.bots, bot:grok.bot, email:grok.email, password:grok.password, status:grok.status}))
  grok.addbot  — (state, name, persona?, model?) -> handle. DISPATCHED bot mint: MERGE {name, persona, model} into the grok.bots dict under slug(name) (the cel chat formulas reference, so the new chip appears reactively), repaint. The formula twin is =addbot (genesis — a formula-owned grok.roster.* cel, swept with its formula).
      e.g. grok.addbot(state, 'Advisor', 'terse formula expert', 'grok-4')
  grok.applytools  — (state, toolCalls) -> [{role:'tool', tool_call_id, content}]. Apply a model reply's tool_calls THROUGH THE USER'S COMMIT PATH (typed-entry sniff -> setCel; read_cells/vocabulary read-only; evaluate_formula dry-runs in grok.scratch) and return the follow-up tool messages for the next round. Every application appends a receipt dict to grok.transcript; a write batch checkpoints first when grok.snap is on. No privileged mutation surface.
      e.g. grok.applytools(state, [{id:'1', function:{name:'write_cell', arguments:'{"key":"sheet1.B2","content":"=SUM(sheet1.A1:sheet1.A9)"}'}}])
  grok.ask  — (state, seg, question, botHandle?) -> {ok, reply, bot} | {ok:false, error}. Assemble [system(primer+persona), context+question], invoke the server-side grok proxy (supabase.invoke) WITH the tool surface (read_cells / write_cell / evaluate_formula / vocabulary); tool calls in the reply are applied through the user's commit path (receipted in grok.transcript, loop capped at 4 rounds) and the final reply — a plastron FORMULA for the bar — returns. xAI key stays server-side.
  grok.context  — (state, seg) -> string. ONE segment's SOURCE cells as plain lines (formula TEXT or value JSON), excluding sync control cels. Capped. The 🔮 formula-bar ask sends this; the chat card sends the whole workbook (grok.workbook-context).
  grok.fetch  — (state, question, botHandle?) -> {ok, reply, bot} | {ok:false, error}. DIRECT chat-completion fetch to the grok.url cel (from a gitignored .env), authorised with the signed-in user's Supabase JWT (resolved at the effect site, never a cel). Accepts {reply} or raw xAI {choices:[{message:{content}}]}.
  grok.field  — (state, cellKey, event) -> void. An input's keystroke -> a cel (login/chat card buffers grok.email/password/question). Dispatch target for on('input', 'grok.field', '<cel>').
  grok.key  — (state, project, event) -> void. The composer textarea's keydown: Enter sends (grok.send), Shift+Enter newlines. Dispatch target for on('keydown', 'grok.key', '<project>').
      e.g. on('keydown', 'grok.key', 'default')
  grok.loadmsgs  — (state, project?) -> log. Load the selected room's messages (member-gated select on appkit's chat table, oldest-first, cap 200) into grok.roomlog, mapped to chatpane dicts (mine -> role:'user'; others -> role:'assistant' + human:true + their profile name; task/report bodies show as a tagged snippet). Poll-on-send/switch — live arrival via supabase.realtime's rev bump is future wiring.
      e.g. grok.loadmsgs(state, 'default')
  grok.loadrooms  — (state, project?) -> rooms. Fetch the signed-in user's chatrooms from appkit's DB (the list_conversations RPC via supabase.data, user JWT -> RLS applies) into grok.rooms, refresh grok.peers, repaint. The roomspane ↻ Refresh button dispatches it; grok.signin auto-runs it when a rooms view is open. Errors land on grok.status.
      e.g. on('click', 'grok.loadrooms', 'default')
  grok.pickbot  — (state, handle) -> void. The chat header's bot chips: select the active bot (grok.bot := handle, if it exists in the bestiary) and repaint. Dispatched, never called from a formula.
      e.g. on('click', 'grok.pickbot', 'muse')
  grok.pickroom  — (state, roomId) -> void. 'Select one and go into chat': grok.room := id, grok.roomtitle := its title, load the room's messages, then FOCUS the roomchat view tab (window.viewTab on the workbook hosting roomchat.view, then window.raise) and repaint. Dispatched by a roomspane row click.
      e.g. on('click', 'grok.pickroom', '00000000-0000-0000-0000-000000000001')
  grok.roomkey  — (state, project, event) -> void. The room composer's keydown: Enter sends (grok.roomsend), Shift+Enter newlines. Pass as chatpane's opts.key in the room-chat formula.
      e.g. on('keydown', 'grok.roomkey', 'default')
  grok.roomsend  — (state, project?) -> string. Send grok.roomq into the selected appkit room: an RLS-gated INSERT into the chat table AS YOURSELF (author_id = your auth uid), '@*handle' summons appkit's bot-responder with the new chat_id (fire-and-forget — appkit's own mention contract), reload the log, repaint. Sibling of grok.send (the standalone grok chat), never an overload.
      e.g. on('click', 'grok.roomsend', 'default')
  grok.send  — (state, project?) -> string. The composer's Send: append the user turn to grok.transcript, send [chat primer + persona + grok.workbook-context, history] with the tool surface, run the tool loop (writes receipted), append the assistant turn. '@handle …' routes one message to that bot. Dispatched from the card, never from a formula.
      e.g. on('click', 'grok.send', 'default')
  grok.signin  — (state, project?) -> string. The login card's Sign-in button: supabase.auth signin with grok.email/grok.password, write grok.status, repaint. State-aware (the state-arg wall) — dispatched, never called from a formula.
  grok.signout  — (state, project?) -> string. The chat header's Sign-out: supabase.auth signout (revoke + forget the session), grok.status := 'signed-out' (the card flips back to login), repaint. Dispatched, never called from a formula.
      e.g. on('click', 'grok.signout', 'default')
  grok.ui  — (project, email, password, status, question, thread, authed?, bots?, bot?) -> vnode. Positional compat wrapper over chatpane — the =chatcard cardBook formula's entry. `thread` is the grok.transcript list (grok.reply mirrors it; a plain string renders as one bot bubble); `authed` is signedIn(sb.<p>.auth), defaulting to the '✓' status prefix. New docs should author chatpane from a grid cell instead.
      e.g. =grok.ui('default', grok.email, grok.password, grok.status, grok.question, grok.transcript, signedIn(sb.default.auth), grok.bots, grok.bot)
  grok.workbook-context  — (state, wbRef?) -> string. The ACTIVE workbook (win.active, else the first win.*.state with a sheets tab list) as capped plain text: every sheet's dims + source cells (formula TEXT, value JSON) and every dom-view's formula — read from the wbframe state shape {sheets:[{ref,title}], views:[…]}. This is what chat bots see.
      e.g. =grok.workbook-context()  →  'workbook win.wb1.state …\n## sheet doc (segment doc, 12×7)\ndoc.A1 = 5 …'
  loginpane  — (opts) -> vnode. The login card as ITS OWN =view surface: signed out, the appkit login card (near-black band, Email/Password, Sign in -> grok.signin); signed in, the SESSION card — avatar initial, 'Signed in as <email>' (opts.session = sb.<p>.auth), Sign out. opts: {project, authed:signedIn(sb.<p>.auth), email, password, status, session}.
      e.g. =view("login", loginpane({project:"default", authed:signedIn(sb.default.auth), email:grok.email, password:grok.password, status:grok.status, session:sb.default.auth}))
  roomspane  — (rooms, opts) -> vnode. The CHATROOMS view over appkit's conversations: one clickable row per room (🏛 lounge / 👥 group / 👤 dm, title, last-message snippet, unread badge) dispatching grok.pickroom; a ↻ Refresh button dispatching grok.loadrooms; the selected row (opts.room) highlighted; signed out -> the sign-in hint. opts: {project, authed, room, status}.
      e.g. =view("rooms", roomspane(grok.rooms, {project:"default", authed:signedIn(sb.default.auth), room:grok.room}))

[host]
  host.error  — console.error proxy. Same pattern as host.log.
  host.imports  — Read host.{log,warn,error,now,random} cels into one Record<Key,Fn> for foreign runtimes (wasm imports member / Pyodide globals). Missing cels fall back to defaults.
  host.log  — console.log proxy exposed to wasm-backed kinds. WAT modules import via (import "host" "log" ...); Python lambdas call host.log(...). Sync. Apps that want quiet runs can replace _fn with a noop after install.
  host.now  — Date.now proxy — milliseconds since the Unix epoch. Sync. Use this rather than calling Date.now inside a lambda directly: replacing _fn with a deterministic clock (e.g., a fixed counter) lets tests run replay-deterministically without monkey-patching globals.
  host.random  — Math.random proxy — pseudorandom number in [0, 1). Sync. Same testability story as host.now: swap _fn with a seeded PRNG for deterministic tests.
  host.warn  — console.warn proxy. Same pattern as host.log.

[html-template-parser]
  html-template  — Inline HTML-template parser. A FormulaCel whose `f` is the template source and `parser` is "html-template" compiles to a render-spec ({vnode, mount, listeners}). Interpolation deps auto-wire into inputMap.
  html-template-ref  — Live-editable HTML-template parser. The template source is read from the reserved input name "template" at render time and reparsed on string change. Deps are author-declared in inputMap.
  render-spec_isChanged
  string-list_isChanged
  vnode.bindings-equal  — (a, b) - EventBinding equality for event-bag diffing.
  vnode.equals  — (a, b) - deep structural VNode equality (ref-eq short-circuit at every level). Painters resolve this once per drain and thread it into their diff.
  vnode_isChanged

[io-keys]
  keys.blur  — clear keys.pressed (the stuck-key fix on window blur). Attach via window|blur|(dispatch "keys.blur").
  keys.capture  — the document keydown/keyup handler (dispatch): writes keys.event + keys.pressed, then routes on keydown. Attach via document|keydown|(dispatch "keys.capture").
  keys.route  — match the event against keys.map.<keys.active> + dispatch the action (first match wins; honors inEditable/mods/preventDefault)

[io-touch]
  touch.press  — button pointerdown (dispatch): synthesize a keydown for <key> through keys.capture (so keys.pressed/routing behave as for a real key)
  touch.release  — button pointerup/cancel (dispatch): synthesize a keyup for <key> through keys.capture
  touchcapable  — () - true on a touch device (maxTouchPoints>0 / ontouchstart). Mount the overlay only when capable.
  touchpad  — (keys) - an on-screen overlay of hold-buttons; keys=[{label,key}] write keys.pressed via touch.press/release. Doom cannot tell a thumb from a keyboard.

[js-common-schema]
  array_dehydrate
  array_hydrate
  array_isChanged
  bigint_dehydrate
  bigint_hydrate
  bigint_isChanged
  boolean_dehydrate
  boolean_hydrate
  boolean_isChanged
  date_dehydrate
  date_hydrate
  date_isChanged
  map_dehydrate
  map_hydrate
  map_isChanged
  null_dehydrate
  null_hydrate
  null_isChanged
  number_dehydrate
  number_hydrate
  number_isChanged
  object_dehydrate
  object_hydrate
  object_isChanged
  regexp_dehydrate
  regexp_hydrate
  regexp_isChanged
  set_dehydrate
  set_hydrate
  set_isChanged
  string_dehydrate
  string_hydrate
  string_isChanged
  uint8array_dehydrate
  uint8array_hydrate
  uint8array_isChanged

[js-compiler]
  js  — kind "js" — JS source (last expression must be a callable) → runtime Fn via QuickJS-emscripten (a JS-in-wasm sandbox). new Function removed (wasm-only-functions): no DOM, no eval, no host APIs unless granted via the host segment. Lazy-loads the ~1MB runtime on first compile.

[kernel]
  cel-error_dehydrate
  cel-error_hydrate
  cel-error_isChanged
  clearErrors  — Reset the kernel errors log.
  consume  — Drain one channel's queue into the caller.
  dehydrate  — Serialize non-kernel cels and manifests to JSON-shaped 甲骨 + 冊 records.
  dehydrate函  — Warm boot: emit the application as ONE 函 artifact — awake segments deflated inline, dormant payloads passed through, bundled/native as codeSeed, boot.wake = the currently-awake root cover.
  drain  — Drain a channel to empty, invoking its drain fn.
  ensureSegments  — Load every pending segment in the 冊.dependencies closure of the given names, concurrently, with a single precompute for the batch.
  f  — Default formula parser: S-expression source → CompiledLambda. Replace to swap formula languages (provide matching extractDeps).
  findDependents  — Walk 冊.dependencies to find every manifest that transitively depends on a given segment.
  flush  — Tear down a segment and its dependents; fires _dispose, removes cels, precomputes.
  forget  — Remove a segment from state: dormant ⇒ optional persist-to-sink, delete, precompute; awake ⇒ sleep-then-forget (delegates to flush). Kernel-closure guard stays.
  getCel  — The one read — return the live Cel at key (take .v from it). Undefined when missing.
  getSegmentManifest  — Read a 冊 manifest from state.segments by name.
  hydrate  — Inflate segments + manifests + fn maps into state.cels; lock-aware.
  hydrate函  — Boot an application from ONE 函 artifact (version + per-segment payload sources + boot record): install entries dormant/codeSeed, wake the boot roots, apply boot.set. codeSeed missing from the host bundle fails here, before anything runs.
  ilk  — Short form of interlinked, for formulas: (ilk). Cels of an ilk, interlinked.
  isSegmentPending  — True when a segment's manifest is registered but its cels await loadSegment/ensureSegments.
  listSegments  — Return every 冊 currently loaded into state.segments.
  loadScript  — (url) - load an external script from a URL (a CDN) at runtime; resolves once it loads. Browser-only (injects a <script>); off-browser it resolves immediately. Idempotent per URL. The one place external libraries (Pyodide, wabt) enter the page.
  loadSegment  — Install one pending segment's cels (live code-seed cels — no compile), then run schema/memo passes and precompute. No-op when the segment isn't pending.
  registerSegmentLoader  — Park a loader (sync or async () => Cel[]) for a not-yet-installed segment in the reserved segment.loaders registry; optionally seeds its 冊 manifest.
  runCycle  — Fire the full cascade once across every fireable cel.
  setCel  — Cel-plane write (recompile tier): with celType, create/replace the whole cel (definition replacements bump defGeneration so consumers recompile at next fire); without celType, metadata-only edit — v/f refused.
  setCelBatch  — Atomic batch of setCel specs (Record<key, CelSpec>); one precompute, one cascade.
  setValue  — Data-plane write (recalc tier): a ValueCel's v or a FormulaCel's f. Refuses definition cels — those are replaced via setCel.
  setValueBatch  — Atomic batch of setValue writes ([key, value][]); one precompute when any formula source changed, one cascade.
  sleep  — Dehydrate a segment in place: _dispose each cel, deflate to a 甲骨 payload on the SegmentCel's _dormant, drop the live cels. Refuses when awake dependents exist unless { cascade: true }; user-space SCCs sleep as a unit; kernel never sleeps.
  wake  — Inflate + compile a dormant segment plus its dormant dependency closure (compile.cache softens recompile), run the hydrate post-install passes, then one settle cascade over the woken cels. Idempotent; async.

[keystore]
  keystore.changePasscode  — (oldPasscode, newPasscode) -> {ok}|{ok:false,error}. Verify the old passcode (against the persisted blob), re-derive a new seal key, re-seal under the new passcode. New passcode >=4 chars, still unrecoverable.
  keystore.create  — (passcode, name?) -> {ok, persisted, identity, phrase}. First-run: mint an EXTRACTABLE wallet keyring (ecdh P-256 + Ed25519), seal it (PBKDF2-HMAC-SHA-256 -> AES-256-GCM) under the passcode, persist to OPFS if available (else session-only), load into memory. Returns the 12-word recovery phrase. Passcode >=4 chars and UNRECOVERABLE (no backdoor).
  keystore.export  — () -> the sealed keystore blob as a JSON string, for DOWNLOAD (the file:// backup / device-migration artifact). Already ciphertext under the passcode; no secret leaves.
  keystore.has  — () -> bool. Is there a wallet (an unlocked keyring in memory OR a persisted keystore in OPFS)?
  keystore.import  — (blobString, passcode) -> {ok, identity, name}|{ok:false,error}. Load a keystore from a FILE (file:// / device migration): decrypt with the passcode, load into memory, persist to OPFS if available.
  keystore.lock  — () -> drop the in-memory keyring (sign-out). status -> 'locked' (if a blob persists) or 'none'.
  keystore.reshuffle  — () -> {ok, persisted, identity, history}. Mint a NEW current keypair; retire the old one into the history list (so docs sealed to it stay openable); re-seal + persist. Must be unlocked.
  keystore.seedPhrase  — () -> {ok, phrase}. The 12-word recovery phrase for the current wallet (display only; deterministic seed->key re-derivation is the documented follow-up - the working recovery in v1 is the exported passcode-locked file). Must be unlocked.
  keystore.setName  — (name) -> set the profile display name, re-seal + persist. Must be unlocked.
  keystore.sign  — (message) -> {ok, sig, pub}. Ed25519-sign a message with the CURRENT signing key. pub identifies the key for verification (public verify = crypto.verify). Must be unlocked.
  keystore.unlock  — (passcode) -> {ok, identity}|{ok:false,error}. Read the persisted OPFS keystore, decrypt with the passcode, load the keyring into memory + write status cels. file:// has no persisted blob -> use keystore.import with a file.
  keystore.unwrap  — (env, withPubB64?) -> {ok, dataKey}. ECDH-unwrap with the held key whose ecdh pub matches withPub (default current; tries current+history so a now-retired key still opens). Must be unlocked.
  keystore.unwrapFrom  — (state, env, theirEcdhPubB64) -> {ok, dataKey}. ECDH-unwrap a peer-wrapped key with MY current ecdh priv + the wrapper's ecdh pub (their fromPub). Must be unlocked.
  keystore.wrap  — (dataKeyB64, toPubB64?) -> {ok, env, pub}. ECDH-wrap a symmetric data key to a recipient ecdh public key (default = my own = self-encryption). Store the returned pub; unwrap needs it. Must be unlocked.
  keystore.wrapTo  — (state, dataKeyB64, theirEcdhPubB64) -> {ok, env, fromPub}. ECDH-wrap a symmetric data key to a PEER's ecdh public key (true peer key-exchange, unlike wrap which is self-only). Shared AES = ECDH(my priv, their pub); peer recovers via unwrapFrom(env, fromPub). Must be unlocked.

[lambda-source]
  lambda-source.split

[music]
  miditrack  — (range [, bpm]) - a play-button vnode for a MIDI note range. The range is rows of [track, channel, pitch, notename, start, dur, velocity] (pitch falls back to notename), or note() specs. Clicking dispatches music.play with the resolved notes; bpm defaults to 120. Pure - builds a vnode; the sound happens in the handler.
  music.play  — (state, {notes, bpm}) - the EFFECT handler. Schedules every note on the Web Audio clock at its start beat (sample-accurate via sound.play-tone's `when` offset). bpm -> seconds/beat; velocity -> gain; channel -> waveform. Dispatched by a miditrack play button.
  note  — (pitch, start, dur, velocity [, channel]) - a pure NOTE SPEC. pitch is a MIDI number or notename string; start/dur in BEATS; velocity 0-127; channel selects the waveform (sine/triangle/square/saw). Returns { note, pitch, start, dur, vel, chan } for miditrack to play - it does NOT make sound itself (effects live behind the player + music.play handler).
  notename  — (name) - convert a notename to a MIDI number. "C4"=60, "A4"=69 (440Hz); sharps/flats like "F#3"/"Gb3" supported. A bare number passes through. MIDI = (octave+1)*12 + semitone.

[net]
  fetch  — (url [, method] [, body]) - the network verb. Async; returns the response body text. Goes through the net gate (logged + allowlist-checked). The single sanctioned way a formula reaches the network. =fetch("https://example.com")
  netallow  — ([host, ...]) - the whitelist, surfaced + edited. No args shows the current policy; with args DECLARES the allowlist as exactly those hosts (off-list fetches are blocked + logged). Default is allow-all. =netallow("api.anthropic.com")
  netlog  — () - the traffic wiretap, surfaced. Snapshot of every network request through the gate (method, host, status / BLOCKED / ERR). Re-evaluate to refresh. =netlog()

[opfs-seeding]
  seedStore  — Async. (state) -> { seeded, skipped }. Populate the segment-store under plastron/ from the in-memory boot segments (the kernel closure). Idempotent: a name@version already in the index is skipped. Host-called after createInitialState; NOT auto-fired at boot (would make every transient State touch disk). Writes via segment-store.putRaw, so it can seed role:kernel segments. node-fs in CLI, OPFS in browser, via file-store.

[origin]
  addCells  — (sheet, rows, cols) - grow the sheet's rendered range TO AT LEAST rows x cols: a pure <seg>.dims write - sparse, so NO addressed space enters state; the grid re-renders reactively. At-least semantics keep the formula idempotent (rehydrate re-fires are no-ops). =addCells('data', 20, 9).
  append  — (view, xpath, item) | (xpath, item) | (view, item) - place THIS CELL's keyed slot at an XPATH: scoped to a view pane ('viz', '//div[@id="x"]', item), DOCUMENT-scoped when the first arg IS an xpath (searched across every appendable surface - ValueCel-owned vnodes; matches inside FormulaCel-derived dom are refused: edit that formula), or the pane root (2-arg name form; opens the pane if needed). GENERATIVE: the formula survives, re-fires REPLACE the slot (no duplicates), an xpath edit MOVES it. item = a dom() vnode (bare cell refs dep-wire) or a string cel address. xpath subset: /tag, //tag, *, [n], [@id='x'], [@class='x']. DISTINCT from =view.
  at  — at(addr, content) - one cell's initial content for a cels() grid, e.g. cels("in", 4, 3, at("a1", "apple")).
  boot.run  — (state, opts?) - the origin-application boot sequence: install every baked app archive into the store (OPFS, not state), then launch the desktop shell. Tests pass {manifest, open} to drive it headlessly; open:false installs only.
  cat  — (path) - read a text file from OPFS into the cell.
  cdn  — (url) - load an external script/library from a URL via the kernel loadScript primitive. =cdn("https://cdn.jsdelivr.net/npm/canvas-confetti") then call what it exposes.
  cels  — genesis: worksheets of editable cels, each like 元. TOP-LEVEL ONLY — a genesis builds the sheet; it is never a child of dom()/canvas() (nested it stringifies to "[object Object]" and never materializes). cels(rows, cols) makes one sheet (auto-named g<r>x<c>); cels(rows, cols, "name") names it; cels("in", 4, 3, "out", 4, 3) makes a WORKBOOK; cels("in", 4, 3, at("a1", "apple"), at("b2", "cel(\"monkey\")")) fills cells with initial values/formulas. To chart a grid, put the chart in a cell OF that grid: at("A5", '=canvas(360,200, barchart(sales!A2:A4, sales!B2:B4))'). delete the formula -> swept.
  chatcard  — (project?) -> drops the slick login + grok-chat card (a reactive grok.ui formula) into the active workbook's cardBook (the dom-view pane); opens a workbook if none is active. Pair with =grokconfig(...). =chatcard('ccfr').
  db  — (name?) - open/create a sqlite database in OPFS (default main). returns a handle for sql()/tables().
  dbexport  — (db, path) - serialize the database to a portable .db blob and write it to a file-store path (browsable / downloadable). e.g. =dbexport(mydb, "/exports/mydb.db")
  dbimport  — (db, path) - load a .db file from a file-store path INTO the database, replacing its contents. e.g. =dbimport(mydb, "/exports/mydb.db")
  dbseed  — (db, rows, table) - bulk-load a JSON array of row objects into a table. e.g. =dbseed(mydb, A1:C9, "turtles")
  decrypt  — (url, passphrase?) - decode a =encrypt() URL (or bare #aes256gcm= payload) back to its formula source, as text. The inverse of encrypt. Omit the passphrase to be PROMPTED. Does NOT run it — paste the source into a cell yourself. A wrong passphrase or tampered link yields an error (GCM authenticates).
  def  — (name, kind, source) - define a callable function from source in a compiler kind ("js" works out of the box). =def("double", "js", "x => x * 2") then call it: =double(21) -> 42.
  delSeg  — (name) - delete a saved sheet from OPFS.
  desktop.bg  — (src, fallback) - the desktop wallpaper image. img() hydrates a /path src to an objectURL via file-store, so src can be an OPFS path or a data-URI; fallback covers an empty wallpaper. Right-click opens display settings (desktop.bgmenu).
  desktop.bgmenu  — (state) - right-click the wallpaper: refresh the /wallpapers/ image list and open (or raise) the display-settings window.
  desktop.graphNode  — (state, seg) - click a state-graph node: open that segment in the app editor (origin.editapp) to edit its cels' sources.
  desktop.graphbtn  — () - the round lower-left desktop button that opens the state force-graph (dispatches desktop.stategraph).
  desktop.iconClick  — (state, action) - launch the icon's app via origin.navOpen UNLESS the pointer dragged (a drag is not a click).
  desktop.iconDrop  — (state) - pointerup: record how far the icon moved (desktop.iconLastMoved, so a drag suppresses the click) and clear desktop.icondrag.
  desktop.iconGrab  — (state, label, event) - pointerdown on a desktop icon: capture the pointer + record the grab offset in desktop.icondrag.
  desktop.iconMove  — (state, _, event) - pointermove while dragging an icon: update desktop.iconpos[label] to the pointer position; repaint.
  desktop.icons  — (iconpos, mobile, ...items) - desktop: free-positioned, draggable app icons (positions persisted in desktop.iconpos by label); mobile: today's collapsible nav. items are item(label, action); a click LAUNCHES via origin.navOpen.
  desktop.importWallpaper  — (state, _, event) - file-IO import: read the picked File, write it under /wallpapers/, then select it as the wallpaper. Browser-only (File API).
  desktop.refreshWallpapers  — (state) - list /wallpapers/ into the desktop.wallpapers cel (the settings grid references it, so it updates reactively). Creates the folder if missing.
  desktop.setWallpaper  — (state, path) - point the desktop.wallpaper cel at an OPFS path; the bg img + painter load it. Reactive repaint.
  desktop.settingsView  — (current, files) - the display-settings window body: a wallpaper preview, a file-IO import button, and a chip per image under /wallpapers/ (click → desktop.setWallpaper).
  desktop.stategraph  — (state) - open a force-graph of the whole state in a real window-segment window (drag/resize/minimize/fullscreen/close via wframe): one node per segment, sized by how much memory it uses, origin-application segments tinted distinctly. Reuses the forcegraph segment (fg.set + fgview).
  desktop.taskClick  — (state, ref) - click a taskbar chip: a minimized window restores (clear min + raise); the active one minimizes; any other open one raises.
  desktop.taskbarGenesis  — (list, active) - re-derive the taskbar from win.list. A FormulaCel (desktop.taskbarGenesis win.list win.active) re-fires when the window set or focus changes and returns a genesis whose desktop.taskbar.frame splices in each window's state cel by name, so the bar tracks min/raise/title reactively.
  doc  — DEPRECATED legacy alias of seg/甲. genesis: compose a whole document from cels()/def()/cel() parts in one formula, e.g. doc(cels("in",2,2,at("a1","x")), def("f","js","x=>x")). What seed() emits — paste it into 元 to recreate an app.
  domview  — (name [, item]) - DEPRECATED pre-standardization name for =view (kept so old saved sheets still evaluate). Use =view.
  downloadSeg  — (name) - a button that downloads a saved sheet (.json) from OPFS.
  encrypt  — (passphrase?, target?, base?) - like link, but AES-256-GCM the source behind a passphrase. The URL parameter names the method: https://plastron.ca/#aes256gcm=<ciphertext>. =encrypt() encrypts the WHOLE sheet; =encrypt("", "元") one cell. Omit the passphrase to be PROMPTED (so it never lands in the sheet). Pipeline: deflate → AES-256-GCM (PBKDF2-SHA256, 600k) → base64url; AES-256 is quantum-resistant. The URL is opaque; share the passphrase out-of-band. Caveat: the decrypted formula lives in browser memory — run a local index.html offline for high stakes.
  export  — (segment?, form?) - serialize a document segment (or, with no arg, the WHOLE document stack); the boot substrate is never included. form "archive" (default) = a lossless 甲骨 json string for =import(); form "formula" = the re-minting formula (=cels(...)/=def(...)) for a workbook/function segment. Whole-doc formula is also =seed()/=link().
  geom  — geom(x, y, w, h [, minW, minH]) - a cels() grid's WINDOW geometry, CSS-style: x/y = left/top, w/h = the (proportional) width/height, minW/minH = min-width/min-height FLOORS the window never renders or resizes below (like CSS width:50%; min-width:340px). A value in (0,1] is a PROPORTION of the viewport (→ viewport.w/.h); >1 is absolute pixels. e.g. cels("app", 4, 4, geom(0.1, 0.1, 0.5, 0.4, 340, 200), at("a1", …)). Written into win.geom[name] the first time the window materializes; a later user drag/resize is preserved.
  grokconfig  — (project, url, anonkey, grokEndpoint?) -> loads the grok/supabase/auth segments and seeds the login+chat config cels (sb.<project>.url/.anonkey, grok.project, grok.url) FROM A FORMULA. The url + PUBLISHABLE anon key + endpoint are not secrets, so they belong in the formula; the password is typed into the login input and the xAI key stays server-side. =grokconfig('ccfr','https://REF.supabase.co','sb_publishable_xxx','https://REF.supabase.co/functions/v1/grok').
  hash  — (seg, ...exclude) - a recent SHA-256 (hex) of worksheet `seg`s SOURCE cels (ValueCel value | FormulaCel formula-text; derived values excluded - sources only, so it is deterministic across replicas). Trailing-* exclude patterns drop ephemeral/IO ranges. =hash("budget") / =hash("budget", "budget.live*").
  help  — (segment?) - open the vocabulary EXPLORER in a view pane: a TREE of segments (the VS Code explorer shape - grouped by role, each expands like a folder to its functions), a SEARCH box over names + descriptions on top (typing swaps the tree for a flat hit list), and the clicked function's signature/description/source on the right. No graph, no layout cost - instant at any vocabulary size. =help('ecs') opens with that segment expanded. GENERATIVE: the formula survives; the value is '⧉ help'. TEXT MODE — =help('', 'text') or =help('charts', 'text') returns the whole catalog (or one segment's) as this cell's plain-text VALUE instead of opening a pane: the agent-facing discovery form (absorbed the retired =vocab).
  help.search  — (state, _, event) - the help explorer's search box: writes help.query from the input and runs the full repaint cycle (mount-headed frames suppress value-change propagation, so a plain setValue would not repaint).
  help.selectNode  — (state, key) - a function-row or search-hit click: lands {key, celType, segment, kind, description, f} in help.selectedInfo for the detail panel.
  help.toggle  — (state, segName) - the help tree's folder click: expand/collapse the segment (help.open is the expanded set) and show its description in the detail panel.
  helpPane  — (index, query, open, info) - pure renderer for the =help explorer tab: search bar + the segment/function TREE (or flat search hits) + the detail panel. The tab formula references help.index / help.query / help.open / help.selectedInfo so every interaction re-renders reactively.
  import  — (src) - load an archive json string (or a =formula) into the document stack: ADD a new segment, or wholesale-REPLACE a same-named one. Refuses a boot-set name (net/dom/origin/…). =import("{...}")
  inspect  — (key) - the cel's full definition (celType, value, formula, metadata) as readable JSON.
  installBakedApps  — (state, manifest?) - first-run install of the baked APPLICATION + document segments: read the inert #plastron-apps manifest the bundle baked into the page (a { name: archive } map) and origin.install each entry (OPFS only, never state). Pass `manifest` to bypass the DOM read (tests/headless). No-op off-DOM or without a filesystem. A broken baked app is logged, not thrown.
  interlinked  — (seg) - force-directed graph of a grid segment's cels (nodes) + their inputMap deps (edges), laid out + rendered by the forcegraph segment (draggable fg node chips).
  item  — (label, action, ...children) - one navigation menu node for nav(). label is text/emoji; action is a window KEY (clicking focuses that window) or a '=formula' (clicking spawns a new window running it), or omit action for a pure submenu parent. children are more item()s (WordPress-style nesting). e.g. item("📊 Charts", item("🥧 Pie", '=cels(3,2, ...piechart...)')).
  jail  — (seed) - render a SANDBOXED iframe running the seed formula as its OWN kernel. allow-scripts but no allow-same-origin → opaque origin: it cannot touch localStorage, the parent page, or other tabs. The browser's real Layer-A jail for untrusted plastrons.
  kernel  — (seed, preset?) - spawn a QUARANTINED child plastron from a seed formula in a fresh segment (app1, app2, …). preset = locked (default) | compute | net | trusted, capped by THIS kernel's trust. The child's cells live under <seg>.*; gated capabilities (code/net/storage) come back #DENIED unless the preset grants them. A #f= share URL is just a locked seed.
  link  — (target?, base?) - a shareable URL that rebuilds a plastron from the page address (#f= hash, deflate+base64url). =link() encodes the WHOLE sheet; =link("元") encodes one cell's source; =link("", "") makes a relative #f= that works from a file. Paste the URL anywhere — it survives a tweet (t.co shortens it).
  ls  — (path?) - list a directory in OPFS (default /). dirs show a trailing /.
  members  — (segment) - readable listing of a segment's cels (skill first; locked marked).
  mkdir  — (path) - make a directory in OPFS (recursive).
  mount  — (target content) - pin a dom under another element of the sheet instead of in the cell that holds it. target is a selector matched against the view: ".sheet" pins under the cells, "div.cell" under the first cell, "#id" by id; a bare word ("top"/"bottom") is a region anchor laid out around the sheet. Deleting the formula removes it.
  mountcard  — (cellKey, title?) -> mount ANOTHER cell's formula as a LIVE card in the active workbook's cardBook. The cell KEEPS its =dom(...) formula (editable) and the card re-renders whenever you change it — unlike =append, which snapshots. Put =dom(...) in a cell, then =mountcard('sheet1.C1', 'My Panel').
  mv  — (from, to) - move/rename a file or directory in OPFS.
  nav  — ([mobile], ...items) - a navigation menu from item() nodes. Pass viewport.mobile as the first arg so it AUTO-SWITCHES: a collapsible left sidebar (☰) on mobile, desktop icon-launchers otherwise (it re-renders on rotate/resize). Nesting collapses via native <details>. e.g. =nav(viewport.mobile, item("📁 Files","files"), item("📊 Charts", item("🥧 Pie", '=cels(3,2,at("A1","x"))'))).
  open  — (name?) - restore a saved sheet from localStorage. =open() loads the default slot; =open("v2") a named one.
  openSeg  — (name) - restore a sheet previously saved with saveSeg from OPFS.
  origin.askgrok  — (state, key) -> state. The 🔮 formula-bar button: send the bar's natural-language question + the sheet's source context to grok (server-side xAI proxy via supabase.invoke) and drop the returned plastron FORMULA back into the bar to review, then ⚡ to commit. xAI key stays server-side.
  origin.celtopo  — (state, key?) - open the runCycle dependency CONE of a cel (defaults to the selected cell) as a force-graph window: upstream deps (blue) it depends on + downstream dependents (green) that depend on it + the cel itself pinned (gold), edges = inputMap propagation arrows. The 🔗 button on the formula bar dispatches it; clicking a node re-centers. Reuses the forcegraph segment (fg.set + fgview).
  origin.clockSync  — (host) writes the current time into the clock (HH:MM) + clock.full cels so a formula referencing them (e.g. a taskbar) re-renders; the host calls it on an interval. Reference `clock` in a formula instead of a banned NOW().
  origin.drain  — (items) - execute cels (segment listing) requests; result text replaces the request as the cel's value.
  origin.edit  — (state, cellKeyOrForceSpec) - start INLINE editing a cell (seed draft with its source); the Excel double-click path (single-click SELECTS via origin.select). Payload is the cell key, or { key, force: true } to start editing past the form-control guard.
  origin.editAppCel  — (state, {app,key}, event) - commit an edited cel source from the app editor (on Enter): rewrite the cel's source, then refresh the editor.
  origin.editapp  — (state, app) - open another segment's cels as an editable source list (its formulas/definition): each cel as key → editable source; Enter commits. Click a node in the state force-graph to edit that segment. sheetapp-as-editor.
  origin.fire  — (state, cellKey?) - FIRE (re-evaluate) the selected cell (or the given key): a FormulaCel re-applies its source via setValue (recompile + re-cascade); a ValueCel re-writes its own value (re-cascades dependents). Wired to the 🔫 button on the formula bar.
  origin.gridkey  — global keydown over a SELECTED-but-not-editing cell: arrows/Tab move the selection, Enter moves down, a printable key starts editing it (the char shows in the cell + mirrors in the formula bar). Excel-style grid navigation.
  origin.install  — (state, archive) - persist an origin-application segment ARCHIVE (dumpSegments shape {segments,manifests}, object or JSON string) into the OPFS segment-store via store.putRaw WITHOUT loading it into state. Idempotent at name granularity (an already-stored app is skipped). The ONLY way the archive's cels reach state is a later origin.launch (hydrate-closure); install never hydrates. Returns a status string. (Distinct from winapps' app.assets, which fetches asset FILES.)
  origin.key  — (state, cellKey, event) - Enter commits the draft + moves the active cell down a row.
  origin.launch  — (state, app) - open an installed origin-application by name: hydrate its segment closure from the store (idempotent), then run its conventional ENTRY cel `<app>.entry` so it materializes its window(s). The navbar/icon click path. The app must already be installed (boot.run installs the baked set).
  origin.navOpen  — dispatch target for a clicked nav leaf: a '=formula' action spawns a new window (trusted, capped by the kernel); any other action is a window key and focuses that window.
  origin.otpDecrypt  — (state, url, event) - dispatch target: decrypt an #otp= payload with the picked pad → the formula source in the formula bar (does not run it).
  origin.otpEncrypt  — (state, target, event) - dispatch target: XOR the source with the picked pad → an #otp= URL in the formula bar; warns to delete the spent pad.
  origin.otpUnlock  — (state, payload, event) - boot dispatch target: load the pad → decrypt → the shared formula becomes 元 (still jailed/locked).
  origin.run  — (state, cellKey) - set the cell's content from the draft and re-evaluate; rebuild the cell list (new grids in, swept out); 元 un-deletable (empty restores readme).
  origin.savedoc  — (state, name) - record the document's cel states: saveUserSpace dehydrates the origin-user segment's private closure and store.put's it under the app's documents/ subfolder.
  origin.savepage  — (state) - download the running plastron as a single self-contained 龜甲.html you can re-open or redeploy anywhere. Invoke from a formula: =origin.savepage().
  origin.select  — (state, cellKey, event) - SELECT a cell (Excel single-click): set 元.selected + 元.selectedSrc + seed 元.draft from its source, WITHOUT swapping it to the inline editor, so the grid keeps showing the value while the formula bar shows the source. A click on a form control a formula rendered is left alone.
  origin.tone  — (state, freq) - play ONE Web Audio oscillator note at the given frequency (Hz). Loads the sound segment on first use. Wire it to a button: (on "click" "origin.tone" 440).
  origin.updateCheck  — (state) - boot hook (boot.run runs it after installBakedApps): read the page's baked #plastron-update build stamp {id, notice}, compare against the persisted last-seen id (/plastron/update-seen). Mismatch fills origin.update so the desktop 🔄 chip surfaces. A FRESH profile (no marker file) is current by definition — the marker initializes to the page's id, no banner. No-ops off-DOM, without OPFS, or when the host didn't bake the stamp.
      e.g. =origin.updateCheck()
  origin.updateLater  — (state) - the notice window's dismiss button: persist the seen build id (the banner stays gone until the NEXT build ships — =refreshApps() remains the manual path), clear origin.update (the chip unmounts reactively), close the window.
  origin.updateOpen  — (state) - the update chip click: open the what's-new WINDOW — the shipped UPDATE.md notice (pre-wrap) over two buttons: [🔄 Refresh demo docs & reload] (origin.updateRefresh) and [Later] (origin.updateLater). A wopen window whose content cel is the built vnode (data, not formula), raised above open windows.
  origin.updateRefresh  — (state) - the notice window's refresh button: force-reinstall every baked app + demo doc (the banner flow IS the consent, so no confirm — unlike =refreshApps()), persist the seen build id, then location.reload() so boot-hydrated segments come up on the new build. User-created segments are untouched; edits to shipped demo docs are shadowed, not deleted.
  origin.viewportSync  — (host) writes live page metrics into the viewport.* cels so formulas that reference them re-run; the host calls it at boot and on resize.
  otpDecrypt  — (url) - decode a =otpEncrypt() #otp= link. Renders a file picker for the matching pad (the URL names which pad). Returns the formula source as text in the formula bar; does NOT run it. A wrong pad or tampered message fails the MAC check. Delete the pad after use.
  otpEncrypt  — (target?) - ONE-TIME-PAD encrypt with UNCONDITIONAL secrecy (perfect, quantum-immune). Renders a file picker: choose a pad file of random bytes (≥ message length + 32) shared with your peer. Produces https://plastron.ca/#otp=<padName>.<ciphertext> — ciphertext = formula XOR pad, plus a one-time Carter-Wegman MAC for unconditional integrity. NO compression (would leak length info). One pad file = ONE message: DELETE it from both stacks after use; never reuse a pad. target "" = whole sheet; a cell key = its source.
  otpLoader  — (padId, payload) - the boot view a #otp= URL renders as 元: a file picker to load the named pad and decrypt the shared plastron (kernel stays LOCKED). Used by bootFromHash; not usually called by hand.
  refreshApps  — () - factory-refresh the BAKED apps + demo docs to the build this page shipped with: re-installs every archive from the baked manifest, flipping each baked segment's latest back to the shipped version. User-CREATED segments are never touched; a user's saved edits to a SHIPPED demo doc are shadowed (prior versions stay in the store). Boot already upgrades automatically when a baked archive's VERSION bumps — this verb forces it for same-version changes. Reload the page afterwards so boot-hydrated segments (the desktop) re-hydrate.
      e.g. =refreshApps()
  rename  — (target, newName) - retitle a sheet or view tab in the active workbook, found by TITLE or segment name. Sheets rename by ALIAS (tab title + <seg>.alias; cel keys never re-key); views retitle in the window state. GENERATIVE + idempotent (a re-fire when the old name is gone but the new one exists is a no-op).
  rm  — (path) - remove a file or directory from OPFS (auto file-vs-dir).
  save  — (name?) - persist your sheet (cell sources + def'd functions) to this browser's localStorage. =save() then reload and it's back; =save("v2") for a named slot.
  saveSeg  — (name) - save the whole current sheet to an OPFS file under /plastron/sheets.
  schema  — (db) - introspect the database: tables, columns, primary keys and foreign keys (the basis for the visual query builder).
  seed  — () - serialize the WHOLE document to a single recreating formula (a doc(...) / cels(...) you can paste into 元). Callable from any cel; its value becomes the seed source.
  segment  — genesis: compose a SEGMENT (document) from cels()/winapp()/chatapp()/def()/cel() parts in one formula, e.g. =segment(...). (was doc.)
  segments  — () - every loaded segment with role, version, dependencies.
  segs  — () - list sheets saved to OPFS (=saveSeg/openSeg/delSeg manage them).
  sheet  — (name?, rows?, cols?) - add a SPARSE worksheet tab to the active workbook: the only cel minted is <name>.dims (default 12x7); addresses are keyed into state only when a value/formula is committed. name defaults to the guarded sheetN; an existing name is a no-op. GENERATIVE: the formula survives (the tab's recipe - a saved sheet re-creates it); the value is the token '▦ name'.
  sheetcells  — (keys, vals) - zip a key list + value list into sheetgrid entries {key,col,row,value}, deriving col/row from each key's A1 suffix. The host formula passes the keys (strings) + the cel values (a list referencing each cel, so the grid is reactive).
  simulate  — (fnName, n?) - def-driven animation: run a def'd frame fn (i -> [x, y]) n times and play the trajectory on an animated canvas.
  sql  — (db, query) - run SQL against a db handle; SELECT returns rows, writes persist to OPFS.
  stat  — (path) - size / isDir / mtime of an OPFS path.
  tables  — (db) - list the tables in a db.
  taskbarBar  — (active, ...states) - render the desktop bottom taskbar: one chip per non-closed, non-docked window, the active one bordered, a minimized one dimmed. Receives each window's state VALUE; click → desktop.taskClick. Built reactively by desktop.taskbarGenesis.
  touch  — (path) - create an empty file in OPFS if it does not exist.
  tree  — (path?) - recursive directory tree in OPFS (default /).
  unlink  — (url) - decode a =link() URL (or bare #f= payload) back to its formula source, as text. The inverse of link. Does NOT run it — paste the source into a cell yourself.
  updatebanner  — (update) - PURE renderer for the desktop update chip: a hidden div while `update` is {}; else a fixed top-right pill '🔄 plastron updated — what's new' whose click dispatches origin.updateOpen. The desktop app mounts it via =mount('.origin', updatebanner(origin.update)), so the chip derives reactively from the origin.update cel.
      e.g. =updatebanner(origin.update)
  view  — (name [, item]) -> THE pane verb: =view('charts') opens a VIEW pane (a <div id=name>) in the active workbook's cardBook; =view('charts', dom('h1','Hi')) opens-if-needed AND contributes this cell's slot. GENERATIVE: the formula SURVIVES in the cell (the bar shows it when active); the value is the pane token '⧉ name' ('⧉ name +' for a contribution); each contributing cell owns ONE keyed slot - re-fires replace it (no duplicates), edits update it live, and a saved sheet re-creates its panes on rehydrate.
  view.refresh  — host hook called by settleStructural after out-of-band structure materializes — rebuilds 元.cells + repaints
  viewfire  — (vals) - the gen-2 desktop compositor behind 元.view (replaces sheetView): vals is the cell values of every whitelisted self-mounting frame (cellKeys); look each up in the mount registry and splice the windows into the positioned .origin desktop, mounted at #app. Renders nothing of its own.
  viewport  — () - current page metrics {w, h, mobile, orient} as a one-shot snapshot. For REACTIVE layout reference the cels instead: viewport.w / viewport.h / viewport.mobile / viewport.orient update on window resize, so a formula re-runs to relayout — =IF(viewport.mobile, dom("h1","phone"), win("app","App",body)) or =win("app","App",body, viewport.w, viewport.h - 40).
  write  — (path, text) - write text to a file in OPFS (create/overwrite).

[origin-lifecycle]
  origin.close  — (name) → {op:'close'} descriptor — close an origin-user segment (closeUserSpace flushes its private closure root-first).
  origin.flush  — (name, save?) → {op:'flush'} descriptor for an origin-user's <seg>.flush slot. The kernel flush hook enqueues this BEFORE eviction; the drain optionally saves first (close ≠ save), then the kernel evicts the cels.
  origin.io.drain  — (items) — interpret origin lifecycle descriptors with state: new→newUserSpace, save→saveUserSpace, open→hydrate-closure, close→closeUserSpace, load→sha/compat gate then loadUserSpace, flush→optional save (the kernel evicts). Composition over the shipped user-space ops; no new persistence.
  origin.load  — (name, version?) → {op:'load'} descriptor. The drain runs the sha/compat gate, then loadUserSpace (which auto-starts the parent application).
  origin.new  — (app, name) → {op:'new'} descriptor. Use in an origin-application's .new slot; emits to origin.io, the drain creates the origin-user segment.
  origin.open  — (app) → {op:'open'} descriptor — open the origin-application standalone (no user-segment). The drain hydrates the app closure.
  origin.save  — (name) → {op:'save'} descriptor. Use in a .save slot; the drain persists the origin-user's private closure via saveUserSpace/store.put.

[peer]
  cascade.observe  — kernel post-mutation hook: auto-broadcast the shared-namespace keys a host just wrote to the connected peer (makes the sheet live)
  peer.apply  — the security core (dispatch): validate an inbound remote message against the 4 rules (setValue-only, namespace allowlist, 函 quarantine, no secret exfil) + setValue if it passes. Returns the decision.
  peer.broadcast  — outbound (dispatch): ship the VALUES of changed cels in the shared namespace to the peer (never structure/executable/secret shapes).
  peer.connect  — install a transport ({send} — a fake channel in tests, an RTCDataChannel wrapper in the browser).
  peer.route  — (state, type, verbKey) -> string. Register an inbound frame type -> handler verb (verbKey='' unregisters). The default 'set' frame stays on the security-core gate (peer.apply); sheetsync registers 'op'/'key'/'hello' -> sheetsync.recv so encrypted CRDT ops ride the same data channel with their own signature + encryption + writers gate.
  peer.tx  — (state, msg) -> boolean. Send a RAW frame (string or JSON-able) over the live WebRTC transport, for a higher segment's own protocol (e.g. an encrypted CRDT op). Returns whether it was sent (false if no peer connected). Size-capped.
  peerAccept  — (answer) - WebRTC: finalize the connection on the offerer side; the data channel opens. Browser-only.
  peerAnswer  — (offer) - WebRTC: accept an offer, return the answer (copy back to the offerer). Browser-only.
  peerOffer  — () - WebRTC: mint an SDP offer (copy it to the other browser). Browser-only.
  peerallow  — ([prefix, …]) - the shared-namespace allowlist (default ["shared."]); remote writes outside it are dropped. =peerallow("*") denies all. No args shows the policy.
  peerjoin  — (room, relayUrl) - automatic signaling via a relay: join a room, the existing member offers + the newcomer answers, all brokered over WebSocket (no SDP copy/paste). Browser-only, 2-peer rooms.
  peerlog  — () - the peer wiretap: inbound/outbound messages + the gate's decision for each.
  peersend  — (key, value) - explicit share: setValue locally + broadcast to the peer. Demo shim until automatic sync rides the post-cascade seam.

[php-compiler]
  php  — kind "php" — PHP source defining named functions; the trailing line names the callable (use the := php.<fn>{ … } selector). Compiled via php-wasm: each compile defines its source in a fresh PHP namespace so a recompile never "Cannot redeclare". The runtime call is async (returns a Promise — fireCel awaits it), so a php verb works as a whole-formula value. Dynamic-imported on first compile.

[plastron-canvas]
  canvas  — (width, height, ...ops) - a <canvas> drawn from rect/text/line/circle/wedge ops; the painter replays them onto the 2d context. use as a cell value or inside mount/dom. op LISTS flatten in, so chart fns compose: =canvas(420, 260, barchart(t!A2:A8, t!B2:B8)).
  circle  — (x, y, r [, fill] [, stroke] [, lineWidth]) - a canvas circle op.
  dragdrop  — (w?, h?) - two drop zones (A, B) + a rectangle you drag between them; it snaps to the nearest zone on release. A value vnode; the interactivity lives in the canvas renderer (the draggable/zone ops).
  frames  — (points, r?, period?, fill?, box?) - an ANIMATED canvas op: a dot of radius r steps through the trajectory points ([[x,y],…]) once per period seconds; box strokes a frame border. The painter's rAF loop drives it. The simulate verb computes a def-driven trajectory and emits through this.
  line  — (x1, y1, x2, y2 [, stroke] [, lineWidth]) - a canvas line segment op.
  rect  — (x, y, w, h [, fill] [, stroke] [, lineWidth]) - a canvas rectangle op. pass to canvas(): =canvas(200, 80, rect(0, 0, 200, 80, "#1a1a2e")).
  text  — (x, y, text [, fill] [, font]) - a canvas text op (baseline at x,y). =text(12, 24, "hi", "#fff", "16px system-ui").
  wedge  — (cx, cy, r, a0, a1 [, fill] [, stroke] [, lineWidth]) - a canvas pie-slice op from angle a0 to a1 (radians, clockwise from 3 o'clock). The piechart fn stacks these.

[plastron-gpu]
  box  — (w, h, d) - a box geometry SPEC node ({spec:'box', w,h,d}). Pure - the Three geometry is built by the replayer, never here. =scene(..., mesh(box(1,1,1), material('#4a90d9'))).
  camera  — (x, y, z) - a perspective camera SPEC node, looking at the origin.
  instances  — (geometry, material, count, bufferKey) - the keystone SPEC node: N copies of one geometry as a THREE.InstancedMesh (one draw call). bufferKey is a CEL KEY STRING naming the buffer cel whose value is the SoA struct {positions: Float32Array(3N) [, colors: Float32Array(3N)]} - the spec carries the key, not the data, so it dehydrates cleanly; the scene.paint drain reads the cel and uploads per-instance transforms (residency-agnostic: any struct satisfying the shape works). instanceColor is allocated only when the struct has colors.
  light  — (x, y, z [, color] [, intensity]) - a directional light SPEC node (an ambient fill ships automatically).
  material  — (color) - a material SPEC node ({spec:'material', color}). Lambert-shaded by the replayer.
  mesh  — (geometry, material) - a single-object mesh SPEC node. For N copies use instances().
  replay.scene  — (el, state) - the 3-D replayer (dom.replayers entry for data-scene): on first sight of a <canvas data-scene>, lazy-import Three, build renderer + scene graph from the spec, full-upload the instance buffers, render once, and RETAIN the handle in a WeakMap keyed by the element (frame-to-frame updates flow through scene.paint, not re-parsing). A changed data-scene attr rebuilds; a disconnected element is pruned and its renderer disposed (GL context cap).
  scene  — (w, h, ...nodes) - a <canvas data-scene> VNODE carrying the scene-spec JSON (camera/light/mesh/instances nodes; optional (style ...) child). Arrives via the normal vnode pipeline; the dom replay registry dispatches it to replay.scene, which builds and RETAINS the Three object graph per canvas. 3-D twin of canvas().
  scene.paint.drain  — Channel drain: for each buffered {key, gen} frame, for each retained scene handle whose instances reference that buffer cel key - read the SoA struct, dirty-diff against the last upload, setMatrixAt the changed instances (setColorAt when colors present), needsUpdate once, render. Guarded; never breaks a flush.
  sceneframe  — (bufferKey, generation) - the scene.paint channel payload {key, gen}. emitsTo: a formula whose root call is sceneframe AUTO-JOINS the scene.paint channel - type =sceneframe('sheet1.B10', B11) into any cell and each generation bump re-fires it, enqueues the frame, and the drain uploads dirty instances + renders. This is how continuous sims paint WITHOUT routing per-frame state through the vnode diff (doctrine #5).
  sphere  — (r) - a sphere geometry SPEC node ({spec:'sphere', r}).

[profile]
  profile.changepass  — read p1(old)/p2(new) -> keystore.changePasscode.
  profile.create  — read p1/p2/nm drafts -> keystore.create (passcodes must match) -> show the recovery phrase.
  profile.export  — keystore.export -> trigger a browser download of plastron-identity.kc (sealed under the passcode).
  profile.import  — read imp + p1b/p1 -> keystore.import (load a keystore file, the file:// path).
  profile.importfile  — (<input type=file> change) read the chosen file's text into the import draft.
  profile.lock  — keystore.lock (sign-out).
  profile.reshuffle  — keystore.reshuffle (new keypair; old kept in history).
  profile.seed  — keystore.seedPhrase -> reveal the 12-word recovery phrase.
  profile.setname  — read nm -> keystore.setName.
  profile.unlock  — read p1 -> keystore.unlock.
  profileui  — (status, name, identity, p1, p2, nm, imp, msg, phrase) -> a PURE profile-window vnode. Renders create / unlock+import / unlocked (name, reshuffle, export, recovery-phrase, change-passcode, lock) by keystore.status.
  profilewin  — () GENESIS: the gen-2 profile WINDOW (self-mounting wframe over (profileui …)). The app:profileapp launcher calls it.

[py-compiler]
  js-to-py  — Bridge: convert a JS-domain value to a py-domain value. Calls pyodide.toPy(). For scalars this is essentially identity (Python ints, floats, strs interoperate freely). For composites it builds a Python dict/list/etc. Authors invoke via (js-to-py someCel).
  py  — Python compiler. Compiles Python source — typically a `def` followed by the function name — into a runtime Fn via Pyodide. Pyodide is dynamic-imported on first compile and the runtime instance is shared across all py-kind cels. v1 runs main-thread; worker isolation is v2.
  py-to-js  — Bridge: convert a py-domain value (PyProxy or already-JS scalar) to a JS-domain value. Calls pyodide.toJs() on PyProxies; identity for already-converted scalars. Authors invoke via (py-to-js someCel).

[scheduler]
  clock.tick  — (state, cost) - the governor STEP. Fold the measured frame cost (ms) into the cost model per clock.mode, write clock.cost_ewma/samples/interval/fps, and return the next interval (ms). Call once per frame after the sim + paint; schedule the next frame with the returned value. Decouples sim/render rate from device capability via a learnable cost model (learn/lock/lose). Replaces hand-rolled setInterval/rAF clock loops.

[seal]
  seal.lock  — (password?) - Layer-2 at-rest seal. With a password: derive a data key (PBKDF2-HMAC-SHA-256) and install the kernel seal hooks so SEALED segment cels encrypt (AES-256-GCM) on dehydrate and decrypt on hydrate. With no/empty arg: clear the hooks (re-lock) - sealed values stay ciphertext at rest and unreadable on load. The password and data key never become cel values and never enter an archive.
  seal.locked  — () - true when this state is locked (no seal cipher hook installed).

[segment-store]
  store.delete  — Async. (name, version?) -> void. Removes the per-version directory and updates the index: drops that version, repoints latest to the most-recent remaining, or removes the segment entry entirely when none remain. version defaults to latest.
  store.get  — Async. (name, version?) -> { manifest, segment } | undefined. version defaults to the index's latest. Returns undefined when the name (or requested version) is not in the index.
  store.has  — Async. (name) -> boolean. Index lookup only; no payload read. True when the name has at least one stored version.
  store.list  — Async. () -> { name, latest }[]. Reads plastron/index.json and returns one summary row per stored segment. Empty array when nothing is stored.
  store.put  — Async. (name, version, manifest, segment) -> void. Writes plastron/segments/<name>/<version>/{manifest,segment}.json then updates plastron/index.json atomically (tmp-file + rename). Overwrites an existing version in place (no history). Throws on invalid name/version, missing version, or manifest.role==='kernel'.
  store.putRaw  — (state, name, version, manifest, segment-record) - unguarded store write (no kernel-role refusal); the seeding path composes over this.
  store.readIndex  — (state) - read plastron/index.json (empty index when absent).

[session]
  session.forget  — (state, name) - drop a service's tokens from the store (sign-out) and set session.<name>.status to { status: none }. After this the handle's resolver returns undefined.
  session.handle  — (state, name, kind?) - mint a SecretHandle for a service's access token (kind='access', default) or refresh token (kind='refresh'). The handle carries the name + a resolver closure over the module-scope store; it dehydrates to name-only (the resolver, and the token, are dropped). Effect sites (e.g. the supabase data verb) resolve() the access handle to set the Authorization bearer; an auth provider resolves the refresh handle to rotate the access token. The token is never surfaced as a cel value.
  session.peek  — (state, name) - return the non-secret status snapshot for a service ({ status: active|none, exp, hasRefresh }). Mirrors the session.<name>.status cel; never returns the token.
  session.put  — (state, name, tokens) - store a service's live session tokens ({ access, refresh?, exp?, meta? }; tokens may be an object or a JSON string) in the module-scope token store, and write a non-secret session.<name>.status cel ({ status: active, exp }) that formulas react to. The tokens NEVER become a cel value and NEVER enter an archive — only the status does. Called by auth providers (e.g. supabase-auth) on sign-in, not by user formulas.

[sheet]
  infix  — Infix spreadsheet formula parser. A FormulaCel with parser "infix" and f like "=A1*2" compiles to a CompiledEnvelope; A1-style references resolve to sibling cell keys (A1 → sheet.A1) and auto-wire into inputMap. Supports + - * / & comparisons, unary -, parens, ranges, and SUM/MIN/MAX/AVG/IF.
  sheet.cancel-edit  — Action: discard the editing draft (set sheet.editing to { editing:false, draft:"" }).
  sheet.commit-cell  — Action: write the editing draft into the target cell (set for value-into-ValueCel; re-install + recompute for literal↔formula kind changes), then clear the editor.
  sheet.move-selection  — Action: move the selection to an absolute {row,col} or by a {dr,dc} delta, clamped to sheet.dims; mirror the cell's source into sheet.formula-bar (batched).
  sheet.start-edit  — Action: open the editor on the selected (or given) cell, seeding sheet.editing.draft with the cell's current source.

[sheetapp]
  origin.newsheet  — (state) - the Sheet app: create a fresh blank worksheet DOCUMENT (a new origin-user segment of sheetapp), seed an empty grid, and render it. Save with origin.savedoc.
  origin.opendoc  — (state, name) - open a sheetapp DOCUMENT: loadUserSpace the origin-user segment from the store (hydrates both its parent app + its own cels), then render it as worksheet window(s) (sheetdoc). The launcher path for a recorded document (doc:<name>).
  sheetapp.addsheet  — (state, {ref, name?, rows?, cols?}) -> create a fresh SPARSE sheet segment and tab it into the workbook via window.addSheet. The only minted cel is <seg>.dims ({rows, cols}, default 12x7) - addresses render from dims and a cel is born only when a value/formula is committed. name defaults to the guarded sheetN; an existing name is a no-op (idempotent - the =sheet verb re-fires).
  sheetapp.applyrename  — (state, _, event) -> commit the rename box (✓ button or Enter).
  sheetapp.delete  — (state, name) - the 📂 picker row's 🗑: confirm, then store.del every stored version of the document and refresh the picker. Baked demo docs reinstall on the next fresh boot; user docs are gone for good. Deleting an OPEN doc doesn't evict its live cels — and closing that window re-saves it.
  sheetapp.golive  — (state, ref) -> state. The 🕸️ toolbar button: take this workbook LIVE — make the doc collaborative (writers=[me] if unset, so edits route through the CRDT pipeline), join a room derived from the doc name via the signaling relay (peerjoin), and register the sheetsync inbound routes. Unlock your identity first.
  sheetapp.grant  — (state, ref) -> state. The 🤝 toolbar button: grant the connected peer(s) write access — add each present peer (sheetsync.peers) to <doc>.writers and ECDH-wrap + send them the sheet data key + writers + current op-log (sheetsync.share). After this both peers' edits flow encrypted over WebRTC.
  sheetapp.open  — (state) - the workbook 📂 button: open a picker window listing the OPFS segment store's DOCUMENTS (store.list entries carrying an `app` field — docs, not library/application segments). Click a row to open it.
      e.g. =on("click", "sheetapp.open")
  sheetapp.openSealed  — () the workbook 🔓 button: pick a .sealed file, decrypt it with your identity (sheetkeys.opensheet), and open it as a workbook. Opens 👤 Profile if locked.
  sheetapp.pick  — (state, name) - picker row click: close the 📂 picker window and origin.opendoc the chosen stored document.
  sheetapp.regrid  — (state, seg) -> re-derive a sheet's content formula after a cel is born into (or removed from) the segment: swaps the sheetcells(...) ref list inside every workbook tab formula rendering seg. Called by origin.commit when a commit births a new grid cel.
  sheetapp.renamesheet  — (state, {ref,index,name}) -> rename a sheet by ALIAS (set the tab title + record <seg>.alias), NOT by re-keying cels. Formulas/cell keys are untouched.
  sheetapp.save  — (state, ref) - the workbook 💾 button: derive the document from the window ref (win.<doc>.state) and saveUserSpace it (dehydrate its private closure to the OPFS segment store). Reopen from OPFS with origin.opendoc.
  sheetapp.seal  — (ref) the workbook 🔒 button: envelope-encrypt this document to your identity (sheetkeys.sealsheet) and download <doc>.sealed. Opens 👤 Profile if your wallet is locked.
  sheetapp.tabmenu  — (state, {ref,index}, event) -> right-click / double-click a worksheet tab to open the floating rename box.
  sheetdoc  — (state, seg, title?, offset?) - open a worksheet window over the cels of document segment `seg`, rendered via the sheets segment's sheetgrid (reactive: the content formula references each grid cel). The window (program) is win.<seg>; the data stays in segment <seg>. Idempotent (re-open un-hides + raises).

[sheetkeys]
  sheetkeys.hash  — (state, seg, exclude?) -> hex SHA-256 of segment `seg`'s SOURCE cels (ValueCel value | FormulaCel formula-text), sorted by key, excluding `exclude` patterns (array or comma-string; trailing * = prefix). Derived FormulaCel values are inherently excluded (sources only). Deterministic across replicas. Used by =hash, sealsheet, and the change pipeline.
  sheetkeys.opensheet  — (state, blobString) -> {ok, seg, hash}. keystore.unwrap (tries current+history) -> crypto.decrypt -> restore the segment cels -> open as a gen-2 workbook (sheetdoc). A blob sealed to a key you do not hold fails cleanly. Must be unlocked.
  sheetkeys.sealsheet  — (state, seg, recipientPub?) -> {ok, blob}. Envelope-encrypt segment `seg`s SOURCE archive to a keypair (default = my ecdh key = self): datakey -> crypto.encrypt -> keystore.wrap. Returns a sealed blob string {v,seg,hash,by,pub,wrapped,cipher} - opaque ciphertext. Must be unlocked.

[sheets]
  gridopts  — (active, selected) - build the sheetgrid opts object from the editing/selected cell-key cels (e.g. 元.editing / 元.selected) so a worksheet is EDITABLE inside a workbook tab: the active cell shows the inline editor, a click selects. Reference the editing cels in the grid formula so it re-renders reactively. Handlers + draft default to origin.* / 元.draft inside sheetgrid.
  kv.mint  — (state, seg, event?) - the kvsheet composer's add (the + button, or Enter in its value input): mint `<seg>.<name>` from the kv.name/kv.value drafts by the entry rules (= formula, {/[ JSON, numeric, string), ensure + append to the `<seg>.keys` roster, and REWRITE every kvsheet view formula so the new cel is a spliced live reference (the reactive-set rule). Re-minting an existing name replaces the cel.
  kv.retire  — (state, {seg, name}) - a kvsheet row's retire button: remove the name from the `<seg>.keys` roster, rewrite the view formulas, then retire the cel outright (no guardrails - deletion doctrine). A surviving formula that referenced it traps undefined-symbol.
  kv.set  — (state, celKey, event) - a kvsheet row value commit (change, or Enter in the row input): apply the entry rules to the input text. Same tier -> setValue; a value<->formula tier change replaces the cel and cycles so the new formula fires.
  kvsheet  — (seg, keys?, opts?, ...pairs) - a KEY-VALUE worksheet over NAMED cels (kv-sheet.md): one row per name in the `<seg>.keys` roster (name -> editable value -> retire), plus an add-row composer (name + value + add; { and [ values parse as JSON, = mints a formula). `keys` is the roster cel's value (0 bootstraps empty); `opts` the selected-key cel's value (row highlight; clicking a name dispatches origin.select so the formula bar shows its source); `pairs` are ('<seg>.<name>', <seg>.<name>) references spliced by kv.mint/kv.retire so every row's value is live. Start with =view("params", kvsheet('<seg>', 0, sheet.selected)) - the first add mints the roster and rewires the formula.
  renameOverlay  — (ui, draft) -> a floating rename box (an input bound to the draft cel; Enter / the button apply via sheetapp.applyrename) shown at ui.x,ui.y when ui.open. Opened by right-click/double-click on a worksheet tab.
  sheet.resizeDrop  — (state) - pointerup after a header-edge resize: clear sheet.resizedrag. The size already landed in <seg>.colw/<seg>.rowh during the move.
  sheet.resizeGrab  — (state, {seg, kind: col|row, key}, event) - pointerdown on a column header's right edge / row header's bottom edge: capture the pointer, LAZILY mint the <seg>.colw / <seg>.rowh size cel (ValueCel dict, segment = the sheet's, so it archives with the doc) + rewrite the grid formulas to reference it, and snapshot the drag into sheet.resizedrag. The window.grab of the sheet grid.
  sheet.resizeMove  — (state, _, event) - pointermove during a header-edge resize: clamp (min 24px col / 16px row) and write the new size into <seg>.colw/<seg>.rowh LIVE - the grid formula references the size cel, so each write re-renders the grid through the graph, then drains dom.paint. No-op unless sheet.resizedrag is set.
  sheet.resizeReset  — (state, {seg, kind: col|row, key}) - double-click a header resize handle: remove that one column/row override from <seg>.colw/<seg>.rowh so it returns to the default size.
  sheetbar  — (selected, draft, opts?) - the Excel FORMULA BAR vnode: a cell-ref label, a ⚡ fire button, and a textarea that edits the selected cell's source. `selected` is the selected cell key, `draft` the source text to show (seed an ASCII mirror like sheet.draft so the bar re-renders on selection). The textarea's input writes the live text to the draft cel (opts.draft, default 元.draft) without re-rendering; Enter (opts.commit, default origin.key) and ⚡ (opts.fire, default origin.fire) commit it. Stack over a grid with sheetpane.
  sheetcell  — (value) - render ONE spreadsheet cell value to a vnode: a number/string as text, a vnode (a formula that built dom/canvas/a chart) in place, a cel error as its code. The leaf of the grid.
  sheetgrid  — (label, cells, opts?, dims?, colw?, rowh?) - render a worksheet's cells as an editable Excel grid CONTENT vnode (corner label + column letters + row numbers + cells). `cells` is the host-aggregated list [{key,col,row,value,src}]; `opts` = {active, selected, draft, edit, select, fire, commit} (handler keys default to origin.*); `dims` ({rows,cols} - the <seg>.dims cel) sets the sparse rendered range; `colw`/`rowh` are the sparse size dicts (<seg>.colw {letter:px} / <seg>.rowh {row:px}) - headers grow Excel-style resize handles (drag the edge; double-click resets). The active cell shows an inline editor; others dispatch select/edit. SHEET-UNIQUE native renderer (the perf fast path); a window tab hosts the result so a sheet tabs next to any app.
  sheetpane  — (bar, grid) - stack a formula bar over a grid in one CONTENT vnode (bar fixed at top, grid scrolls below) so a worksheet window reads like Excel. Both args are already-rendered vnodes.
  signedIn  — (auth) -> boolean. PURE: is a Supabase auth status object signed-in ({status:'signed-in'})? Tolerant of a missing cel (undefined -> false). Grid formulas pass (signedIn sb.<project>.auth) to sheetbar to gate the 🔮 ask-grok button.
  writableBy  — (identity, writers) -> bool. PURE formula-bar gate: a segment with no writers list is OPEN; one WITH a list admits only its members; a locked/empty identity is never a writer of a restricted sheet. The grid formula calls (writableBy keystore.identity <seg>.writers) and passes it to sheetbar.

[sheetsync]
  sheetsync.announceWriters  — (state, seg) -> {ok, frame}. Broadcast the current <seg>.writers as a SIGNED 'writers' frame so every peer in the mesh converges on who may write. Grow-only union; a peer accepts it only if the signer is already a writer (bootstrap when it has none). Called by sheetapp.grant after adding a new writer.
  sheetsync.commit  — (state, seg, key, source) -> {ok, hash, cells, frame?}. Per-cell LWW-Map CRDT: mint an op {key,kind,val,ts,author,id} (val = formula TEXT for kind 'f', or a literal value AS-IS for kind 'v' — number/string/bool/null/object/list, never stringified), sign it, gate+merge into the <seg>.crdt winner-map (per-key last-writer-wins by ts,author,id), project the winning cell, runCycle. If the seg is synced (a data key is held) encrypt + broadcast the op; `frame` is the encrypted op for tests. SOURCES only; non-writers dropped.
  sheetsync.connect  — (state) -> {ok, frame}. Register inbound frame routes (op/key/hello -> sheetsync.recv) on the peer transport and emit a 'hello' announcing my identity + ecdh pub so a peer can wrap a data key to me. Returns the hello frame (for tests to hand-deliver).
  sheetsync.haskey  — (state, seg) -> boolean. Non-secret introspection: is this segment being synced (a data key is held in module scope)? The key itself is NEVER a cel.
  sheetsync.hello  — (state) -> {ok, frame}. (Re)announce presence: emit a hello carrying my identity + ecdh pub so a peer can wrap a data key to me. Registered as peer's 'open' handler so it fires when the data channel opens.
  sheetsync.recv  — (state, frame) -> decision string. Inbound dispatch. hello -> record peer ecdh; key -> unwrap data key + adopt writers + LWW-merge the map snapshot; op -> decrypt, verify signature, check author==signer, gate writableBy, LWW-merge into <seg>.crdt + project the cell. Idempotent (stale/duplicate ops lose the merge).
  sheetsync.share  — (state, seg, peerEcdhPub?) -> {ok, frame}. Grant a peer: mint the seg data key if absent, ECDH-wrap it to the peer's ecdh pub (keystore.wrapTo), and send a 'key' frame { wrapped key, writers, ENCRYPTED current MAP snapshot }. The map merges on the peer by the same per-key LWW rule as a single op.

[sound]
  sound.is-playing  — Returns true if the handle returned from play-pcm is still playing. Returns false for unknown handles and off-browser.
  sound.play-pcm  — Play raw PCM samples. Args: { samples:Float32Array (-1..1), rate?:Hz = 44100, channels?:1|2 = 1, gain?:0..1 = 1 }. For >1 channel, samples must be interleaved. No-op off-browser.
  sound.play-tone  — Play a synthesized oscillator tone. Args: { freq:Hz, duration?:ms = 200, type?:'sine'|'square'|'sawtooth'|'triangle' = 'sine', gain?:0..1 = 0.3 }. Lazily creates + resumes the AudioContext on first call. No-op off-browser.
  sound.stop-all  — Stop every active source (tones + PCM). No-op off-browser.
  sound.stop-source  — Stop the source identified by a handle returned from play-pcm. No-op for an unknown / already-ended handle, and no-op off-browser.
  sound.update-source  — Adjust gain/pan on a live play-pcm source. Args: (handle, { gain?, pan? }). gain is multiplied with the current master at apply time. No-op for unknown handles / off-browser.

[sqlite]
  sqlite.command  — (state, op, name, query) - in-browser SQLite (@sqlite.org/sqlite-wasm over the opfs-sahpool VFS, in a Worker). op=open returns a {__db} handle; op=sql runs a query (writes persist incrementally to OPFS); op=seed bulk-inserts JSON rows; op=schema introspects tables/columns/PK/FK; op=export serializes the db to a file-store path; op=import loads a .db file-store blob into the db. Host db()/sql()/tables()/dbseed()/schema()/dbexport()/dbimport() verbs delegate here.

[supabase]
  supabase.config  — (state, project, urlOrDict, anonkey?) -> string. Set the PUBLIC project config. Preferred: a DICT writes the ONE sb.<project> cel ({url, anonkey}) that sbConfig resolves FIRST; legacy (url, anonkey) strings write the two-cel sb.<project>.url / .anonkey fallback form. The anon/publishable key is browser-safe; the only secret (the user JWT) lives in the session store after supabase.auth signs in.
      e.g. =supabase.config("default", {url:"https://xxx.supabase.co", anonkey:"sb_publishable_…"})
  supabase.data  — (state, op, project, payload) - Supabase PostgREST data plane over gated fetch. Reads config cels sb.<project>.url / sb.<project>.anonkey; sends the user JWT (resolved from the session store) as the Authorization bearer when signed in, else anon. op=select {table, query?} → rows; op=insert {table, rows} → inserted rows (+bumps rev); op=update {table, match, values} → updated rows (+rev); op=delete {table, match} → deleted rows (+rev); op=rpc {fn, args} → result. Writes bump sb.<project>.<table>.rev — reference that rev in a select formula and the select re-fires on change (the same cel realtime pushes bump). Returns rows on success, a parenthesised error string on failure (Array.isArray to discriminate).
  supabase.invoke  — (state, project, fn, body) -> json | {error}. Call a Supabase EDGE FUNCTION (/functions/v1/<fn>) with apikey + the user JWT resolved at the effect site (never a cel). The function holds any provider secret (e.g. an LLM key) SERVER-SIDE. Used by the grok segment to reach the chat-completion proxy.
  supabase.realtime  — (state, op, project, payload) - Supabase Realtime over a Phoenix-channel WebSocket. op=subscribe {table, schema?='public'} opens a persistent socket (authenticated with the session JWT for RLS) and, on each postgres_changes push, bumps sb.<project>.<table>.rev — so a server-side change re-fires a subscribed select formula through the SAME rev cel a local write bumps. op=unsubscribe {table} leaves the channel; op=status returns { connected, channels }. Browser + Bun (globalThis.WebSocket).

[supabase-auth]
  supabase.auth  — (state, op, project, payload) - Supabase GoTrue auth over gated fetch. Reads the public config cels sb.<project>.url and sb.<project>.anonkey. op=signin {email,password} → password grant; op=otp/magiclink {email} → email a magic link; op=refresh → rotate the access token via the stored refresh token; op=signout → revoke + clear. On sign-in the tokens go to the session store (session.put under 'supabase.<project>'); the JWT never becomes a cel value. The graph sees only the non-secret sb.<project>.auth status cel ({ status: signed-in|signed-out|otp-sent|error, email, userId }). The host should net.allowlist the project URL when the net gate is active.

[supabase-demo]
  sbdemo.add  — (state, project, title?) - dispatch handler: insert a todo via supabase.data; the write bumps sb.<p>.todos.rev so the panel's count re-renders.
  sbdemo.field  — (state, cellKey, event) - input dispatch handler: write the <input>'s value (event.target.value) into the cel named by cellKey. Wires email/password fields to cels.
  sbdemo.install  — (state, project='demo', url?, anonkey?) - lay down a worked Supabase example as sheet cels: config (sb.<p>.url/anonkey), seeded sb.<p>.todos.rev, sbdemo.<p>.status/live strings, and a reactive sbdemo.<p>.panel FormulaCel that renders auth status + live todo rev-count + subscription state via dom. The panel re-renders reactively as the handlers (sbdemo.signin/add/watch) drive the supabase verbs.
  sbdemo.kanban  — (state, project='demo', url?, anonkey?) - install the interactive login+kanban demo: config + email/password/status/tasks cels + a mounted sbdemo.<p>.view formula (=mount('.origin', sbdemo.ui(...))). Real <input>s + a Log in button, authored as a formula; on submit it signs in and renders the user's kanban board.
  sbdemo.login  — (state, project, event) - login button handler: sign in with the captured sbdemo.<p>.email/password, then query the user's kanban table (RLS-scoped) and write the rows to sbdemo.<p>.tasks so the board renders. Sets sbdemo.<p>.status.
  sbdemo.signin  — (state, project, payload) - dispatch handler: sign in via supabase.auth and write a display string to sbdemo.<p>.status (the panel reacts). Wire a button's click to this.
  sbdemo.ui  — (project, email, password, status, tasks) - PURE render of the login form + kanban board as a vnode. Inputs dispatch to sbdemo.field; the button dispatches to sbdemo.login. Call from a formula with the reactive cels as args so it re-renders on change.
  sbdemo.watch  — (state, project) - dispatch handler: subscribe sb.<p> todos to realtime; a server-side change then bumps the same rev cel and the panel re-renders live. Sets sbdemo.<p>.live.

[supabase-storage]
  supabase.storage  — (state, op, project, payload) - Supabase Storage (buckets) — the cloud twin of the file-store/OPFS library, over gated fetch with the session JWT (RLS-scoped). op=upload {bucket, path, content, contentType?='text/plain', upsert?=true} → { Key }; op=download {bucket, path} → text; op=list {bucket, prefix?, limit?, offset?} → objects; op=remove {bucket, path} → ok; op=createBucket {bucket, public?} → bucket; op=listBuckets → buckets. Reads config cels sb.<project>.url / sb.<project>.anonkey. Returns a parenthesised error string on failure.

[user-space-ops]
  closeUserSpace  — Async. (state, name) -> void. Tear down a user-space + its private deps (dependents-first / root-first flush order so each flush's dependent-check passes), WITHOUT saving (close != save; the host composes save-before-close UX) and WITHOUT evicting shared library deps (they stay loaded for the next user-space in the same application session). Throws if name isn't a loaded role:'user-space' segment.
  hydrate-closure  — Async. (state, rootName, version?) -> Key[] (newly-loaded segment names). The shared read-walk-topo-hydrate pipeline: BFS the segment-store from rootName collecting its transitive dependency closure, filter out segments already loaded, topo-order the remainder (deps first), and hydrate them in one call. Idempotent (whole closure already loaded -> []). Reused by loadUserSpace, application auto-start, and (future) optional-segment-loading's loadSegment.
  loadUserSpace  — Async. (state, name, version?) -> manifest. Open an existing user-space from segment-store, auto-starting its parent application (applications[0]) via hydrateClosure if not already loaded, then hydrating the user-space's own closure. Idempotent: reopening a loaded user-space is a cheap no-op. version defaults to latest. Throws if name isn't found or isn't role:'user-space'.
  newUserSpace  — Async. (state, name, applicationName, options?) -> manifest. Create a fresh empty user-space (role:'user-space', applications:[applicationName], dependencies:[applicationName, ...extraDeps]) and hydrate it into state. Throws if applicationName isn't a loaded role:'application' segment, or if name collides with a loaded segment / a stored segment (unless options.overwrite). autoSave defaults true (persists to segment-store immediately); pass { autoSave: false } for a preview-without-commit flow.
  saveUserSpace  — Async. (state, name) -> Key[] (persisted segment names). Dehydrate the user-space + its PRIVATE closure (role:'user-space' deps whose applications array is a subset of this user-space's) and write each via segment-store.put. Library/application/kernel deps are excluded — they ship with the distribution, not the user's saved data. Throws if name isn't a loaded role:'user-space' segment.

[viz-core]
  bandscale  — (labels, r0, r1 [, pad]) - a categorical SCALE SPEC: one evenly spaced band per label across [r0,r1]. pad (0..1, default .2) is the gap fraction between bands. scaleapply(band, label) → a band's start; bandwidth(band) → its drawn width.
  bandwidth  — (scale) - the drawn width of one band of a band scale (0 for non-band scales). Pair with scaleapply for a bar's x and width.
  colorapply  — (scale, v) - the "#rrggbb" for v under a colorscale (RGB lerp, clamped to the domain). Drives a choropleth/heatmap fill.
  colorscale  — (d0, d1 [, c0, c1]) - a sequential color SCALE SPEC; colorapply(scale, v) lerps a value's "#rrggbb" in RGB between c0 (at d0) and c1 (at d1). Defaults to a dark→cyan ramp.
  extent  — (values) - [min, max] over the finite numbers in a (possibly nested) range; [0,1] when empty. Derive a scale's domain from a data column: linscale with min(col)/max(col), or feed extent to your own logic.
  linscale  — (d0, d1, r0, r1) - a linear SCALE SPEC mapping the data interval [d0,d1] onto the visual interval [r0,r1]; r0>r1 is fine (screen y grows down). A scale is a pure data value, not a closure — feed it to scaleapply/ticks. e.g. scaleapply(linscale(0, max(col), plotH, 0), v) → a pixel y.
  nice  — (lo, hi [, count]) - round [lo,hi] outward to a "nice" step (1/2/5 ×10^k); returns [niceLo, niceHi, step]. Used to give a linear axis round endpoints.
  ordinalcolor  — (key [, keys]) - a categorical palette color. With keys, the color of key's position in keys; otherwise key coerced to a 0-based index. The 10-color palette wraps.
  scaleapply  — (scale, v) - map a value through a scale. linear: un-clamped linear interpolation → number. band: the START position of v's band (v is a label or a 0-based index).
  scaleinvert  — (scale, pos) - the inverse of scaleapply. linear: pixel → data value. band: the label nearest pos. The hook for interaction (a pointer x → which datum).
  ticks  — (scale [, count]) - axis ticks for a scale as [{v, pos, label}]. linear: "nice" round values (1/2/5×10^k) across the domain; band: one tick per label at its band center. An axis is ticks(scale) rendered as text+line ops.

[wasm-bytes]
  js-to-wasm  — Bridge: convert a JS-domain value to a wasm-domain value. Scalars are identity (the wasm ABI accepts JS numbers via WebAssembly's coercion). Authors invoke via formula syntax: (js-to-wasm someCel).
  wasm  — Precompiled-wasm loader. Takes a precompiled .wasm module as base64 bytes (inline source) or a 'file-store:<path>' reference, instantiates it via WebAssembly.instantiate, and exposes one export as a callable Fn. The sibling to wat/py/js that takes bytes instead of source. Export chosen by metadata.wasmExport (else prefer 'main', else the single export). Imports default to { host }; metadata.imports names a provider cel for WASI/env shims. Gated on csp.wasm-available.
  wasm-to-js  — Bridge: convert a wasm-domain value to a JS-domain value. Scalars (i32/u32/f32/f64, i64/u64 as BigInt) are JS-equivalent on the wire, so identity. A composite WasmHandle { kind:'wasm', ref } is dereferenced from the module-side value table and released. Authors invoke via formula syntax: (wasm-to-js someCel).

[wasm-types]
  wasm-bigint_dehydrate
  wasm-bigint_hydrate
  wasm-scalar_dehydrate
  wasm-scalar_hydrate
  wasm-scalar_isChanged

[wat-compiler]
  js-to-wat  — Bridge: convert a JS-domain value to a wat-domain value. v1 scalars are identity (the wat ABI accepts JS numbers directly via WebAssembly's coercion). Becomes a real marshalling call when composites and workers land. Authors invoke via formula syntax: (js-to-wat someCel).
  wasm-to-wat  — Show-WAT diagnostic: takes a wasm binary (Uint8Array) and returns its WAT text via wabt.readWasm + toText. Use on cel._wasm to inspect any wasm module — most useful for kinds whose source isn't WAT (Rust / other wasm langs). Wat lambdas can pass their own bytes for canonical round-trip.
  wat  — WAT compiler. Compiles WebAssembly text-format source to a runtime Fn via wabt.js + WebAssembly.instantiate. Wraps the module's main export (or its single function export) as a callable Fn. Gated on csp.wasm-available.
  wat-to-js  — Bridge: convert a wat-domain value to a JS-domain value. v1 scalars (i32/u32/f32/f64) are JS-equivalent on the wire, so this is identity. When composites (string, list, record, variant) and workers arrive, this becomes a real marshalling call into the wat worker's toJs protocol. Authors invoke via formula syntax: (wat-to-js someCel).

[winapps]
  app.assets  — (manifest) - install an app's ASSETS to OPFS from an assets manifest { name, version, readme?, assets:[{url, opfs, sha?}] } (object or a URL to its JSON). Downloads each MISSING asset to its opfs path (idempotent), verifying SHA-256 when given. Returns a one-line status. The foundation for origin-applications defined in formula-cels: install to OPFS, then load from OPFS into state. Network + OPFS IO. (Renamed from app.install — 'install' now belongs solely to origin.install, the archive-to-store installer.)
  app.assets.ready  — (manifest) - true iff every asset in the manifest is already present in OPFS (a formula can branch on it: install when false, load when true).
  toolbar  — (...children) - a horizontal toolbar row an app places above its content. Arrays flatten and non-vnodes drop, so MAP(...) of toolbtn()s works. App-agnostic chrome; sheet-specific UI lives in the sheets segment.
  toolbtn  — (glyph, title, handler, payload?) - a generic toolbar/titlebar button for any windowed app: shows `glyph`, stops pointerdown (so it doesn't start a window drag), and dispatches handler(state, payload, event) on click. Compose several inside toolbar().

[winapps-wasm]
  wasmapp  — (id, title, engineCel, opts?) - genesis a wasm app as a SELF-MOUNTING window on the new tabbable frame: the graph<->engine bridge cels (wasm.<id>.in/.out/.active), a <canvas> content cel (wasmcanvas id), a window state cel (one tab = the canvas), and a (mount '.origin' (wframe …)) frame. So a wasm window (DOOM) tabs next to a sheet. opts = geom {x,y,w,h,icon}. The engine instance is grabbed by canvas id at boot; pair with winapps app.assets (assets → OPFS) + a harness provider to keep the app mostly formula-cells.
  wasmcanvas  — (id, status?) - the body of a wasm window: a focusable <canvas id="wasm-<id>"> the engine grabs by id, plus a boot overlay driven by status (the engine's .out cel): a loading bar while fetching/starting, or a 'could not load' card on #ERROR. Focus/blur toggle wasm.<id>.active; keydown/keyup route to the engine (active-gated).
  wasmwin.blur  — (state, id) - lost focus → no longer the active wasm window.
  wasmwin.focus  — (state, id) - the wasm canvas gained focus → mark it the active wasm window (keys route here).
  wasmwin.key  — (state, id, event) - a keystroke on the canvas → route to the engine inbox if this window is active.

[window]
  wbframe  — (state, active, ...contents) - render a WORKBOOK window: two tab stacks at once - worksheets (left pane, tabs at bottom) and dom views (right pane, tabs on top) - split by a draggable divider, with per-pane fullscreen. state = { x,y,w,h,z,min,max,closed,title, sheets:[{ref,title,icon}], asheet, views:[{ref,title,icon}], aview, split:0..1, full:'L'|'R'|'' }. contents are one value per tab, sheets first then views (sliced by sheets.length).
  wbopen  — (id, title, sheetTabs, viewTabs, where?) - genesis a SELF-MOUNTING workbook window: a state cel holding the two tab stacks + a frame cel `(mount '.origin' (wbframe <state> win.active <sheetRefs...> <viewRefs...>))`. sheetTabs/viewTabs are [{ref,title,icon}] over existing content cels. where = geom(x,y,w,h).
  wframe  — (state, active, ...contents) - render ONE window's chrome around the ACTIVE tab's content (contents[active]): titlebar (icon + name + minimize/fullscreen/close), a tab strip when the window has >=2 tabs, the body, and 8 resize handles (n/s/e/w + nw/ne/sw/se) so the window resizes from every edge and corner. `state` is the window state object { x,y,w,h,z,min,max,closed,title,icon,tabs:[{ref,title,icon}],active,dockedIn }; `active` is win.active; `contents` is one value per tab (the frame formula passes each tab's content cel). A window whose state has dockedIn set self-hides (its host renders it). Content-AGNOSTIC: a tab's content may be a sheet grid, a wasmcanvas, or any winapp body, so heterogeneous windows tab together.
  window.addSheet  — ({ref, viewRef, title?, icon?, f?}) push a NEW worksheet tab onto a workbook's sheet stack (state.sheets) and select it. If `f` is given, the content cel `viewRef` is authored as a FormulaCel first. Rebuilds the workbook frame to reference the new content cell.
  window.addView  — ({ref, viewRef, title?, icon?, f?}) push a NEW dom-view tab onto a workbook's view stack (state.views) and select it. If `f` is given, the content cel `viewRef` is authored as a FormulaCel first — so a formula can OPEN a fresh dom window in the stack. Rebuilds the workbook frame to reference the new content cell.
  window.close  — the red X: runs EACH tab's <seg>.flush contract cel (every tab is an app with its own save-then-teardown), then drops the window. A tab's flush is `<seg>.flush` derived from its content ref (or tab.flush).
  window.dock  — ({into, win}) COMBINE windows: pull an existing window `win` in as a tab of `into` (it is marked dockedIn → self-hides; the host renders it; tear-off restores it). Or ({into, tab}) append a raw tab { ref:<contentCel>, title, icon }. Rebuilds the host's self-mounting frame so it references the new content. Lets a sheet + DOOM share one tabbed frame.
  window.drop  — pointerup: clear the transient window.drag state.
  window.grab  — pointerdown on a titlebar: capture the pointer + record the move offset into window.drag.
  window.grabResize  — pointerdown on a resize handle: capture the pointer + snapshot the start rect (x/y/w/h) and pointer (px/py) into window.drag (resize mode). Payload is { ref, dir } where dir is one of n/s/e/w/nw/ne/sw/se; a bare string ref is tolerated for backward compat and treated as dir 'se'.
  window.max  — toggle fullscreen: when set the frame fills the viewport.
  window.min  — toggle the window's minimized flag (the frame hides; a launcher restores it).
  window.move  — pointermove while dragging: write the window state cel's x/y.
  window.paneFull  — ({ref, pane}) toggle fullscreen for a workbook pane ('L' sheets / 'R' views): set state.full to pane, or '' (see both) if already fullscreen.
  window.raise  — pointerdown anywhere in a window: focus it (win.active) and bump it to the top of the z-order (win.topz).
  window.rebuildFrame  — (state, ref) -> re-author a workbook frame formula from its current sheets/views state. For sheetapp.renamesheet after a re-key swaps a content-cel ref.
  window.resizeMove  — pointermove while resizing: resize per the grabbed direction, anchoring the opposite edge - e/w change width (w also moves x), n/s change height (n also moves y), corners combine. Writes the window state cel's x/y/w/h, clamped to min w>=160, h>=90.
  window.sheetTab  — ({ref, index}) select a worksheet tab in a workbook: set the state cel's asheet index.
  window.splitGrab  — (ref) pointerdown on a workbook divider: seed window.drag {ref, split:true} so the move resizes the split.
  window.splitMove  — (_, event) drag a workbook divider: set state.split to the pointer's fraction across the window (clamped 0.15..0.85).
  window.stop  — pointerdown on a titlebar/tab BUTTON: stopPropagation so the click does not start a window/tab drag.
  window.tab  — ({ref, index}) select a tab: set the window state cel's active index.
  window.tabClose  — ({ref, index}) close one tab: remove it from the window's tabs; closing the last tab closes the window.
  window.undock  — ({ref, index}) TEAR OFF a tab (inverse of window.dock): remove it from `ref` + rebuild its frame. If the tab backs a real window (docked via window.dock), RESTORE it (clear dockedIn → it self-mounts again); otherwise mint a fresh standalone window + add it to win.list.
  window.viewTab  — ({ref, index}) select a dom-view tab in a workbook: set the state cel's aview index.
  wopen  — (id, title, body, where?) - genesis a SELF-MOUNTING window: a content cel (= body, the app render), a state cel (one tab = its own content), and a frame cel `(mount '.origin' (wframe <state> win.active <content>))` that mounts itself into the desktop. `where` = geom(x,y,w,h) sizes it. There is NO separate desktop renderer - each top-level window draws itself; dock one into another with window.dock to tab them together.

[xlsx]
  xlsxexport  — (segment?) - serialize a grid segment's value cels (default 元) to a .xlsx file, returned base64. Round-trips with xlsximport.
  xlsximport  — (base64) - parse .xlsx bytes (base64) into a genesis worksheet of cels (layer 'xlsx'). One sheet, number/string values.
  xlsxload  — (base64) - parse .xlsx bytes (base64) and MATERIALIZE them into the live sheet (the xlsx worksheet of cels)
  xlsxopen  — () - browser file picker: choose a .xlsx and import it into the sheet
  xlsxsave  — (segment?) - export a grid segment to .xlsx and download it (default 元)

[excel]  (infix builtins — call as =NAME(…); inline, not cels)
  ABS  — (x) absolute value
  AND  — (…) all true
  AVERAGE  — (range…) mean (AVG)
  AVERAGEIF  — (range, crit, [avgRange]) mean matching
  BYROW  — (range, fn) apply fn to each ROW (an array) → array: =BYROW(A1:C3, LAMBDA(row, SUM(row)))
  CONCAT  — (…) join (CONCATENATE)
  COUNT  — (range) count numbers
  COUNTA  — (range) count non-empty
  COUNTIF  — (range, crit) count matching
  DATE  — (y, m, d) ISO date string
  FILTER  — (range, predicate) keep values where predicate is true → array: =FILTER(A1:A9, LAMBDA(x, x > 0))
  HLOOKUP  — (key, range, row, [exact]) horizontal lookup
  IF  — (cond, then, else) branch
  IFERROR  — (value, fallback) catch errors
  IFS  — (cond, val, …) first true
  INDEX  — (range, row, [col]) cell at position (1-based)
  INT  — (x) floor
  LAMBDA  — (param, …, body) an inline function value — pass to MAP/REDUCE/etc: =LAMBDA(x, x*x)
  LEFT  — (s, n) first n chars
  LEN  — (s) length
  LET  — (name, value, …, calc) bind names for THIS formula, then compute calc — reuse a sub-expression without repeating it: =LET(r, A1*2, r + r*r). NAMES MUST NOT LOOK LIKE CELL REFS: s2/g1/aa3 tokenize as A1 addresses and the binding is rejected — use sq/ga/total.
  LOWER  — (s) lowercase
  MAP  — (range, fn) apply fn to each value → array: =SUM(MAP(A1:A9, LAMBDA(x, x*x)))
  MATCH  — (key, range, [type]) 1-based position
  MAX  — (range…) maximum
  MID  — (s, start, len) substring
  MIN  — (range…) minimum
  MOD  — (a, b) remainder
  NOT  — (x) negate
  OR  — (…) any true
  POWER  — (x, y) x to the power y
  REDUCE  — (init, range, fn) fold: =REDUCE(0, A1:A9, LAMBDA(acc, x, acc + x))
  RIGHT  — (s, n) last n chars
  ROUND  — (x, n) round to n places
  ROUNDDOWN  — (x, n) round toward 0
  ROUNDUP  — (x, n) round away from 0
  SCAN  — (init, range, fn) running fold → array of each step
  SQRT  — (x) square root
  SUM  — (range…) sum
  SUMIF  — (range, crit, [sumRange]) sum matching
  TEXTJOIN  — (delim, ignoreEmpty, …) join with delimiter
  TRIM  — (s) collapse spaces
  UPPER  — (s) uppercase
  VLOOKUP  — (key, range, col, [exact]) vertical lookup

values (reference by name):
  errors = []
  precomputedStates = {"waveCascade":{},"sortedWaves":[0],"wav
~~~

</details>
<!--LLMS_GUIDE_END-->
