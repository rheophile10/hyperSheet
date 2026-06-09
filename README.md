# 🐢 plastron

Excel was probably the most useful piece of software ever written. Its reactivity model is fantastic. You get the power of a dag and function composition without knowing what those things even are. If you have to use spreadsheets a lot for your job though, you'll start to want more powerful tools and a lot of the time you'll run into IT departments who are more interested in accounting and machines that go ping than they are in letting you do what you need to do. There are so many apps that could be spreadsheets that nobody will let you have licenses for and yet everyone has a browser that will run local javascript, wasm binaries, sqlite databases and even a filesystem api on local storage.

An index.html should be all you need for anything. Plastron lets the excel jockey unlock the power of their browser locally, offline, for free and without permission. They can make spreadsheets or spreadsheet apps. They can write python if they want to with Pyodide. If their boss isn't looking they can play freedoom with wasm.

I think AI will probably get rid of a lot of the kinds of jobs excel jockeys used to do but with plastron, these workers can be retreaded and pushed out into new domains from a familiar one. Even if AI eventually does everything for us, people will need to understand to some extent what is happening and excel users with plastron or tools like it will be able to explore connections in data, create new ways of knowing and connecting with one another to get work done and just enjoy the rich always-sunny-in-philadelphia-pepe-silvia experience of a rich yarnwall.

**Everything is a dag.**

**[Try it live → plastron.ca](https://plastron.ca)**

## What you can type

*The rest of this README is the same readme you see on plastron.ca — where it is itself a formula in cell 元 (A1). Type formulas into the sheet and an application grows out of it: compute, render, draw, store files, run a database, animate — then share the whole thing as one formula or a single `index.html`.*

this readme is the formula in the cel above. drag that cell's corner to resize it, or replace its contents with your own formulas. for more cels, use a cels formula:

| formula | does |
|---|---|
| `=cels(8, 5)` | a worksheet of editable cels |
| `=cels("in", 4, 3, "out", 4, 3)` | a workbook of named sheets |
| `=cels("in", 4, 3, at("a1", "apple"), at("b2", "=1+1"))` | a sheet with initial cell values & formulas |

or make a single new cel beside this one:

| formula | does |
|---|---|
| `=cel("monkey")` | a new cel holding the value monkey |
| `=cel("cel(\"banana\")")` | a new cel holding a formula (that makes another cel) |

you can make your own functions and use them in formulas after:

| formula | does |
|---|---|
| `=def("double", "js", "x => x * 2")` | define a function — js or py (first py use downloads pyodide, ~10MB) |
| `=double(21)` | call it → 42 |

you can make dom objects with formulas — and a little universe running on canvas:

| formula | does |
|---|---|
| `=dom("h2", style("color", "tomato"), "hi")` | a styled dom element |
| `=canvas(300,170, rect(0,0,300,170,"#0a0a18"), circle(150,85,12,"#ffd34e"), orbit(150,85,34,4,3,"#7fd0ff"), orbit(150,85,58,6,6,"#e6677a"), orbit(150,85,84,5,11,"#9fe89f"))` | ↑ that animated solar system |

inspect functions and the plastron segments they came from:

| formula | does |
|---|---|
| `=inspect("mount")` | a function's signature + source |
| `=segments()` | the plastron segments loaded |

talk to grok — with an api key:

| formula | does |
|---|---|
| `=grok("say hi in 5 words", key)` | a chat completion (key = a cel holding your api key) |

files in OPFS — a filesystem in formulas:

| formula | does |
|---|---|
| `=mkdir("/x")` | make a folder in OPFS (your browser's private filesystem) |
| `=write("/x/a.txt", "hi")` | write a file; =cat("/x/a.txt") reads it back |
| `=ls("/x")` | list a folder; =tree("/") shows the whole tree |
| `=upload("/x")` | a file picker — the chosen file lands in OPFS |
| `=download("/x/a.txt")` | a button that saves an OPFS file to your disk |

a sqlite database, persisted in OPFS:

| formula | does |
|---|---|
| `=db("app")` | open/create a sqlite database (app = a cel holding the handle) |
| `=sql(app, "create table t(a, b)")` | run SQL; writes persist to OPFS |
| `=sql(app, "select * from t")` | a query → rows; survives reload |

canvas — animate and interact:

| formula | does |
|---|---|
| `=def("ball", "js", "i => [30+280*Math.abs((i/20)%2-1), 30+200*Math.abs((i/14)%2-1)]")` | a bouncing ball's motion, as a JS function |
| `=simulate("ball", 120)` | play the def'd motion on an animated canvas |
| `=interlinked("g3x1")` | a grid's cels + their dependencies as a force graph |
| `=dragdrop()` | drag a rectangle between two zones (it snaps on release) |

save your work:

| formula | does |
|---|---|
| `=save()` | persist this sheet to your browser — reload and it's back |

share your whole app as one formula — paste a friend's doc(...) into the cel above to run it:

| formula | does |
|---|---|
| `=seed()` | serialize this ENTIRE document to one doc(...) formula you can save or send |

## Future directions

Plastron is not finished and it's meant to be built upon. There needs to be version control. I really admire xit and I'll probably try to bake it into plastron again. All the traditional excel formulas will have to be written in here (or maybe only the ones we like) and this will need to export and ingest traditional .xlsx documents which it doesn't yet do. I intend to build on it and improve it for the projects I am doing and I hope other people will be interested in helping me do this as well.

We will have won when some new spreadsheet jockey or a buck private under a shelter half with a toughbook almost a brick for the quality of the software on it implements a better version of vlookup in wat for fun.

[github.com/rheophile10/plastron →](https://github.com/rheophile10/plastron)
