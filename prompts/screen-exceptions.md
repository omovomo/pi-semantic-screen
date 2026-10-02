---
description: Alias for the built-in Python exception-suppression preset
argument-hint: "[scope] [--refine]"
---

Run the generic semantic-screen preset workflow from the installed `ask` skill with:

- preset: `python-exceptions`
- scope: `${1:-.}`
- options: `${@:2}`

This is an alias for `/screen-use python-exceptions ${1:-.} ${@:2}`. Do not implement Python AST discovery or evidence extraction in Code Mode; the registered `python-exceptions` adapter owns both.
