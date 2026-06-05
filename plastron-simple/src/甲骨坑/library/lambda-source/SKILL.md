---
name: lambda-source
description: Opt-in schema for round-tripping multi-line lambda/formula source bodies as string[] in dehydrated JSON.
---

## Cels provided

- `lambda-source` — the SchemaCel.
- `lambda-source.split` — splits a body back into string[] for readable .json output.

## Usage

Inflate-side join is always-on; this schema's `sourceDehydrate` splits back. Seed the segment to
get readable multi-line source in dehydrated segment files.
