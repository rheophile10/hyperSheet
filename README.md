# 🐢 plastron

a spreadsheet app in a single index.html — Apache-2.0 licensed.

**[What it is, and the problem it solves → the wiki](https://www.tinygnomes.com/qwiki.cgi?mode=previewSynd&uuid=W29CUCASQE4T43B8QDCP8B95S7QT)**

**[Try it live — with all the example formulas → plastron.ca](https://plastron.ca)**

**🤖 LLMs / agents:** how to use plastron — the verb catalog, share-link formats (`#f=`, `#aes256gcm=`, `#otp=`), and worked example formulas — is served as plain text at **[plastron.ca/llms.txt](https://plastron.ca/llms.txt)**. Fetch that URL directly; the in-page guide is hidden DOM that most extractors strip.

<!-- Discussion: add the Show HN link here once posted, e.g.
**Discussion:** [Show HN: Plastron](https://news.ycombinator.com/item?id=...) -->

**Everything is a dag.**

We will have won when some new spreadsheet jockey or a buck private under a shelter half with a toughbook almost a brick for the quality of the software on it implements a better version of vlookup in wat for fun.

---

<!--LLMS_GUIDE_START-->
<!-- GENERATED from plastron-examples/origin/llms.md by bun bundle.ts — edit llms.md, not here. -->
<details>
<summary><b>📖 Full LLM / agent guide</b> — the plastron formula reference (also at <a href="https://plastron.ca/llms.txt">plastron.ca/llms.txt</a>)</summary>

~~~
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
      number — extract it with INDEX(array, position); never leave the raw array in a cell:
        at("C2",'=INDEX(SCAN(0,B2:B2,LAMBDA(a,v,a+v)),1)'), at("C3",'=INDEX(SCAN(0,B2:B3,LAMBDA(a,v,a+v)),2)') …
        at("D2",'=INDEX(BYROW(A2:C4,LAMBDA(r,SUM(r))),1)'), at("D3",'=INDEX(BYROW(A2:C4,LAMBDA(r,SUM(r))),2)') …
  A lone =SCAN(…)/=BYROW(…) sitting in one cell is the #1 way these tasks render wrong — don't.
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
  MAP is for iterating a DATA RANGE. For a FIXED, small set of sections (e.g. a few columns
  or tabs), there is NO inline list literal — do NOT invent ARRAY(…)/[…]. Instead define the
  section once as a LAMBDA (via LET) and CALL it per section:
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
  =sqlitedemo()                           one formula: makes a table, seeds it, opens the client
  =sqlclient("mydb")                      a SQL client WINDOW — query editor, tables sidebar, results grid
  =sql("mydb", "create table t(a,b)")     run SQL on a db; writes persist. The first arg is the db name
  =sql("mydb", "select * from t")         …or a handle from =db(); SELECT returns rows
  =dbseed("mydb", rows, "t")              bulk-load a JSON array of row-objects (or a range) into table t
  =schema("mydb")   =tables("mydb")       introspect tables/columns/PK·FK   ·   list table names
  Results from =sqlclient land in real `sqlres.*` cels you can chart or reference.

FILES (OPFS, in-browser)
  =write("/a.txt","hi")  =cat("/a.txt")  =ls("/")  =mkdir("/d")  =upload("/")

WINDOWS / LAYOUT
  =win(key,"title","body")     =jail(seed)     =doom()  (Doom in a wasm window, consent-gated)
  =cels("app",5,2, geom(40,40,520,360))   geom(x,y,w,h[,minW,minH]) sizes a sheet's own window

APP = DATA SHEET + WINDOW (one pasteable, shareable formula)
  =winapp(id, "Title", '=<formula>')   a draggable WINDOW whose body is a REACTIVE formula
  =segment(part, part, …)              compose cels()/winapp()/def() parts into ONE formula
  The idiomatic app is a data sheet + a window that reads it — one formula in, one link out:
    =segment(
      cels("todo", 4, 2, at("A1","Task"), at("B1","Status"),
        at("A2","Email Bob"), at("B2","To Do"), at("A3","Ship"), at("B3","Done")),
      winapp("todo", "To Do",
        "=dom('div', MAP(todo!A2:A3, LAMBDA(t, dom('div.card', t))))"))
  The window body reads the sheet by GLOBAL ref (todo!A2:A3) even though it is a different
  segment. Two string levels: top-level args are "…", the nested window body is '…'.

SEGMENTS — every workbook / window / app you make is a SEGMENT (a named layer)
  =segments()                  list the loaded segments
  =members("seg")              the cels in a segment
  =nav(viewport.mobile, item(…))  a navbar that switches between your segments/windows (see NAVBAR below)
  Each =cels/=winapp/=doom/=jail MINTS a document segment (kind workbook/winapp/
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
SELF-SERVICE URLs (open one → it answers in PLAIN TEXT; no app runs):
- `https://plastron.ca/#check=<url-encoded-formula>`  → "✅ VALID" or "❌ INVALID + error".
- `https://plastron.ca/#encode=<url-encoded-formula>` → the compressed `#f=` link for it.
      Example: to share `=cels(3,3)` → open `https://plastron.ca/#encode=%3Dcels(3%2C3)`.

THE #f= CODEC — build a link by hand, no app needed. `#f=<payload>` where payload is:
      tag "0" + base64url(utf8(formula))              ← plain
      tag "1" + base64url(deflateRaw(utf8(formula)))  ← compressed (raw DEFLATE)
  Emit whichever is SHORTER; the leading tag char tells the decoder which. base64url =
  base64 with "+"→"-", "/"→"_", trailing "=" stripped. **No JSON wrapper.** Worked (plain):
      =vocab()  →  utf8 3D 76 6F 63 61 62 28 29  →  base64url PXZvY2FiKCk  →  #f=0PXZvY2FiKCk

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
FULL VERB CATALOG (baked from =vocab() at build time — current as of this deploy)
────────────────────────────────────────────────────────────────────────────
functions (call as (name …) or =name(…)), grouped by segment:

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

[cli-segment-export]
  exportToDir  — CLI-only. Async. (state, targetDir, opts?) -> { exportedSegments, targetDir }. Copies the plastron/ store (mirroring its layout) to targetDir/plastron/. opts.onlySegments?: Key[] (default: everything except the kernel closure); opts.includeTransitiveDeps?: boolean (default true when onlySegments is set); opts.includeKernel?: boolean (default false); opts.overwrite?: boolean (default false — refuses if targetDir/plastron exists). Rebuilds targetDir/plastron/index.json from the copied set. Pure file op; does not touch state.cels. Installed only when file-store.backend === 'node-fs'.
  importFromDir  — CLI-only. Async. (state, sourceDir, opts?) -> { importedSegments }. Reads sourceDir/plastron/segments/<name>/<version>/{manifest,segment}.json and writes each into the local segment-store. Refuses role:kernel pairs (kernel comes from the local bundle). Throws on name@version collision unless opts.overwrite is true. Installed only when file-store.backend === 'node-fs'.

[docgraph]
  wiki  — (name?) - a button that opens the wiki window on `name` (a cel key, function, segment, or win.<id> layer). =wiki("runCycle"). The article shows summary/doc metadata, the formula source, links to the functions it calls and its input cels (from inputMap), backlinks, a force-directed neighborhood graph, and an editable note saved to metadata.note. Navigation: click any link or graph node.
  wikidoc  — (article) - passthrough for the wiki window's content cel: renders the article vnode wiki.open assembled, or a hint when none is open.
  wikisrc  — (doc) - the source window's content: a node's LIVE source (formula f, or the bound native's toString - always the running code) + its github link. GitHub cannot be iframed (X-Frame-Options deny); the live source is strictly better anyway.

[dom]
  attr  — (name value …) - HTML attributes (href, target, type, id, …); pass as a child of dom().
  dom  — (tag, ...children) - a presentation vnode value. tag.class is emmet sugar; string children → text, nested dom(…) → elements, (style …)/(attr …)/(on …) → that element's style/attributes/events. An ARRAY child is FLATTENED in place, so a collection from MAP/FILTER renders as sibling children: (dom 'div' (MAP tasks!A1:A6 (LAMBDA t (dom 'div.card' t)))); null/''/false items are dropped. Children must be vnodes/strings/arrays/style/attr/on — NOT a genesis: cels()/segment() build sheets and don't nest here (they'd stringify to "[object Object]"); make the grid top-level instead.
  img  — (src... , style()/attr() children) - an image element. String args form a src fallback chain (first non-empty wins). A "/path" src references a file in OPFS: the painter hydrates it to an objectURL via file-store after paint, so formulas reference images by filesystem path - (img desktop.A2 windows.wallpaper (style ...)). data:/http(s)/blob srcs pass straight through.
  on  — (event handlerKey [payload]) - bind a dom event to a handler cel; pass as a child of dom(). =dom("button", on("click", "vault.lock"), "lock"). The handler runs (state, payload, event).
  style  — (prop value …) - inline styles for a dom element; pass as a child of dom().

[doom]
  doom  — () - open a DOOM window: a wasm-window (canvas) running Doom, lazy-fetching doom.wasm + the WAD from plastron.ca (consent-gated). Arrow keys / Ctrl (fire) / Space (use) drive the player when the window is focused. =doom()

[file-explorer]
  download  — (path) - a button that downloads an OPFS file to your disk.
  explorer  — (cwd, preview, listing) - a PURE OPFS file-explorer vnode: renders the folders (📁, click→explorer.nav to descend) and files (📄, click→explorer.open to preview) from `listing` ({entries,previewText}) at cwd, plus a '..' row and an upload input. The async OPFS read lives in the nav/open handlers (which write explorer.listing); this fn is pure so the window content formula (explorer explorer.cwd explorer.preview explorer.listing) re-fires reactively.
  upload  — (dir?) - a file picker; the chosen file is written into OPFS (default /).

[file-store]
  file-binary_isChanged  — isChanged protocol for file-binary. (oldV, newV) → boolean. Byte-by-byte compare; short-circuits on length mismatch.
  file-binary_mime  — mime protocol for file-binary. (v) → string. Returns 'application/octet-stream' — specialized schemas (file-image, file-doc-*) in Phase B override per type.
  file-binary_size  — size protocol for file-binary. (v) → number. Returns v.length when v is Uint8Array, 0 otherwise.

[forcegraph]
  fgview  — (id, spec, pos, zoom) - render a force-directed graph: canvas edges under draggable node chips (drag to move, scroll to zoom, click to act). Use IN A FORMULA with the instance cels as args so interactions re-render reactively: (fgview "g1" fg.g1.spec fg.g1.pos fg.g1.zoom). spec = { nodes: [{key,label?,size?}], edges: [[a,b]...], pin?, onNode?: {dispatch} }. Set up an instance with fg.set.

[formula-compiler]
  formula  — kind "formula" — a defn whose body is a parameterized plastron formula, not JS. Header form (p1, p2, …) => body; the body is compiled via the kernel's compileFormula and called positionally with params bound to the call args, non-param symbols (verbs, cel refs) resolved from the registry live. Lets you define reusable verbs (layout, note, glue macros) from the formula surface; the definition lives on cel.f so it is editable and wiki-visible. A formula verb is a function of its parameters — body cel refs are read live but do NOT wire reactivity into callers (pass reactive data as a parameter). Interpreted per call: cheap for UI/glue, not for hot inner loops.

[html-template-parser]
  html-template  — Inline HTML-template parser. A FormulaCel whose `f` is the template source and `parser` is "html-template" compiles to a render-spec ({vnode, mount, listeners}). Interpolation deps auto-wire into inputMap.
  html-template-ref  — Live-editable HTML-template parser. The template source is read from the reserved input name "template" at render time and reparsed on string change. Deps are author-declared in inputMap.
  render-spec_isChanged
  string-list_isChanged
  vnode_isChanged

[io-touch]
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

[music]
  miditrack  — (range [, bpm]) - a play-button vnode for a MIDI note range. The range is rows of [track, channel, pitch, notename, start, dur, velocity] (pitch falls back to notename), or note() specs. Clicking dispatches music.play with the resolved notes; bpm defaults to 120. Pure - builds a vnode; the sound happens in the handler.
  note  — (pitch, start, dur, velocity [, channel]) - a pure NOTE SPEC. pitch is a MIDI number or notename string; start/dur in BEATS; velocity 0-127; channel selects the waveform (sine/triangle/square/saw). Returns { note, pitch, start, dur, vel, chan } for miditrack to play - it does NOT make sound itself (effects live behind the player + music.play handler).
  notename  — (name) - convert a notename to a MIDI number. "C4"=60, "A4"=69 (440Hz); sharps/flats like "F#3"/"Gb3" supported. A bare number passes through. MIDI = (octave+1)*12 + semitone.

[net]
  fetch  — (url [, method] [, body]) - the network verb. Async; returns the response body text. Goes through the net gate (logged + allowlist-checked). The single sanctioned way a formula reaches the network. =fetch("https://example.com")
  netallow  — ([host, ...]) - the whitelist, surfaced + edited. No args shows the current policy; with args DECLARES the allowlist as exactly those hosts (off-list fetches are blocked + logged). Default is allow-all. =netallow("api.anthropic.com")
  netlog  — () - the traffic wiretap, surfaced. Snapshot of every network request through the gate (method, host, status / BLOCKED / ERR). Re-evaluate to refresh. =netlog()

[opfs-seeding]
  seedStore  — Async. (state) -> { seeded, skipped }. Populate the segment-store under plastron/ from the in-memory boot segments (the kernel closure). Idempotent: a name@version already in the index is skipped. Host-called after createInitialState; NOT auto-fired at boot (would make every transient State touch disk). Writes via segment-store.putRaw, so it can seed role:kernel segments. node-fs in CLI, OPFS in browser, via file-store.

[origin]
  at  — at(addr, content) - one cell's initial content for a cels() grid, e.g. cels("in", 4, 3, at("a1", "apple")).
  cat  — (path) - read a text file from OPFS into the cell.
  cdn  — (url) - load an external script/library from a URL via the kernel loadScript primitive. =cdn("https://cdn.jsdelivr.net/npm/canvas-confetti") then call what it exposes.
  cels  — genesis: worksheets of editable cels, each like 元. TOP-LEVEL ONLY — a genesis builds the sheet; it is never a child of dom()/canvas() (nested it stringifies to "[object Object]" and never materializes). cels(rows, cols) makes one sheet (auto-named g<r>x<c>); cels(rows, cols, "name") names it; cels("in", 4, 3, "out", 4, 3) makes a WORKBOOK; cels("in", 4, 3, at("a1", "apple"), at("b2", "cel(\"monkey\")")) fills cells with initial values/formulas. To chart a grid, put the chart in a cell OF that grid: at("A5", '=canvas(360,200, barchart(sales!A2:A4, sales!B2:B4))'). delete the formula -> swept.
  db  — (name?) - open/create a sqlite database in OPFS (default main). returns a handle for sql()/tables().
  dbexport  — (db, path) - serialize the database to a portable .db blob and write it to a file-store path (browsable / downloadable). e.g. =dbexport(mydb, "/exports/mydb.db")
  dbimport  — (db, path) - load a .db file from a file-store path INTO the database, replacing its contents. e.g. =dbimport(mydb, "/exports/mydb.db")
  dbseed  — (db, rows, table) - bulk-load a JSON array of row objects into a table. e.g. =dbseed(mydb, A1:C9, "turtles")
  decrypt  — (url, passphrase?) - decode a =encrypt() URL (or bare #aes256gcm= payload) back to its formula source, as text. The inverse of encrypt. Omit the passphrase to be PROMPTED. Does NOT run it — paste the source into a cell yourself. A wrong passphrase or tampered link yields an error (GCM authenticates).
  def  — (name, kind, source) - define a callable function from source in a compiler kind ("js" works out of the box). =def("double", "js", "x => x * 2") then call it: =double(21) -> 42.
  delSeg  — (name) - delete a saved sheet from OPFS.
  doc  — DEPRECATED legacy alias of seg/甲. genesis: compose a whole document from cels()/def()/cel() parts in one formula, e.g. doc(cels("in",2,2,at("a1","x")), def("f","js","x=>x")). What seed() emits — paste it into 元 to recreate an app.
  downloadSeg  — (name) - a button that downloads a saved sheet (.json) from OPFS.
  dragdrop  — (w?, h?) - two drop zones (A, B) + a rectangle you drag between them; it snaps to the nearest zone on release.
  encrypt  — (passphrase?, target?, base?) - like link, but AES-256-GCM the source behind a passphrase. The URL parameter names the method: https://plastron.ca/#aes256gcm=<ciphertext>. =encrypt() encrypts the WHOLE sheet; =encrypt("", "元") one cell. Omit the passphrase to be PROMPTED (so it never lands in the sheet). Pipeline: deflate → AES-256-GCM (PBKDF2-SHA256, 600k) → base64url; AES-256 is quantum-resistant. The URL is opaque; share the passphrase out-of-band. Caveat: the decrypted formula lives in browser memory — run a local index.html offline for high stakes.
  ex  — (formula, target) - a try-it payload pairing an example formula with the cell key it should run in. Used inside the readme's yellow-lightning buttons: (on "click" "tryexample" (ex "=cels(8, 5)" "readme.B2")). Returns a marker the painter hands to tryexample verbatim as the click payload.
  export  — (segment?, form?) - serialize a document segment (or, with no arg, the WHOLE document stack); the boot substrate is never included. form "archive" (default) = a lossless 甲骨 json string for =import(); form "formula" = the re-minting formula (=cels(...)/=def(...)) for a workbook/function segment. Whole-doc formula is also =seed()/=link().
  geom  — geom(x, y, w, h [, minW, minH]) - a cels() grid's WINDOW geometry, CSS-style: x/y = left/top, w/h = the (proportional) width/height, minW/minH = min-width/min-height FLOORS the window never renders or resizes below (like CSS width:50%; min-width:340px). A value in (0,1] is a PROPORTION of the viewport (→ viewport.w/.h); >1 is absolute pixels. e.g. cels("app", 4, 4, geom(0.1, 0.1, 0.5, 0.4, 340, 200), at("a1", …)). Written into win.geom[name] the first time the window materializes; a later user drag/resize is preserved.
  import  — (src) - load an archive json string (or a =formula) into the document stack: ADD a new segment, or wholesale-REPLACE a same-named one. Refuses a boot-set name (net/dom/origin/…). =import("{...}")
  inspect  — (key) - the cel's full definition (celType, value, formula, metadata) as readable JSON.
  interlinked  — (seg) - force-directed graph of a grid segment's cels (nodes) + their inputMap deps (edges), drawn on canvas.
  item  — (label, action, ...children) - one navigation menu node for nav(). label is text/emoji; action is a window KEY (clicking focuses that window) or a '=formula' (clicking spawns a new window running it), or omit action for a pure submenu parent. children are more item()s (WordPress-style nesting). e.g. item("📊 Charts", item("🥧 Pie", '=cels(3,2, ...piechart...)')).
  jail  — (seed) - render a SANDBOXED iframe running the seed formula as its OWN kernel. allow-scripts but no allow-same-origin → opaque origin: it cannot touch localStorage, the parent page, or other tabs. The browser's real Layer-A jail for untrusted plastrons.
  jailask  — (payload) - JAIL ONLY: round-trip a request to the PARENT over the postMessage bridge and return its reply. The jail has no keys/network of its own; the parent mediates (e.g. an LLM call). Outside a jail it is a no-op.
  kernel  — (seed, preset?) - spawn a QUARANTINED child plastron from a seed formula in a fresh segment (app1, app2, …). preset = locked (default) | compute | net | trusted, capped by THIS kernel's trust. The child's cells live under <seg>.*; gated capabilities (code/net/storage) come back #DENIED unless the preset grants them. A #f= share URL is just a locked seed.
  link  — (target?, base?) - a shareable URL that rebuilds a plastron from the page address (#f= hash, deflate+base64url). =link() encodes the WHOLE sheet; =link("元") encodes one cell's source; =link("", "") makes a relative #f= that works from a file. Paste the URL anywhere — it survives a tweet (t.co shortens it).
  ls  — (path?) - list a directory in OPFS (default /). dirs show a trailing /.
  members  — (segment) - readable listing of a segment's cels (skill first; locked marked).
  mkdir  — (path) - make a directory in OPFS (recursive).
  mount  — (target content) - pin a dom under another element of the sheet instead of in the cell that holds it. target is a selector matched against the view: ".sheet" pins under the cells, "div.cell" under the first cell, "#id" by id; a bare word ("top"/"bottom") is a region anchor laid out around the sheet. Deleting the formula removes it.
  mv  — (from, to) - move/rename a file or directory in OPFS.
  nav  — ([mobile], ...items) - a navigation menu from item() nodes. Pass viewport.mobile as the first arg so it AUTO-SWITCHES: a collapsible left sidebar (☰) on mobile, desktop icon-launchers otherwise (it re-renders on rotate/resize). Nesting collapses via native <details>. e.g. =nav(viewport.mobile, item("📁 Files","files"), item("📊 Charts", item("🥧 Pie", '=cels(3,2,at("A1","x"))'))).
  navpanel  — () - genesis: a PERSISTENT app launcher pinned to the desktop corner (the navpanel). Unlike =nav (a one-off pasted menu), this survives 元 re-renders and re-fires on viewport.mobile (☰ sidebar on phones). Ships launchers for 🛂 Consent, 🖥 Local LLM, 📁 Files, 📖 Readme, 🎹 Keyboard, 📊 Turtles, 🐢 DOOM, 🔑 Vault. =navpanel()
  navpanelbar  — ([mobile]) - the navpanel's content: a mounted nav() of the app launchers. The win.navbar.frame cel calls (navpanelbar viewport.mobile) so it re-renders responsively. Usually you call =navpanel() (the genesis), not this directly.
  open  — (name?) - restore a saved sheet from localStorage. =open() loads the default slot; =open("v2") a named one.
  openSeg  — (name) - restore a sheet previously saved with saveSeg from OPFS.
  otpDecrypt  — (url) - decode a =otpEncrypt() #otp= link. Renders a file picker for the matching pad (the URL names which pad). Returns the formula source as text in the formula bar; does NOT run it. A wrong pad or tampered message fails the MAC check. Delete the pad after use.
  otpEncrypt  — (target?) - ONE-TIME-PAD encrypt with UNCONDITIONAL secrecy (perfect, quantum-immune). Renders a file picker: choose a pad file of random bytes (≥ message length + 32) shared with your peer. Produces https://plastron.ca/#otp=<padName>.<ciphertext> — ciphertext = formula XOR pad, plus a one-time Carter-Wegman MAC for unconditional integrity. NO compression (would leak length info). One pad file = ONE message: DELETE it from both stacks after use; never reuse a pad. target "" = whole sheet; a cell key = its source.
  otpLoader  — (padId, payload) - the boot view a #otp= URL renders as 元: a file picker to load the named pad and decrypt the shared plastron (kernel stays LOCKED). Used by bootFromHash; not usually called by hand.
  rm  — (path) - remove a file or directory from OPFS (auto file-vs-dir).
  save  — (name?) - persist your sheet (cell sources + def'd functions) to this browser's localStorage. =save() then reload and it's back; =save("v2") for a named slot.
  saveSeg  — (name) - save the whole current sheet to an OPFS file under /plastron/sheets.
  schema  — (db) - introspect the database: tables, columns, primary keys and foreign keys (the basis for the visual query builder).
  seed  — () - serialize the WHOLE document to a single recreating formula (a doc(...) / cels(...) you can paste into 元). Callable from any cel; its value becomes the seed source.
  segment  — genesis: compose a SEGMENT (document) from cels()/winapp()/chatapp()/def()/cel() parts in one formula, e.g. =segment(...). (was doc.)
  segments  — () - every loaded segment with role, version, dependencies.
  segs  — () - list sheets saved to OPFS (=saveSeg/openSeg/delSeg manage them).
  simulate  — (fnName, n?) - def-driven animation: run a def'd frame fn (i -> [x, y]) n times and play the trajectory on an animated canvas.
  sql  — (db, query) - run SQL against a db handle; SELECT returns rows, writes persist to OPFS.
  stat  — (path) - size / isDir / mtime of an OPFS path.
  tables  — (db) - list the tables in a db.
  touch  — (path) - create an empty file in OPFS if it does not exist.
  tree  — (path?) - recursive directory tree in OPFS (default /).
  tryexample  — (state, exPayload) - the readme 'try it' handler. Clicking a yellow ⚡ next to an example copies that example's formula into a scratch cell beside the readme (its B-column target) and evaluates it, so the result appears. Implemented by seeding 元.draft with the formula then running origin.run on the target cell, which sniffs the source into a FormulaCel, writes it, re-evaluates, and repaints.
  unlink  — (url) - decode a =link() URL (or bare #f= payload) back to its formula source, as text. The inverse of link. Does NOT run it — paste the source into a cell yourself.
  viewport  — () - current page metrics {w, h, mobile, orient} as a one-shot snapshot. For REACTIVE layout reference the cels instead: viewport.w / viewport.h / viewport.mobile / viewport.orient update on window resize, so a formula re-runs to relayout — =IF(viewport.mobile, dom("h1","phone"), win("app","App",body)) or =win("app","App",body, viewport.w, viewport.h - 40).
  vocab  — (segment?) - the values + functions usable in formulas (callable lambdas/compilers + value cels) with descriptions; no arg = across all loaded segments.
  write  — (path, text) - write text to a file in OPFS (create/overwrite).

[peer]
  peerAccept  — (answer) - WebRTC: finalize the connection on the offerer side; the data channel opens. Browser-only.
  peerAnswer  — (offer) - WebRTC: accept an offer, return the answer (copy back to the offerer). Browser-only.
  peerOffer  — () - WebRTC: mint an SDP offer (copy it to the other browser). Browser-only.
  peerallow  — ([prefix, …]) - the shared-namespace allowlist (default ["shared."]); remote writes outside it are dropped. =peerallow("*") denies all. No args shows the policy.
  peerjoin  — (room, relayUrl) - automatic signaling via a relay: join a room, the existing member offers + the newcomer answers, all brokered over WebSocket (no SDP copy/paste). Browser-only, 2-peer rooms.
  peerlog  — () - the peer wiretap: inbound/outbound messages + the gate's decision for each.
  peersend  — (key, value) - explicit share: setValue locally + broadcast to the peer. Demo shim until automatic sync rides the post-cascade seam.

[plastron-canvas]
  canvas  — (width, height, ...ops) - a <canvas> drawn from rect/text/line/circle/wedge ops; the painter replays them onto the 2d context. use as a cell value or inside mount/dom. op LISTS flatten in, so chart fns compose: =canvas(420, 260, barchart(t!A2:A8, t!B2:B8)).
  circle  — (x, y, r [, fill] [, stroke] [, lineWidth]) - a canvas circle op.
  line  — (x1, y1, x2, y2 [, stroke] [, lineWidth]) - a canvas line segment op.
  orbit  — (cx, cy, orbitR, planetR, period [, color] [, phase]) - an ANIMATED canvas op: a planet circling (cx,cy) once every `period` seconds. A canvas with an orbit op runs a rAF loop; stack a few around a circle() for a heliocentric system.
  rect  — (x, y, w, h [, fill] [, stroke] [, lineWidth]) - a canvas rectangle op. pass to canvas(): =canvas(200, 80, rect(0, 0, 200, 80, "#1a1a2e")).
  text  — (x, y, text [, fill] [, font]) - a canvas text op (baseline at x,y). =text(12, 24, "hi", "#fff", "16px system-ui").
  wedge  — (cx, cy, r, a0, a1 [, fill] [, stroke] [, lineWidth]) - a canvas pie-slice op from angle a0 to a1 (radians, clockwise from 3 o'clock). The piechart fn stacks these.

[py-compiler]
  js-to-py  — Bridge: convert a JS-domain value to a py-domain value. Calls pyodide.toPy(). For scalars this is essentially identity (Python ints, floats, strs interoperate freely). For composites it builds a Python dict/list/etc. Authors invoke via (js-to-py someCel).
  py  — Python compiler. Compiles Python source — typically a `def` followed by the function name — into a runtime Fn via Pyodide. Pyodide is dynamic-imported on first compile and the runtime instance is shared across all py-kind cels. v1 runs main-thread; worker isolation is v2.
  py-to-js  — Bridge: convert a py-domain value (PyProxy or already-JS scalar) to a JS-domain value. Calls pyodide.toJs() on PyProxies; identity for already-converted scalars. Authors invoke via (py-to-js someCel).

[sheet]
  infix  — Infix spreadsheet formula parser. A FormulaCel with parser "infix" and f like "=A1*2" compiles to a CompiledEnvelope; A1-style references resolve to sibling cell keys (A1 → sheet.A1) and auto-wire into inputMap. Supports + - * / & comparisons, unary -, parens, ranges, and SUM/MIN/MAX/AVG/IF.

[sheet-host]
  sheetView  — (cfg editing draft mount error keys vals srcs geom selected tabdrag) - spreadsheet RenderSpec producer: each worksheet table wrapped in a draggable window frame. Single-click SELECTS a cell (origin.select sets 元.selected) and the cell KEEPS rendering its value; the window's formula bar shows the SELECTED cell's source (bound to 元.draft) and commits on Enter (origin.key) to 元.selected. Double-click opens the inline editor. Formula bar order is left-to-right [W wiki][lightning-bolt fire][textarea]: the fire button is an inline SVG lightning bolt (origin.fire — re-evaluate the selected cell), the W opens the wiki. The bar textarea defaults to a tall multi-line box (min-height ~7.5rem) and wraps (pre-wrap, no horizontal scrollbar); resize:vertical lets the user grow it further. Tabs render by win.geom[seg].order; dragging a tab chip reorders it among siblings (winsheet.tabMove) or, released off the window, tears it into its own window (winsheet.tabDrop -> tearoff). While a tab is being dragged (winsheet.tabdrag), its chip highlights in the SAME blue as a window's drop-target glow. Dragging a window/tab over another window glows the target (win.geom[seg].glow) to show where it will land. The formula bar's W wiki + fire buttons are sized for a comfortable hit target (glyphBtn ~1.1rem, bolt svg ~22px). Cells render clean (no per-cell glyphs). The titlebar shows exactly one of ◱ (mid/restore, when maximized) and ⛶ (maximize, when not), plus – minimize and ✕ close.

[sqlite-client]
  sqlclient  — (db [, title]) - open a SQLite client WINDOW on db: a query editor, a tables sidebar, and the result rows below (rendered as a grid + materialized into real sqlres.* cels). e.g. =sqlclient("demo")
  sqlclientui  — (db, query, tablesData, results, error) - the client panel vnode: query textarea + Run, tables sidebar, results grid. Pure render; state lives in sqlc.<db>.* cels.

[sqlite-demo]
  sqlitedemo  — ([db]) - lay down a worked SQLite example: a db handle, a CREATE-TABLE schema, a JSON seed, get/aggregate queries, and the client window opened on it. e.g. =sqlitedemo()

[user-space-ops]
  closeUserSpace  — Async. (state, name) -> void. Tear down a user-space + its private deps (dependents-first / root-first flush order so each flush's dependent-check passes), WITHOUT saving (close != save; the host composes save-before-close UX) and WITHOUT evicting shared library deps (they stay loaded for the next user-space in the same application session). Throws if name isn't a loaded role:'user-space' segment.
  hydrate-closure  — Async. (state, rootName, version?) -> Key[] (newly-loaded segment names). The shared read-walk-topo-hydrate pipeline: BFS the segment-store from rootName collecting its transitive dependency closure, filter out segments already loaded, topo-order the remainder (deps first), and hydrate them in one call. Idempotent (whole closure already loaded -> []). Reused by loadUserSpace, application auto-start, and (future) optional-segment-loading's loadSegment.
  loadUserSpace  — Async. (state, name, version?) -> manifest. Open an existing user-space from segment-store, auto-starting its parent application (applications[0]) via hydrateClosure if not already loaded, then hydrating the user-space's own closure. Idempotent: reopening a loaded user-space is a cheap no-op. version defaults to latest. Throws if name isn't found or isn't role:'user-space'.
  newUserSpace  — Async. (state, name, applicationName, options?) -> manifest. Create a fresh empty user-space (role:'user-space', applications:[applicationName], dependencies:[applicationName, ...extraDeps]) and hydrate it into state. Throws if applicationName isn't a loaded role:'application' segment, or if name collides with a loaded segment / a stored segment (unless options.overwrite). autoSave defaults true (persists to segment-store immediately); pass { autoSave: false } for a preview-without-commit flow.
  saveUserSpace  — Async. (state, name) -> Key[] (persisted segment names). Dehydrate the user-space + its PRIVATE closure (role:'user-space' deps whose applications array is a subset of this user-space's) and write each via segment-store.put. Library/application/kernel deps are excluded — they ship with the distribution, not the user's saved data. Throws if name isn't a loaded role:'user-space' segment.

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

[wasm-window]
  wasmcanvas  — (id, engine?, active?) - the body of a wasm window: a focusable <canvas id="wasm-<id>"> the engine grabs by id. Focus/blur toggle wasm.<id>.active; keydown/keyup route to the engine (active-gated).

[wat-compiler]
  js-to-wat  — Bridge: convert a JS-domain value to a wat-domain value. v1 scalars are identity (the wat ABI accepts JS numbers directly via WebAssembly's coercion). Becomes a real marshalling call when composites and workers land. Authors invoke via formula syntax: (js-to-wat someCel).
  wasm-to-wat  — Show-WAT diagnostic: takes a wasm binary (Uint8Array) and returns its WAT text via wabt.readWasm + toText. Use on cel._wasm to inspect any wasm module — most useful for kinds whose source isn't WAT (Rust / other wasm langs). Wat lambdas can pass their own bytes for canonical round-trip.
  wat  — WAT compiler. Compiles WebAssembly text-format source to a runtime Fn via wabt.js + WebAssembly.instantiate. Wraps the module's main export (or its single function export) as a callable Fn. Gated on csp.wasm-available.
  wat-to-js  — Bridge: convert a wat-domain value to a JS-domain value. v1 scalars (i32/u32/f32/f64) are JS-equivalent on the wire, so this is identity. When composites (string, list, record, variant) and workers arrive, this becomes a real marshalling call into the wat worker's toJs protocol. Authors invoke via formula syntax: (wat-to-js someCel).

[windows]
  chatapp  — (channel, title) — a chat WINDOW: seeds log/input + a winframe of (chat …). =chatapp("claude","Claude")
  chatui  — (channel, log, input) — generic chat UI; the other party (claude/grok/peer) is just a user
  desktop  — mount a fixed full-screen wallpaper behind the windows (ships inline). =desktop()
  explorerwin  — genesis: a standalone OPFS file-explorer WINDOW. Seeds explorer.cwd / explorer.preview and a (explorer explorer.cwd explorer.preview) content formula that references them, so click-to-descend / click-to-preview re-fire reactively. =explorerwin()
  readme  — the plastron readme as a vnode, for a readme window
  readmewin  — genesis: the readme WINDOW with the full plastron README
  win  — (key, title, content [, x] [, y]) - make a draggable/resizable window in ONE step. Compose two with doc: =doc(win("w1","A","hi",60,60), win("w2","B","yo",440,180))
  winapp  — (id, title, contentSource) — create a window backed by a state cel whose content is a FORMULA (win.<id>.content). Mounts a real app: =winapp("secrets","Secrets","(secrets (locked secretsNote) (apiKeys))")
  winclose  — (key) - remove a window from win.list
  window  — (key, x, y, w, h, title, content) - a draggable/resizable window FRAME around content. Geometry (x/y/w/h) comes from the host's key.x/.y/.w/.h cels, so it's reactive + persists. Titlebar drags; corner resizes; body scrolls.
  winframe  — (state, active, content) - render the STANDARD window frame DOWNSTREAM of a state cel; its titlebar buttons (W wiki · – minimize · ⛶/◱ maximize · ✕ close) write the state cel by ref. Every window uses this same frame; the wiki window (segment win.wiki) is the lone exception that omits the W button (it IS the wiki - a W there would just re-open the wiki on itself).
  winmake  — (id, title, content) - the formula: create a window backed by a STATE cel (win.<id>) + its frame. Modify the state cel to open/close/move. =winmake("d1","Window 1","hi")
  winopen  — (key, title) - register a window: add to win.list + seed its geometry cels (x/y/w/h/z/min/title) + raise
  wintoolbar  — (keys, titles) - a taskbar of open windows; click a chip to restore+raise. Pass win.list + the titles.

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
  LET  — (name, value, …, calc) bind names for THIS formula, then compute calc — reuse a sub-expression without repeating it: =LET(r, A1*2, r + r*r)
  LOWER  — (s) lowercase
  MAP  — (range, fn) apply fn to each value → array: =SUM(MAP(A1:A9, LAMBDA(x, x*x)))
  MATCH  — (key, range, [type]) 1-based position
  MAX  — (range…) maximum
  MID  — (s, start, len) substring
  MIN  — (range…) minimum
  MOD  — (a, b) remainder
  NOT  — (x) negate
  OR  — (…) any true
  REDUCE  — (init, range, fn) fold: =REDUCE(0, A1:A9, LAMBDA(acc, x, acc + x))
  RIGHT  — (s, n) last n chars
  ROUND  — (x, n) round to n places
  ROUNDDOWN  — (x, n) round toward 0
  ROUNDUP  — (x, n) round away from 0
  SCAN  — (init, range, fn) running fold → array of each step
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
