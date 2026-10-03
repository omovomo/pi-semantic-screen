from __future__ import annotations

import ast
import json
import re
import sys
from pathlib import Path
from typing import Any

SKIP_DIRS = {".git", ".hg", ".svn", ".venv", "venv", "node_modules", "__pycache__", "dist", "build"}


def clip(text: str, limit: int) -> str:
    text = text.strip()
    if len(text) <= limit:
        return text
    if limit <= 3:
        return text[:limit]
    return text[: limit - 3].rstrip() + "..."


def display_path(path: Path) -> str:
    resolved = path.resolve()
    cwd = Path.cwd().resolve()
    try:
        return resolved.relative_to(cwd).as_posix()
    except ValueError:
        return resolved.as_posix()


def iter_python_files(scope: str) -> list[Path]:
    root = Path(scope)
    if root.is_file():
        return [root] if root.suffix == ".py" else []
    if not root.exists():
        raise FileNotFoundError(f"scope does not exist: {scope}")
    files: list[Path] = []
    for path in root.rglob("*.py"):
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        files.append(path)
    return sorted(files, key=lambda p: display_path(p))


def source_for_lines(lines: list[str], start: int | None, end: int | None) -> str:
    if not start or not end or start < 1:
        return ""
    end = min(end, len(lines))
    if end < start:
        return ""
    return "".join(lines[start - 1 : end])


def node_source(lines: list[str], node: ast.AST, limit: int) -> str:
    return clip(source_for_lines(lines, getattr(node, "lineno", None), getattr(node, "end_lineno", None)), limit)


def nodes_source(lines: list[str], nodes: list[ast.AST], limit: int) -> str:
    if not nodes:
        return "<none>"
    start = getattr(nodes[0], "lineno", None)
    end = getattr(nodes[-1], "end_lineno", None)
    text = source_for_lines(lines, start, end)
    return clip(text, limit) if text.strip() else "<none>"


def parse_file(path: Path) -> tuple[str, list[str], ast.AST]:
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines(keepends=True)
    tree = ast.parse(text, filename=str(path))
    return text, lines, tree


def build_maps(tree: ast.AST) -> tuple[dict[int, ast.AST], dict[int, tuple[list[ast.stmt], int]]]:
    parents: dict[int, ast.AST] = {}
    stmt_lists: dict[int, tuple[list[ast.stmt], int]] = {}
    for parent in ast.walk(tree):
        for child in ast.iter_child_nodes(parent):
            parents[id(child)] = parent
        for _field, value in ast.iter_fields(parent):
            if isinstance(value, list) and value and all(isinstance(item, ast.stmt) for item in value):
                for index, statement in enumerate(value):
                    stmt_lists[id(statement)] = (value, index)
    return parents, stmt_lists


def ancestors(node: ast.AST, parents: dict[int, ast.AST]):
    current = parents.get(id(node))
    while current is not None:
        yield current
        current = parents.get(id(current))


def scope_names(node: ast.AST, parents: dict[int, ast.AST]) -> list[str]:
    names: list[str] = []
    for current in ancestors(node, parents):
        if isinstance(current, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.append(current.name)
    return list(reversed(names))


def nearest(node: ast.AST, parents: dict[int, ast.AST], kinds: tuple[type[ast.AST], ...]) -> ast.AST | None:
    for current in ancestors(node, parents):
        if isinstance(current, kinds):
            return current
    return None


def caught_text(handler: ast.ExceptHandler) -> str:
    if handler.type is None:
        return "<bare>"
    try:
        return ast.unparse(handler.type)
    except Exception:
        return type(handler.type).__name__


def downstream_nodes(try_node: ast.AST, parents: dict[int, ast.AST], stmt_lists: dict[int, tuple[list[ast.stmt], int]]):
    """Find the next executable statements, walking out of exhausted nested blocks.

    This is important for handlers at the end of an if/for/with body: the caller-visible
    continuation may live after the enclosing statement rather than immediately after try.
    Never walk past the containing function into module/class siblings.
    """
    current: ast.AST | None = try_node
    while current is not None:
        entry = stmt_lists.get(id(current))
        if entry:
            statements, index = entry
            following = statements[index + 1 : index + 3]
            if following:
                return following
        current = parents.get(id(current))
        if isinstance(current, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            break
    return []


def function_returns(function_node: ast.AST | None) -> list[ast.Return]:
    if not isinstance(function_node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        return []
    found: list[ast.Return] = []

    class ReturnVisitor(ast.NodeVisitor):
        def visit_Return(self, node: ast.Return):
            found.append(node)

        def visit_FunctionDef(self, node: ast.FunctionDef):
            if node is function_node:
                self.generic_visit(node)

        def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef):
            if node is function_node:
                self.generic_visit(node)

        def visit_ClassDef(self, node: ast.ClassDef):
            return

        def visit_Lambda(self, node: ast.Lambda):
            return

    ReturnVisitor().visit(function_node)
    found.sort(key=lambda node: getattr(node, "lineno", 0))
    return found




def expression_key(node: ast.AST | None) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = expression_key(node.value)
        return f"{base}.{node.attr}" if base else node.attr
    if isinstance(node, ast.Subscript):
        # A subscription mutates/reads the base container identity. The index expression is
        # deliberately excluded because `items[key] = value` changes `items`, not `key`.
        return expression_key(node.value)
    return None


def assigned_keys(nodes: list[ast.AST]) -> set[str]:
    keys: set[str] = set()
    mutators = {"append", "extend", "update", "add", "discard", "remove", "pop", "clear", "setdefault"}

    def add_target(target: ast.AST) -> None:
        # Subscript assignments such as `results[key] = value` mutate the base mapping.
        # This is crucial for omission-style handlers where the outward effect is an incomplete
        # collection rather than a reassigned local scalar.
        if isinstance(target, ast.Subscript):
            key = expression_key(target.value)
            if key:
                keys.add(key)
            return
        key = expression_key(target)
        if key:
            keys.add(key)
            return
        if isinstance(target, (ast.Tuple, ast.List)):
            for item in target.elts:
                add_target(item)

    class Visitor(ast.NodeVisitor):
        def visit_Assign(self, node: ast.Assign):
            for target in node.targets:
                add_target(target)
            self.visit(node.value)

        def visit_AnnAssign(self, node: ast.AnnAssign):
            add_target(node.target)
            if node.value is not None:
                self.visit(node.value)

        def visit_AugAssign(self, node: ast.AugAssign):
            add_target(node.target)
            self.visit(node.value)

        def visit_NamedExpr(self, node: ast.NamedExpr):
            add_target(node.target)
            self.visit(node.value)

        def visit_For(self, node: ast.For):
            add_target(node.target)
            self.generic_visit(node)

        def visit_AsyncFor(self, node: ast.AsyncFor):
            add_target(node.target)
            self.generic_visit(node)

        def visit_With(self, node: ast.With):
            for item in node.items:
                if item.optional_vars is not None:
                    add_target(item.optional_vars)
            self.generic_visit(node)

        def visit_Call(self, node: ast.Call):
            if isinstance(node.func, ast.Attribute) and node.func.attr in mutators:
                key = expression_key(node.func.value)
                if key:
                    keys.add(key)
            self.generic_visit(node)

        def visit_FunctionDef(self, node: ast.FunctionDef):
            return

        def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef):
            return

        def visit_ClassDef(self, node: ast.ClassDef):
            return

        def visit_Lambda(self, node: ast.Lambda):
            return

    visitor = Visitor()
    for node in nodes:
        visitor.visit(node)
    return keys


def function_body_nodes(function_node: ast.AST | None) -> list[ast.AST]:
    if not isinstance(function_node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        return []
    found: list[ast.AST] = []

    class Visitor(ast.NodeVisitor):
        def visit_FunctionDef(self, node: ast.FunctionDef):
            if node is function_node:
                for stmt in node.body:
                    self.visit(stmt)

        def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef):
            if node is function_node:
                for stmt in node.body:
                    self.visit(stmt)

        def visit_ClassDef(self, node: ast.ClassDef):
            return

        def visit_Lambda(self, node: ast.Lambda):
            return

        def generic_visit(self, node: ast.AST):
            found.append(node)
            super().generic_visit(node)

    Visitor().visit(function_node)
    return found


def dataflow_evidence(lines: list[str], try_node: ast.AST | None, function_node: ast.AST | None) -> str:
    if try_node is None or not isinstance(function_node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        return "tracked=<none>"
    tracked = sorted(assigned_keys(list(getattr(try_node, "body", []))))
    if not tracked:
        return "tracked=<none>"

    try_start = getattr(try_node, "lineno", 0)
    try_end = getattr(try_node, "end_lineno", try_start)
    all_nodes = function_body_nodes(function_node)
    pre: list[str] = []
    post: list[str] = []
    seen_pre: set[tuple[str, int]] = set()
    seen_post: set[tuple[str, int]] = set()

    for node in all_nodes:
        lineno = getattr(node, "lineno", 0)
        if not lineno:
            continue
        if isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign, ast.NamedExpr, ast.For, ast.AsyncFor, ast.With)):
            node_keys = assigned_keys([node])
            for key in tracked:
                if key in node_keys and lineno < try_start and (key, lineno) not in seen_pre:
                    seen_pre.add((key, lineno))
                    pre.append(f"{key}@{lineno}: {line_window(lines, lineno, 0, 220)}")
        if lineno > try_end:
            key = None
            if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
                key = node.id
            elif isinstance(node, ast.Attribute) and isinstance(node.ctx, ast.Load):
                key = expression_key(node)
            if key in tracked and (key, lineno) not in seen_post:
                seen_post.add((key, lineno))
                post.append(f"{key}@{lineno}: {line_window(lines, lineno, 0, 220)}")

    # Nearest pre-try writes are usually most relevant; earliest post-handler reads show outward use.
    pre = pre[-4:]
    post = post[:8]
    return (
        f"tracked={', '.join(tracked)}; "
        f"pre_try_writes={' | '.join(pre) if pre else '<none found>'}; "
        f"post_handler_reads={' | '.join(post) if post else '<none found>'}"
    )




def loaded_keys(node: ast.AST | None) -> set[str]:
    keys: set[str] = set()
    if node is None:
        return keys

    class Visitor(ast.NodeVisitor):
        def visit_Name(self, current: ast.Name):
            if isinstance(current.ctx, ast.Load):
                keys.add(current.id)

        def visit_Attribute(self, current: ast.Attribute):
            if isinstance(current.ctx, ast.Load):
                key = expression_key(current)
                if key:
                    keys.add(key)
            self.generic_visit(current.value)

        def visit_FunctionDef(self, current: ast.FunctionDef):
            return

        def visit_AsyncFunctionDef(self, current: ast.AsyncFunctionDef):
            return

        def visit_ClassDef(self, current: ast.ClassDef):
            return

        def visit_Lambda(self, current: ast.Lambda):
            return

    Visitor().visit(node)
    return keys


def touches_tracked(node: ast.AST | None, tracked: set[str]) -> bool:
    if not tracked:
        return False
    loaded = loaded_keys(node)
    for key in loaded:
        if key in tracked:
            return True
        # Attribute evidence can be relevant when either side is the tracked base.
        if any(key.startswith(f"{tracked_key}.") or tracked_key.startswith(f"{key}.") for tracked_key in tracked):
            return True
    return False


def expanded_semantic_hints(lines: list[str], try_node: ast.AST | None, function_node: ast.AST | None) -> str:
    """Targeted expanded evidence for control validation and persistence/outward calls.

    Keep this bounded and structural: the generic function tail remains available, but these
    hints surface the statements most likely to prove whether a fallback/default becomes a
    normal caller-visible result or is validated/persisted later.
    """
    if try_node is None or not isinstance(function_node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        return "post_handler_controls=<none>; post_handler_calls=<none>; persistence_calls=<none>"

    tracked = set(assigned_keys(list(getattr(try_node, "body", []))))
    if not tracked:
        return "post_handler_controls=<none tracked>; post_handler_calls=<none tracked>; persistence_calls=<none tracked>"

    try_end = getattr(try_node, "end_lineno", getattr(try_node, "lineno", 0))
    controls: list[str] = []
    calls: list[str] = []
    persistence: list[str] = []
    seen_controls: set[int] = set()
    seen_calls: set[int] = set()
    seen_persistence: set[int] = set()
    persistence_words = (
        "save", "write", "dump", "persist", "store", "commit", "cache", "update",
        "serialize", "export", "sync", "flush", "replace", "upsert",
    )

    for node in function_body_nodes(function_node):
        lineno = getattr(node, "lineno", 0)
        if not lineno or lineno <= try_end:
            continue

        subject: ast.AST | None = None
        if isinstance(node, ast.If):
            subject = node.test
        elif isinstance(node, ast.Assert):
            subject = node.test
        elif isinstance(node, ast.Return):
            subject = node.value
        elif isinstance(node, ast.Raise):
            subject = node.exc

        if subject is not None and touches_tracked(subject, tracked) and lineno not in seen_controls:
            seen_controls.add(lineno)
            controls.append(f"{lineno}: {line_window(lines, lineno, 1, 340)}")

        if isinstance(node, ast.Call) and touches_tracked(node, tracked):
            if lineno not in seen_calls:
                seen_calls.add(lineno)
                calls.append(f"{lineno}: {line_window(lines, lineno, 1, 320)}")
            name = (call_name(node) or "").lower()
            if name and any(word in name for word in persistence_words) and lineno not in seen_persistence:
                seen_persistence.add(lineno)
                persistence.append(f"{lineno}: {line_window(lines, lineno, 1, 360)}")

    controls = controls[:5]
    calls = calls[:6]
    persistence = persistence[:4]
    return (
        f"post_handler_controls={' | '.join(controls) if controls else '<none found>'}; "
        f"post_handler_calls={' | '.join(calls) if calls else '<none found>'}; "
        f"persistence_calls={' | '.join(persistence) if persistence else '<none found>'}"
    )





SENTINEL_NAMES = {"none", "unknown", "unavailable", "missing", "invalid", "nan", "na"}


def sentinel_repr(node: ast.AST | None) -> str | None:
    """Return a compact representation only for structurally obvious sentinel/default values."""
    if node is None:
        return None
    if isinstance(node, ast.Constant):
        if node.value is None:
            return "None"
        if isinstance(node.value, str) and node.value.strip().lower() in SENTINEL_NAMES:
            return repr(node.value)
        return None
    if isinstance(node, ast.Dict) and not node.keys:
        return "{}"
    if isinstance(node, ast.List) and not node.elts:
        return "[]"
    if isinstance(node, ast.Tuple) and not node.elts:
        return "()"
    if isinstance(node, ast.Set) and not node.elts:
        return "set()"
    if isinstance(node, (ast.Name, ast.Attribute)):
        key = expression_key(node)
        if key and key.rsplit(".", 1)[-1].lower() in SENTINEL_NAMES:
            return key
    if isinstance(node, ast.Call):
        name = (call_name(node) or "").lower()
        if name in {"dict", "list", "set", "tuple"} and not node.args and not node.keywords:
            return f"{name}()"
        if name == "float" and len(node.args) == 1 and isinstance(node.args[0], ast.Constant):
            if str(node.args[0].value).lower() == "nan":
                return "float('nan')"
    return None


def direct_assignment_values(node: ast.AST) -> list[tuple[str, ast.AST, int]]:
    """Return direct assignment target/value pairs without descending into nested scopes."""
    found: list[tuple[str, ast.AST, int]] = []

    def add_target(target: ast.AST, value: ast.AST, lineno: int) -> None:
        if isinstance(target, (ast.Tuple, ast.List)) and isinstance(value, (ast.Tuple, ast.List)):
            for left, right in zip(target.elts, value.elts):
                add_target(left, right, lineno)
            return
        key = expression_key(target)
        if key:
            found.append((key, value, lineno))

    if isinstance(node, ast.Assign):
        for target in node.targets:
            add_target(target, node.value, getattr(node, "lineno", 0))
    elif isinstance(node, ast.AnnAssign) and node.value is not None:
        add_target(node.target, node.value, getattr(node, "lineno", 0))
    elif isinstance(node, ast.NamedExpr):
        add_target(node.target, node.value, getattr(node, "lineno", 0))
    return found


def container_mutation_keys(nodes: list[ast.AST]) -> set[str]:
    """Return base container identities mutated without replacing the binding.

    Pre-try ``[]``/``{}`` values are only meaningful sentinels if the caught path cannot have
    partially populated them. Subscript writes and in-place mutator calls therefore disqualify
    the original empty-container value from being reported as the post-failure sentinel.
    """
    keys: set[str] = set()
    mutators = {"append", "extend", "update", "add", "discard", "remove", "pop", "clear", "setdefault"}

    class Visitor(ast.NodeVisitor):
        def visit_Assign(self, node: ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Subscript):
                    key = expression_key(target.value)
                    if key:
                        keys.add(key)
            self.generic_visit(node.value)

        def visit_AnnAssign(self, node: ast.AnnAssign):
            if isinstance(node.target, ast.Subscript):
                key = expression_key(node.target.value)
                if key:
                    keys.add(key)
            if node.value is not None:
                self.generic_visit(node.value)

        def visit_AugAssign(self, node: ast.AugAssign):
            key = expression_key(node.target)
            if key:
                keys.add(key)
            self.generic_visit(node.value)

        def visit_Call(self, node: ast.Call):
            if isinstance(node.func, ast.Attribute) and node.func.attr in mutators:
                key = expression_key(node.func.value)
                if key:
                    keys.add(key)
            self.generic_visit(node)

        def visit_FunctionDef(self, node: ast.FunctionDef):
            return

        def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef):
            return

        def visit_ClassDef(self, node: ast.ClassDef):
            return

        def visit_Lambda(self, node: ast.Lambda):
            return

    visitor = Visitor()
    for node in nodes:
        visitor.visit(node)
    return keys


def direct_handler_returns(handler: ast.ExceptHandler) -> list[ast.Return]:
    """Return handler-executed returns, excluding nested scopes."""
    found: list[ast.Return] = []

    class Visitor(ast.NodeVisitor):
        def visit_Return(self, node: ast.Return):
            found.append(node)

        def visit_FunctionDef(self, node: ast.FunctionDef):
            return

        def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef):
            return

        def visit_ClassDef(self, node: ast.ClassDef):
            return

        def visit_Lambda(self, node: ast.Lambda):
            return

    visitor = Visitor()
    for statement in handler.body:
        visitor.visit(statement)
    found.sort(key=lambda node: getattr(node, "lineno", 0))
    return found


def sentinel_sources(
    *,
    handler: ast.ExceptHandler,
    try_node: ast.AST,
    function_node: ast.AST,
    tracked: set[str],
) -> list[tuple[str, str, int, str]]:
    """Find exact handler/pre-try sentinel values for tracked identities.

    Handler assignments win. If a handler preserves a preexisting value, the nearest
    structurally obvious pre-try sentinel assignment is used instead. This is evidence only;
    it does not decide whether the sentinel is safe or material.
    """
    sources: dict[str, tuple[str, str, int, str]] = {}
    # Any handler-side assignment/mutation means the pre-try value was not simply preserved.
    # Only an exact handler sentinel assignment may then define the fallback value.
    handler_effect_keys = assigned_keys(list(handler.body))
    handler_keys: set[str] = set()
    for stmt in handler.body:
        for current in ast.walk(stmt):
            if isinstance(current, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)) and current is not stmt:
                continue
            for key, value, lineno in direct_assignment_values(current):
                if key not in tracked:
                    continue
                sentinel = sentinel_repr(value)
                if sentinel is not None:
                    sources[key] = (key, sentinel, lineno, "handler")
                    handler_keys.add(key)
    try_start = getattr(try_node, "lineno", 0)
    try_container_mutations = container_mutation_keys(list(getattr(try_node, "body", [])))
    for current in function_body_nodes(function_node):
        lineno = getattr(current, "lineno", 0)
        if not lineno or lineno >= try_start:
            continue
        for key, value, assignment_line in direct_assignment_values(current):
            if key not in tracked or key in handler_keys or key in handler_effect_keys:
                continue
            sentinel = sentinel_repr(value)
            if sentinel is not None:
                # An empty mutable container can already be partially populated before a later
                # statement raises. Reporting the original []/{} as the resulting fallback would
                # be false evidence, so suppress it when the try mutates that same container.
                if sentinel in {"{}", "[]", "set()", "dict()", "list()"} and key in try_container_mutations:
                    continue
                # Iteration is source-order; overwrite so the nearest previous sentinel wins.
                sources[key] = (key, sentinel, assignment_line, "pre_try")
    return [sources[key] for key in sorted(sources)]


def sentinel_handling_evidence(
    *,
    lines: list[str],
    path_name: str,
    handler: ast.ExceptHandler,
    try_node: ast.AST | None,
    function_node: ast.AST | None,
    function_index: dict[str, list[tuple[str, list[str], ast.AST, dict[int, ast.AST]]]],
    call_sites: dict[str, list[tuple[str, list[str], ast.Call, dict[int, ast.AST]]]],
) -> str:
    """Show exact sentinel/default origin and its first bounded consumers after the handler."""
    if try_node is None or not isinstance(function_node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        return "<none>"
    try_end = getattr(try_node, "end_lineno", getattr(try_node, "lineno", 0))
    candidate = assigned_keys(list(getattr(try_node, "body", []))) | assigned_keys(list(handler.body))
    post_used = keys_used_after(function_node, try_end)
    tracked = {key for key in candidate if related_key(key, post_used)}
    if not tracked:
        tracked = set(assigned_keys(list(handler.body)))
    sources = sentinel_sources(handler=handler, try_node=try_node, function_node=function_node, tracked=tracked)
    return_sentinels: list[tuple[ast.Return, str]] = []
    for ret in direct_handler_returns(handler):
        sentinel = sentinel_repr(ret.value)
        if sentinel is not None:
            return_sentinels.append((ret, sentinel))
    if not sources and not return_sentinels:
        return "<none>"

    pieces: list[str] = []
    for key, sentinel, source_line, source_kind in sources[:3]:
        guard: str | None = None
        outward: str | None = None
        for node in function_body_nodes(function_node):
            lineno = getattr(node, "lineno", 0)
            if not lineno or lineno <= try_end:
                continue
            if isinstance(node, (ast.If, ast.Assert)) and touches_tracked(node.test, {key}):
                guard = f"guard@{lineno}:{node_source(lines, node, 420)}"
                break
        for node in function_body_nodes(function_node):
            lineno = getattr(node, "lineno", 0)
            if not lineno or lineno <= try_end:
                continue
            if isinstance(node, ast.Return) and touches_tracked(node.value, {key}):
                outward = f"return@{lineno}:{node_source(lines, node, 260)}"
                break
            if isinstance(node, ast.Call) and touches_tracked(node, {key}) and not is_container_read_call(node, {key}):
                outward = f"call@{lineno}:{line_window(lines, lineno, 1, 300)}"
                break
        segment = f"{key}={sentinel} source={source_kind}@{source_line}"
        if guard:
            segment += f" {guard}"
        if outward:
            segment += f" outward={outward}"
        pieces.append(segment)

    # A direct fallback return is a synthetic affected value. Surface the exact caller binding
    # when there is only one definition and one call site; otherwise keep the return evidence
    # local rather than guessing fan-out.
    function_name = function_node.name
    for ret, sentinel in return_sentinels[:2]:
        segment = f"return={sentinel} source=handler@{getattr(ret, 'lineno', 0)}"
        sites = call_sites.get(function_name, [])
        if len(function_index.get(function_name, [])) == 1 and len(sites) == 1:
            caller_path, _caller_lines, call, caller_parents = sites[0]
            binding = assignment_binding_for_call(call, caller_parents)
            if binding:
                segment += f" caller_binding=return->{binding}@{caller_path}:{getattr(call, 'lineno', 0)}"
        pieces.append(segment)
    return clip(" | ".join(pieces), 900)


def branch_outcome_evidence(lines: list[str], branch: ast.AST) -> str:
    """Return the first bounded explicit branch outcome, including constants not touching input."""
    body = list(getattr(branch, "body", []))
    for stmt in body:
        for node in ast.walk(stmt):
            if isinstance(node, ast.Raise):
                return f"raise@{getattr(node, 'lineno', 0)}:{node_source(lines, node, 220)}"
            if isinstance(node, ast.Return):
                return f"return@{getattr(node, 'lineno', 0)}:{node_source(lines, node, 300)}"
    # A state/result assignment can be a terminal outward effect even without an early return.
    for stmt in body:
        if isinstance(stmt, (ast.Assign, ast.AnnAssign, ast.NamedExpr)):
            return f"state@{getattr(stmt, 'lineno', 0)}:{node_source(lines, stmt, 300)}"
    return "<no explicit bounded outcome>"


def branch_outcome_node(branch: ast.AST) -> ast.AST | None:
    """Return the same first explicit bounded outcome used for evidence rendering."""
    body = list(getattr(branch, "body", []))
    for stmt in body:
        for node in ast.walk(stmt):
            if isinstance(node, (ast.Raise, ast.Return)):
                return node
    for stmt in body:
        if isinstance(stmt, (ast.Assign, ast.AnnAssign, ast.NamedExpr)):
            return stmt
    return None


def exact_return_result_hop(
    *,
    function_name: str,
    outcome_node: ast.AST | None,
    function_index: dict[str, list[tuple[str, list[str], ast.AST, dict[int, ast.AST]]]],
    class_index: dict[str, list[tuple[str, list[str], ast.ClassDef, dict[int, ast.AST]]]],
    call_sites: dict[str, list[tuple[str, list[str], ast.Call, dict[int, ast.AST]]]],
) -> str:
    """Follow one exact evaluator return into its immediate caller as terminal evidence.

    This is intentionally not a third generic call edge. It only follows the concrete result
    of the already-proven guard outcome and reports the first exact caller-side sink.
    """
    if not isinstance(outcome_node, ast.Return) or outcome_node.value is None:
        return ""
    if len(function_index.get(function_name, [])) != 1:
        return ""
    sites = call_sites.get(function_name, [])
    if len(sites) != 1:
        return ""
    caller_path, caller_lines, call, caller_parents = sites[0]
    caller_fn = enclosing_function(call, caller_parents)
    if not isinstance(caller_fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
        return ""

    binding = assignment_binding_for_call(call, caller_parents)
    if binding:
        events = first_relevant_flow_events(
            caller_lines, caller_fn, {binding}, after_line=getattr(call, "lineno", 0), limit=10
        )
        for kind, node, snippet in events:
            if kind == "return" and isinstance(node, ast.Return):
                container_binding = return_container_binding(node, {binding}, class_index)
                extra = f" returned_container_binding={container_binding}" if container_binding else ""
                return f"terminal_result={function_name} return->{binding} at {caller_path}:{getattr(call, 'lineno', 0)}; return={snippet}{extra}"
            if kind == "explicit_failure":
                return f"terminal_result={function_name} return->{binding} at {caller_path}:{getattr(call, 'lineno', 0)}; failure={snippet}"
            if kind == "call" and isinstance(node, ast.Call):
                exact = exact_call_candidate([(kind, node, snippet)], {binding}, function_index, caller_parents)
                if exact is not None:
                    _call2, _snippet2, name2, _definition2, bindings2 = exact
                    return (
                        f"terminal_result={function_name} return->{binding} at {caller_path}:{getattr(call, 'lineno', 0)}; "
                        f"consumer={name2} binding={','.join(f'{a}->{p}' for a,p in bindings2)}"
                    )

    stmt = enclosing_statement(call, caller_parents)
    if isinstance(stmt, ast.Return) and stmt.value is call:
        return f"terminal_result={function_name} returned directly by {caller_fn.name} at {caller_path}:{getattr(call, 'lineno', 0)}"
    return ""


def follow_exact_function_return(
    *,
    function_name: str,
    function_index: dict[str, list[tuple[str, list[str], ast.AST, dict[int, ast.AST]]]],
    class_index: dict[str, list[tuple[str, list[str], ast.ClassDef, dict[int, ast.AST]]]],
    call_sites: dict[str, list[tuple[str, list[str], ast.Call, dict[int, ast.AST]]]],
    origin_note: str,
    remaining_return_hops: int,
    constructor_already_proven: bool = False,
) -> str:
    """Follow a returned object into exact callers without guessing among fan-out sites.

    One call site preserves the original exact-path behavior. Small fan-out is summarized
    across every exact caller: each site is independently traced and the evidence reports
    resolved/unresolved counts rather than selecting one caller. Large fan-out remains
    unresolved to keep evidence bounded.
    """
    if remaining_return_hops <= 0 or len(function_index.get(function_name, [])) != 1:
        return "<none>"
    sites = call_sites.get(function_name, [])
    if not sites:
        return "<none>"
    if len(sites) > 1:
        return follow_bounded_function_return_fanout(
            function_name=function_name,
            sites=sites,
            function_index=function_index,
            class_index=class_index,
            call_sites=call_sites,
            origin_note=origin_note,
            remaining_return_hops=remaining_return_hops,
            constructor_already_proven=constructor_already_proven,
        )
    caller_path, caller_lines, call, caller_parents = sites[0]
    caller_fn = enclosing_function(call, caller_parents)
    if not isinstance(caller_fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
        return "<none>"
    binding = assignment_binding_for_call(call, caller_parents)
    if not binding:
        return "<none>"
    note = f"{origin_note}; returned_to={caller_fn.name}.{binding} at {caller_path}:{getattr(call, 'lineno', 0)}"
    return structured_terminal_from_context(
        lines=caller_lines,
        path_name=caller_path,
        function_node=caller_fn,
        parents=caller_parents,
        tracked={binding},
        after_line=getattr(call, "lineno", 0),
        function_index=function_index,
        class_index=class_index,
        call_sites=call_sites,
        origin_note=note,
        remaining_return_hops=remaining_return_hops - 1,
        constructor_already_proven=constructor_already_proven,
    )


def follow_bounded_function_return_fanout(
    *,
    function_name: str,
    sites: list[tuple[str, list[str], ast.Call, dict[int, ast.AST]]],
    function_index: dict[str, list[tuple[str, list[str], ast.AST, dict[int, ast.AST]]]],
    class_index: dict[str, list[tuple[str, list[str], ast.ClassDef, dict[int, ast.AST]]]],
    call_sites: dict[str, list[tuple[str, list[str], ast.Call, dict[int, ast.AST]]]],
    origin_note: str,
    remaining_return_hops: int,
    constructor_already_proven: bool,
    max_sites: int = 8,
) -> str:
    """Summarize small exact caller fan-out without choosing an arbitrary consumer."""
    if len(sites) > max_sites:
        return f"{origin_note}; return_fanout={len(sites)} unresolved=fanout_exceeds_{max_sites}"

    flows: list[str] = []
    unresolved = 0
    for caller_path, caller_lines, call, caller_parents in sites:
        caller_fn = enclosing_function(call, caller_parents)
        if not isinstance(caller_fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
            unresolved += 1
            continue
        binding = assignment_binding_for_call(call, caller_parents)
        if binding:
            note = f"returned_to={caller_fn.name}.{binding} at {caller_path}:{getattr(call, 'lineno', 0)}"
            flow = structured_terminal_from_context(
                lines=caller_lines,
                path_name=caller_path,
                function_node=caller_fn,
                parents=caller_parents,
                tracked={binding},
                after_line=getattr(call, "lineno", 0),
                function_index=function_index,
                class_index=class_index,
                call_sites=call_sites,
                origin_note=note,
                remaining_return_hops=max(0, remaining_return_hops - 1),
                constructor_already_proven=constructor_already_proven,
            )
            if flow != "<none>":
                flows.append(flow)
            else:
                events = first_relevant_flow_events(
                    caller_lines, caller_fn, {binding}, after_line=getattr(call, "lineno", 0), limit=14
                )
                exact = exact_call_candidate(events, {binding}, function_index, caller_parents)
                if exact is not None:
                    consumer_call, _snippet, consumer_name, _definition, bindings = exact
                    binding_text = ",".join(f"{arg}->{param}" for arg, param in bindings)
                    flows.append(clip(
                        f"consumer_shape={caller_fn.name}->{consumer_name} binding={binding_text} "
                        f"at {caller_path}:{getattr(consumer_call, 'lineno', 0)}; terminal=<not proven>",
                        500,
                    ))
                else:
                    unresolved += 1
            continue

        inline = direct_constructor_context_for_call(call, class_index, caller_parents)
        if inline is not None:
            ctor_call, ctor_name, field, result_binding, returned_directly = inline
            inline_note = (
                f"inline_consumer={caller_fn.name}:{getattr(call, 'lineno', 0)} "
                f"binding=return->{ctor_name}.{field}"
            )
            if result_binding:
                flow = structured_terminal_from_context(
                    lines=caller_lines,
                    path_name=caller_path,
                    function_node=caller_fn,
                    parents=caller_parents,
                    tracked={result_binding},
                    after_line=getattr(ctor_call, "lineno", 0),
                    function_index=function_index,
                    class_index=class_index,
                    call_sites=call_sites,
                    origin_note=f"{inline_note}; constructor_result->{result_binding}",
                    remaining_return_hops=max(0, remaining_return_hops - 1),
                    constructor_already_proven=True,
                )
                if flow != "<none>":
                    flows.append(flow)
                else:
                    unresolved += 1
            elif returned_directly and remaining_return_hops > 1:
                flow = follow_exact_function_return(
                    function_name=caller_fn.name,
                    function_index=function_index,
                    class_index=class_index,
                    call_sites=call_sites,
                    origin_note=f"{inline_note}; returned_by={caller_fn.name}",
                    remaining_return_hops=remaining_return_hops - 1,
                    constructor_already_proven=True,
                )
                if flow != "<none>":
                    flows.append(flow)
                else:
                    unresolved += 1
            else:
                unresolved += 1
            continue

        direct_consumer = exact_direct_consumer_context_for_call(call, function_index, caller_parents)
        if direct_consumer is not None and constructor_already_proven:
            outer_call, consumer_name, parameter, definition = direct_consumer
            callee_path, callee_lines, callee_node, _callee_parents = definition
            callee_events = first_relevant_flow_events(callee_lines, callee_node, {parameter}, limit=18)
            guard = next(((kind, node, snippet) for kind, node, snippet in callee_events if kind in {"branch", "validation"}), None)
            if guard is not None:
                kind, guard_node, _guard_snippet = guard
                outcome = branch_outcome_evidence(callee_lines, guard_node)
                if outcome != "<no explicit bounded outcome>":
                    result_hop = exact_return_result_hop(
                        function_name=consumer_name,
                        outcome_node=branch_outcome_node(guard_node),
                        function_index=function_index,
                        class_index=class_index,
                        call_sites=call_sites,
                    )
                    suffix = f"; {result_hop}" if result_hop else ""
                    flows.append(clip(
                        f"direct_consumer={caller_fn.name}->{consumer_name} binding=return->{parameter} "
                        f"at {caller_path}:{getattr(outer_call, 'lineno', 0)}; "
                        f"{kind}@{callee_path}:{getattr(guard_node, 'lineno', 0)}="
                        f"{node_source(callee_lines, guard_node, 360)}; outcome={outcome}{suffix}",
                        700,
                    ))
                    continue
            flows.append(
                f"direct_consumer_shape={caller_fn.name}->{consumer_name} binding=return->{parameter} "
                f"at {caller_path}:{getattr(outer_call, 'lineno', 0)}; terminal=<not proven>"
            )
            continue
        unresolved += 1

    if not flows:
        return f"{origin_note}; return_fanout={len(sites)} resolved=0 unresolved={unresolved}"
    # Preserve all exact consumer shapes but keep the packet bounded. The counts make partial
    # resolution explicit so semantic review never mistakes one resolved branch for all callers.
    joined = " || ".join(flows[:4])
    return clip(
        f"{origin_note}; return_fanout={len(sites)} resolved={len(flows)} unresolved={unresolved}; {joined}",
        1500,
    )


def structured_terminal_from_context(
    *,
    lines: list[str],
    path_name: str,
    function_node: ast.AST,
    parents: dict[int, ast.AST],
    tracked: set[str],
    after_line: int,
    function_index: dict[str, list[tuple[str, list[str], ast.AST, dict[int, ast.AST]]]],
    class_index: dict[str, list[tuple[str, list[str], ast.ClassDef, dict[int, ast.AST]]]],
    call_sites: dict[str, list[tuple[str, list[str], ast.Call, dict[int, ast.AST]]]],
    origin_note: str = "",
    remaining_return_hops: int = 1,
    constructor_already_proven: bool = False,
) -> str:
    """Connect an exact tracked value to an exact callee guard with explicit branch outcome."""
    if not isinstance(function_node, (ast.FunctionDef, ast.AsyncFunctionDef)) or not tracked:
        return "<none>"

    events = first_relevant_flow_events(lines, function_node, tracked, after_line=after_line, limit=14)
    flow_tracked = set(tracked)
    notes: list[str] = [origin_note] if origin_note else []

    constructor = constructor_sink_candidate(events, flow_tracked, class_index, parents)
    constructor_proven = constructor_already_proven
    if constructor is not None:
        ctor_call, _snippet, ctor_name, ctor_binding, result_binding = constructor
        constructor_proven = True
        if result_binding:
            notes.append(f"constructor={ctor_name} binding={ctor_binding} result->{result_binding}")
            flow_tracked = {result_binding}
            events = first_relevant_flow_events(
                lines, function_node, flow_tracked, after_line=getattr(ctor_call, "lineno", 0), limit=14
            )
        else:
            stmt = enclosing_statement(ctor_call, parents)
            if isinstance(stmt, ast.Return) and stmt.value is ctor_call:
                note = f"constructor={ctor_name} binding={ctor_binding} returned_by={function_node.name}"
                prefix = "; ".join([*notes, note])
                followed = follow_exact_function_return(
                    function_name=function_node.name,
                    function_index=function_index,
                    class_index=class_index,
                    call_sites=call_sites,
                    origin_note=prefix,
                    remaining_return_hops=remaining_return_hops,
                    constructor_already_proven=True,
                )
                if followed != "<none>":
                    return followed

    # Structured terminal evidence is intentionally stricter than generic interprocedural flow:
    # require an exact project constructor field before accepting a guard as terminal structured-result evidence.
    if not constructor_proven:
        return "<none>"

    exact = exact_call_candidate(events, flow_tracked, function_index, parents)
    if exact is None:
        return "<none>"
    call, _snippet, name, definition, bindings = exact
    callee_path, callee_lines, callee_node, _callee_parents = definition
    callee_tracked = {param for _arg, param in bindings}
    callee_events = first_relevant_flow_events(callee_lines, callee_node, callee_tracked, limit=18)
    guard = next(((kind, node, snippet) for kind, node, snippet in callee_events if kind in {"branch", "validation"}), None)
    if guard is None:
        return "<none>"
    kind, guard_node, _guard_snippet = guard
    outcome = branch_outcome_evidence(callee_lines, guard_node)
    if outcome == "<no explicit bounded outcome>":
        return "<none>"

    outcome_node = branch_outcome_node(guard_node)
    result_hop = exact_return_result_hop(
        function_name=name,
        outcome_node=outcome_node,
        function_index=function_index,
        class_index=class_index,
        call_sites=call_sites,
    )

    binding_text = ",".join(f"{arg}->{param}" for arg, param in bindings)
    prefix = "; ".join(notes)
    if prefix:
        prefix += "; "
    suffix = f"; {result_hop}" if result_hop else ""
    return clip(
        f"{prefix}call={function_node.name}->{name} binding={binding_text} at {path_name}:{getattr(call, 'lineno', 0)}; "
        f"{kind}@{callee_path}:{getattr(guard_node, 'lineno', 0)}={node_source(callee_lines, guard_node, 520)}; outcome={outcome}{suffix}",
        1300,
    )


def structured_terminal_evidence(
    *,
    lines: list[str],
    path_name: str,
    handler: ast.ExceptHandler,
    try_node: ast.AST | None,
    function_node: ast.AST | None,
    parents: dict[int, ast.AST],
    function_index: dict[str, list[tuple[str, list[str], ast.AST, dict[int, ast.AST]]]],
    class_index: dict[str, list[tuple[str, list[str], ast.ClassDef, dict[int, ast.AST]]]],
    call_sites: dict[str, list[tuple[str, list[str], ast.Call, dict[int, ast.AST]]]],
) -> str:
    """Expose an exact sentinel/value -> caller/constructor -> evaluator guard -> outcome path.

    Direct handler fallback returns are treated as synthetic affected values,
    because many real helpers encode failure as ``return None``/``return UNKNOWN`` and only
    become outward-result-relevant in their caller. No domain verdict is inferred from names.
    """
    if try_node is None or not isinstance(function_node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        return "<none>"
    try_end = getattr(try_node, "end_lineno", getattr(try_node, "lineno", 0))

    candidate = assigned_keys(list(getattr(try_node, "body", []))) | assigned_keys(list(handler.body))
    post_used = keys_used_after(function_node, try_end)
    tracked = {key for key in candidate if related_key(key, post_used)}
    if not tracked:
        tracked = set(assigned_keys(list(handler.body)))
    if tracked:
        local = structured_terminal_from_context(
            lines=lines,
            path_name=path_name,
            function_node=function_node,
            parents=parents,
            tracked=tracked,
            after_line=try_end,
            function_index=function_index,
            class_index=class_index,
            call_sites=call_sites,
        )
        if local != "<none>":
            return local

    # Synthetic fallback-return origin: follow one exact caller binding, then reuse the same
    # constructor/evaluator proof machinery in the caller. Multiple definitions/sites remain
    # deliberately unresolved.
    sentinel_returns = [(ret, sentinel_repr(ret.value)) for ret in direct_handler_returns(handler)]
    sentinel_returns = [(ret, sentinel) for ret, sentinel in sentinel_returns if sentinel is not None]
    if not sentinel_returns:
        return "<none>"
    function_name = function_node.name
    sites = call_sites.get(function_name, [])
    if len(function_index.get(function_name, [])) != 1 or len(sites) != 1:
        return "<none>"
    caller_path, caller_lines, call, caller_parents = sites[0]
    caller_fn = enclosing_function(call, caller_parents)
    if not isinstance(caller_fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
        return "<none>"
    ret, sentinel = sentinel_returns[0]
    binding = assignment_binding_for_call(call, caller_parents)
    if binding:
        origin = (
            f"fallback_return={sentinel} source={path_name}:{getattr(ret, 'lineno', 0)}; "
            f"caller_binding=return->{binding} at {caller_path}:{getattr(call, 'lineno', 0)}"
        )
        return structured_terminal_from_context(
            lines=caller_lines,
            path_name=caller_path,
            function_node=caller_fn,
            parents=caller_parents,
            tracked={binding},
            after_line=getattr(call, "lineno", 0),
            function_index=function_index,
            class_index=class_index,
            call_sites=call_sites,
            origin_note=origin,
        )

    # Inline constructor binding: ``return ResultEnvelope(field=helper())``. The helper result
    # has no local variable, but the constructor keyword provides an exact structural binding.
    inline = direct_constructor_context_for_call(call, class_index, caller_parents)
    if inline is None:
        return "<none>"
    ctor_call, ctor_name, field, result_binding, returned_directly = inline
    origin = (
        f"fallback_return={sentinel} source={path_name}:{getattr(ret, 'lineno', 0)}; "
        f"inline_constructor={ctor_name} binding=return->{ctor_name}.{field} at {caller_path}:{getattr(ctor_call, 'lineno', 0)}"
    )
    if result_binding:
        return structured_terminal_from_context(
            lines=caller_lines,
            path_name=caller_path,
            function_node=caller_fn,
            parents=caller_parents,
            tracked={result_binding},
            after_line=getattr(ctor_call, "lineno", 0),
            function_index=function_index,
            class_index=class_index,
            call_sites=call_sites,
            origin_note=f"{origin}; constructor_result->{result_binding}",
        )
    if returned_directly:
        return follow_exact_function_return(
            function_name=caller_fn.name,
            function_index=function_index,
            class_index=class_index,
            call_sites=call_sites,
            origin_note=f"{origin}; returned_by={caller_fn.name}",
            remaining_return_hops=1,
            constructor_already_proven=True,
        )
    return "<none>"


def enclosing_statement(node: ast.AST, parents: dict[int, ast.AST]) -> ast.stmt | None:
    current: ast.AST | None = node
    while current is not None:
        if isinstance(current, ast.stmt):
            return current
        current = parents.get(id(current))
    return None


def enclosing_function(node: ast.AST, parents: dict[int, ast.AST]) -> ast.AST | None:
    return nearest(node, parents, (ast.FunctionDef, ast.AsyncFunctionDef))


def function_parameters(function_node: ast.AST) -> list[str]:
    if not isinstance(function_node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        return []
    args = function_node.args
    ordered = [*args.posonlyargs, *args.args, *args.kwonlyargs]
    return [arg.arg for arg in ordered]


def enclosing_class_name(function_node: ast.AST, parents: dict[int, ast.AST] | None) -> str | None:
    if parents is None:
        return None
    current = parents.get(id(function_node))
    while current is not None:
        if isinstance(current, ast.ClassDef):
            return current.name
        if isinstance(current, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            break
        current = parents.get(id(current))
    return None


def positional_parameter_offset(
    call: ast.Call,
    function_node: ast.AST,
    parents: dict[int, ast.AST] | None,
) -> int:
    """Return the exact positional offset for a bound instance/class method call.

    `obj.method(x)` binds `x` to the parameter after `self`/`cls`. An explicit unbound
    `Class.method(obj, x)` does not. The decision is structural and never based on naming
    heuristics beyond the conventional receiver parameter itself.
    """
    params = function_parameters(function_node)
    if not params or params[0] not in {"self", "cls"} or not isinstance(call.func, ast.Attribute):
        return 0
    class_name = enclosing_class_name(function_node, parents)
    receiver = call.func.value
    if class_name and isinstance(receiver, ast.Name) and receiver.id == class_name:
        return 0
    return 1


def keys_used_after(function_node: ast.AST, after_line: int) -> set[str]:
    keys: set[str] = set()
    for node in function_body_nodes(function_node):
        lineno = getattr(node, "lineno", 0)
        if lineno and lineno > after_line:
            keys.update(loaded_keys(node))
    return keys


def related_key(key: str, candidates: set[str]) -> bool:
    return any(
        key == other or key.startswith(f"{other}.") or other.startswith(f"{key}.")
        for other in candidates
    )


def block_definitely_exits(statements: list[ast.stmt]) -> bool:
    """Conservatively prove that a statement block cannot fall through."""
    for statement in statements:
        if isinstance(statement, (ast.Return, ast.Raise, ast.Continue, ast.Break)):
            return True
        if isinstance(statement, ast.If):
            if statement.orelse and block_definitely_exits(statement.body) and block_definitely_exits(statement.orelse):
                return True
        elif isinstance(statement, ast.Match):
            if statement.cases and all(block_definitely_exits(case.body) for case in statement.cases):
                # A wildcard final case is required before Match can be considered exhaustive.
                last = statement.cases[-1].pattern
                if isinstance(last, ast.MatchAs) and last.name is None and last.pattern is None:
                    return True
    return False


def following_statement(node: ast.AST, parents: dict[int, ast.AST]) -> ast.stmt | None:
    parent = parents.get(id(node))
    if parent is None:
        return None
    for attr in ("body", "orelse", "finalbody"):
        statements = getattr(parent, attr, None)
        if not isinstance(statements, list) or node not in statements:
            continue
        index = statements.index(node)
        if index + 1 < len(statements) and isinstance(statements[index + 1], ast.stmt):
            return statements[index + 1]
    return None


def handler_control_flow_evidence(
    *,
    lines: list[str],
    handler: ast.ExceptHandler,
    try_node: ast.AST | None,
    parents: dict[int, ast.AST],
) -> str:
    """Summarize complete handler exit topology without reproducing the whole handler body."""
    branches: list[ast.AST] = []
    exits: list[tuple[int, str]] = []

    class Visitor(ast.NodeVisitor):
        def visit_If(self, node: ast.If):
            branches.append(node)
            self.generic_visit(node)

        def visit_Match(self, node: ast.Match):
            branches.append(node)
            self.generic_visit(node)

        def visit_Return(self, node: ast.Return):
            exits.append((getattr(node, "lineno", 0), "return"))

        def visit_Raise(self, node: ast.Raise):
            exits.append((getattr(node, "lineno", 0), "raise"))

        def visit_Continue(self, node: ast.Continue):
            exits.append((getattr(node, "lineno", 0), "continue"))

        def visit_Break(self, node: ast.Break):
            exits.append((getattr(node, "lineno", 0), "break"))

        def visit_FunctionDef(self, node: ast.FunctionDef):
            return

        def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef):
            return

        def visit_ClassDef(self, node: ast.ClassDef):
            return

        def visit_Lambda(self, node: ast.Lambda):
            return

    visitor = Visitor()
    for statement in handler.body:
        visitor.visit(statement)

    branch_bits: list[str] = []
    for node in branches[:6]:
        if isinstance(node, ast.If):
            try:
                test = ast.unparse(node.test)
            except Exception:
                test = "<if>"
            branch_bits.append(f"{getattr(node, 'lineno', 0)}:{clip(test, 100)}")
        else:
            branch_bits.append(f"{getattr(node, 'lineno', 0)}:match")
    exits_text = ",".join(f"{kind}@{line}" for line, kind in sorted(exits)) or "<none>"
    definitely_exits = block_definitely_exits(list(handler.body))
    target = following_statement(try_node, parents) if try_node is not None else None
    target_text = node_source(lines, target, 360) if target is not None else "<none>"
    branches_text = " | ".join(branch_bits) if branch_bits else "<none>"
    return clip(
        f"branches={len(branches)} tests={branches_text}; explicit_exits={exits_text}; "
        f"fallthrough={'no' if definitely_exits else 'yes'}; fallthrough_target={target_text}",
        900,
    )


def handler_control_transfer(handler: ast.ExceptHandler) -> str | None:
    """Return the first direct control-transfer semantics of the handler.

    Nested functions/classes are excluded; only control transfer executed by this handler is
    relevant to the caught failure.
    """
    found: list[tuple[int, str]] = []

    class Visitor(ast.NodeVisitor):
        def visit_Continue(self, node: ast.Continue):
            found.append((getattr(node, "lineno", 0), "continue"))

        def visit_Break(self, node: ast.Break):
            found.append((getattr(node, "lineno", 0), "break"))

        def visit_Return(self, node: ast.Return):
            found.append((getattr(node, "lineno", 0), "return"))

        def visit_Raise(self, node: ast.Raise):
            found.append((getattr(node, "lineno", 0), "raise"))

        def visit_FunctionDef(self, node: ast.FunctionDef):
            return

        def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef):
            return

        def visit_ClassDef(self, node: ast.ClassDef):
            return

        def visit_Lambda(self, node: ast.Lambda):
            return

    visitor = Visitor()
    for statement in handler.body:
        visitor.visit(statement)
    return min(found)[1] if found else None


def loop_omission_evidence(
    *,
    lines: list[str],
    handler: ast.ExceptHandler,
    try_node: ast.AST,
    parents: dict[int, ast.AST],
) -> tuple[str, str]:
    """Describe statements skipped by `continue` without asserting domain authority.

    The reviewer can combine this structural omission with source/domain evidence to decide
    whether it is an authoritative-record finding.
    """
    loop = nearest(handler, parents, (ast.For, ast.AsyncFor, ast.While))
    if not isinstance(loop, (ast.For, ast.AsyncFor, ast.While)):
        return "iteration_omission", "continue exits current iteration; enclosing loop unresolved"

    current: ast.AST = try_node
    while parents.get(id(current)) is not loop:
        parent = parents.get(id(current))
        if parent is None or parent is handler:
            break
        current = parent
    body = list(loop.body)
    if current not in body:
        return "iteration_omission", "continue exits current iteration; skipped loop tail unresolved"
    index = body.index(current)
    skipped = body[index + 1 :]
    mutated = sorted(assigned_keys(skipped))
    snippet = nodes_source(lines, skipped[:3], 420) if skipped else "<no later loop statements>"
    mutation_text = ",".join(mutated) if mutated else "<none detected>"
    return (
        "iteration_omission",
        f"continue skips current-iteration tail; skipped_mutations={mutation_text}; skipped={snippet}",
    )


def assignment_binding_for_call(call: ast.Call, parents: dict[int, ast.AST]) -> str | None:
    stmt = enclosing_statement(call, parents)
    if isinstance(stmt, ast.Assign) and stmt.value is call and len(stmt.targets) == 1:
        return expression_key(stmt.targets[0])
    if isinstance(stmt, ast.AnnAssign) and stmt.value is call:
        return expression_key(stmt.target)
    if isinstance(stmt, ast.NamedExpr) and stmt.value is call:
        return expression_key(stmt.target)
    return None


def direct_constructor_context_for_call(
    call: ast.Call,
    class_index: dict[str, list[tuple[str, list[str], ast.ClassDef, dict[int, ast.AST]]]],
    parents: dict[int, ast.AST],
) -> tuple[ast.Call, str, str, str | None, bool] | None:
    """Find an exact direct ``Ctor(field=<call>)`` binding around a call site.

    The helper call must be the keyword value itself. Wrapping transformations such as
    ``Ctor(field=normalize(helper()))`` are deliberately not treated as transparent.
    Returns ``(constructor_call, constructor_name, field, result_binding, returned_directly)``.
    """
    current = parents.get(id(call))
    while current is not None:
        if isinstance(current, ast.Call):
            name = call_name(current)
            classes = class_index.get(name or "", []) if name else []
            if len(classes) == 1:
                fields = class_constructor_fields(classes[0][2])
                for kw in current.keywords:
                    if kw.arg is None or kw.arg not in fields or kw.value is not call:
                        continue
                    stmt = enclosing_statement(current, parents)
                    result_binding = assignment_binding_for_call(current, parents)
                    returned_directly = isinstance(stmt, ast.Return) and stmt.value is current
                    return current, name or "<constructor>", kw.arg, result_binding, returned_directly
        current = parents.get(id(current))
    return None


def exact_direct_consumer_context_for_call(
    call: ast.Call,
    function_index: dict[str, list[tuple[str, list[str], ast.AST, dict[int, ast.AST]]]],
    parents: dict[int, ast.AST],
) -> tuple[ast.Call, str, str, tuple[str, list[str], ast.AST, dict[int, ast.AST]]] | None:
    """Find an exact outer call that consumes this call result as a direct argument.

    Only identity-direct positional/keyword arguments qualify; wrappers such as
    ``evaluate(normalize(builder()))`` remain unresolved. The result is the outer call,
    callee name, bound parameter, and its unique project-local definition.
    """
    current = parents.get(id(call))
    while current is not None:
        if isinstance(current, ast.Call):
            name = call_name(current)
            defs = function_index.get(name or "", []) if name else []
            if len(defs) == 1:
                definition = defs[0]
                params = function_parameters(definition[2])
                offset = positional_parameter_offset(current, definition[2], definition[3])
                positional = params[offset:]
                for index, arg in enumerate(current.args):
                    if arg is call and index < len(positional):
                        return current, name or "<call>", positional[index], definition
                param_names = set(params)
                for kw in current.keywords:
                    if kw.arg is not None and kw.arg in param_names and kw.value is call:
                        return current, name or "<call>", kw.arg, definition
        if isinstance(current, ast.stmt):
            break
        current = parents.get(id(current))
    return None


def matching_argument_bindings(
    call: ast.Call,
    function_node: ast.AST,
    tracked: set[str],
    parents: dict[int, ast.AST] | None = None,
) -> list[tuple[str, str]]:
    """Return exact caller-expression -> callee-parameter bindings for tracked arguments.

    Positional and explicit keyword arguments are handled. Bound instance/class methods skip
    the implicit `self`/`cls` receiver. Star-args/kwargs are deliberately ignored because their
    binding cannot be proven locally.
    """
    params = function_parameters(function_node)
    offset = positional_parameter_offset(call, function_node, parents)
    positional = params[offset:]
    bindings: list[tuple[str, str]] = []
    for index, arg in enumerate(call.args):
        if isinstance(arg, ast.Starred) or not touches_tracked(arg, tracked) or index >= len(positional):
            continue
        try:
            rendered = ast.unparse(arg)
        except Exception:
            rendered = expression_key(arg) or "<expr>"
        bindings.append((rendered, positional[index]))
    param_names = set(params)
    for kw in call.keywords:
        if kw.arg is None or kw.arg not in param_names or not touches_tracked(kw.value, tracked):
            continue
        try:
            rendered = ast.unparse(kw.value)
        except Exception:
            rendered = expression_key(kw.value) or "<expr>"
        bindings.append((rendered, kw.arg))
    return bindings


CONTAINER_READ_METHODS = {"get", "items", "keys", "values", "copy"}
LOW_VALUE_CALL_WORDS = ("log", "debug", "trace", "print", "render", "display", "notify", "message", "label", "chart")
CORE_FLOW_CALL_WORDS = ("save", "persist", "commit", "flush", "serialize", "export", "sync", "upsert", "evaluate", "validate", "resolve", "process", "execute", "recalc", "calculate", "compute", "apply")


def is_container_read_call(call: ast.Call, tracked: set[str]) -> bool:
    """Treat common mapping/container accessors as reads, not interprocedural edges.

    This is structural: only an attribute call on a tracked receiver qualifies. It prevents
    project-local methods named ``get`` from making ``mapping.get(...)`` look ambiguous.
    """
    return (
        isinstance(call.func, ast.Attribute)
        and call.func.attr in CONTAINER_READ_METHODS
        and touches_tracked(call.func.value, tracked)
    )


def first_relevant_flow_events(
    lines: list[str],
    function_node: ast.AST,
    tracked: set[str],
    *,
    after_line: int = 0,
    limit: int = 5,
) -> list[tuple[str, ast.AST, str]]:
    """Collect bounded control/call/return events touching tracked values.

    Container accessors remain visible as local reads but are deliberately excluded from
    caller/callee resolution.
    """
    events: list[tuple[str, ast.AST, str]] = []
    seen: set[tuple[str, int]] = set()
    for node in function_body_nodes(function_node):
        lineno = getattr(node, "lineno", 0)
        if not lineno or lineno <= after_line:
            continue
        kind: str | None = None
        subject: ast.AST | None = None
        if isinstance(node, ast.If):
            kind, subject = "branch", node.test
        elif isinstance(node, ast.Assert):
            kind, subject = "validation", node.test
        elif isinstance(node, ast.Raise):
            kind, subject = "explicit_failure", node.exc
        elif isinstance(node, ast.Return):
            kind, subject = "return", node.value
        elif isinstance(node, ast.Call):
            kind = "container_read" if is_container_read_call(node, tracked) else "call"
            subject = node
        if kind is None or subject is None or not touches_tracked(subject, tracked):
            continue
        marker = (kind, lineno)
        if marker in seen:
            continue
        seen.add(marker)
        events.append((kind, node, f"{lineno}: {line_window(lines, lineno, 1, 300)}"))
        if len(events) >= limit:
            break
    return events


def call_priority(call: ast.Call, parents: dict[int, ast.AST] | None) -> int:
    """Rank propagation calls without using the rank as a semantic verdict.

    Persistence/core-processing calls are inspected before logging/UI calls. The exact
    snippet remains evidence; ranking alone never establishes safety or a finding.
    """
    name = (call_name(call) or "").lower()
    score = 50
    if any(word in name for word in CORE_FLOW_CALL_WORDS):
        score += 60
    if any(word in name for word in LOW_VALUE_CALL_WORDS):
        score -= 80
    if parents is not None:
        stmt = enclosing_statement(call, parents)
        if isinstance(stmt, ast.Return):
            score += 50
        elif isinstance(stmt, (ast.Assign, ast.AnnAssign, ast.NamedExpr)):
            score += 25
        elif isinstance(stmt, ast.Expr):
            score += 5
    return score


def terminal_kind_for_call(call: ast.Call) -> str:
    # A call that consumes the tracked value is a concrete outward use. Do not infer
    # domain/persistence semantics from naming alone; the reviewer gets the exact snippet.
    return "core_call"


def class_constructor_fields(class_node: ast.ClassDef) -> set[str]:
    fields: set[str] = set()
    for statement in class_node.body:
        if isinstance(statement, ast.AnnAssign) and isinstance(statement.target, ast.Name):
            fields.add(statement.target.id)
        elif isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)) and statement.name == "__init__":
            params = function_parameters(statement)
            if params and params[0] in {"self", "cls"}:
                params = params[1:]
            fields.update(params)
    return fields


def constructor_call_binding(
    call: ast.Call,
    tracked: set[str],
    class_index: dict[str, list[tuple[str, list[str], ast.ClassDef, dict[int, ast.AST]]]],
) -> str | None:
    """Return exact tracked-expression -> constructor-field keyword bindings."""
    name = call_name(call)
    if not name:
        return None
    classes = class_index.get(name, [])
    if len(classes) != 1:
        return None
    fields = class_constructor_fields(classes[0][2])
    bindings: list[str] = []
    for kw in call.keywords:
        if kw.arg is None or kw.arg not in fields or not touches_tracked(kw.value, tracked):
            continue
        try:
            rendered = ast.unparse(kw.value)
        except Exception:
            rendered = expression_key(kw.value) or "<expr>"
        bindings.append(f"{rendered}->{name}.{kw.arg}")
    return ",".join(bindings) if bindings else None


def return_container_binding(
    return_node: ast.Return,
    tracked: set[str],
    class_index: dict[str, list[tuple[str, list[str], ast.ClassDef, dict[int, ast.AST]]]],
) -> str | None:
    """Return an exact tracked-value -> returned-container-field binding when provable."""
    value = return_node.value
    return constructor_call_binding(value, tracked, class_index) if isinstance(value, ast.Call) else None


def constructor_sink_candidate(
    events: list[tuple[str, ast.AST, str]],
    tracked: set[str],
    class_index: dict[str, list[tuple[str, list[str], ast.ClassDef, dict[int, ast.AST]]]],
    parents: dict[int, ast.AST] | None,
) -> tuple[ast.Call, str, str, str, str | None] | None:
    candidates: list[tuple[int, int, ast.Call, str, str, str, str | None]] = []
    for kind, node, snippet in events:
        if kind != "call" or not isinstance(node, ast.Call):
            continue
        binding = constructor_call_binding(node, tracked, class_index)
        if not binding:
            continue
        name = call_name(node) or "<constructor>"
        result_binding = assignment_binding_for_call(node, parents) if parents is not None else None
        candidates.append((-call_priority(node, parents), getattr(node, "lineno", 0), node, snippet, name, binding, result_binding))
    if not candidates:
        return None
    _neg_rank, _line, node, snippet, name, binding, result_binding = min(candidates, key=lambda item: (item[0], item[1]))
    return node, snippet, name, binding, result_binding


def exact_call_candidate(
    events: list[tuple[str, ast.AST, str]],
    tracked: set[str],
    function_index: dict[str, list[tuple[str, list[str], ast.AST, dict[int, ast.AST]]]],
    parents: dict[int, ast.AST] | None = None,
) -> tuple[ast.Call, str, str, tuple[str, list[str], ast.AST, dict[int, ast.AST]], list[tuple[str, str]]] | None:
    """Select the highest-value exact tracked call, de-prioritizing logging/UI calls without domain-specific names."""
    candidates: list[tuple[int, int, ast.Call, str, str, tuple[str, list[str], ast.AST, dict[int, ast.AST]], list[tuple[str, str]]]] = []
    for kind, node, snippet in events:
        if kind != "call" or not isinstance(node, ast.Call):
            continue
        name = call_name(node)
        if not name:
            continue
        defs = function_index.get(name, [])
        if len(defs) != 1:
            continue
        definition = defs[0]
        bindings = matching_argument_bindings(node, definition[2], tracked, definition[3])
        if bindings:
            candidates.append((-call_priority(node, parents), getattr(node, "lineno", 0), node, snippet, name, definition, bindings))
    if not candidates:
        return None
    _neg_rank, _line, node, snippet, name, definition, bindings = min(candidates, key=lambda item: (item[0], item[1]))
    return node, snippet, name, definition, bindings


def ambiguous_call_in_node(
    node: ast.AST | None,
    tracked: set[str],
    function_index: dict[str, list[tuple[str, list[str], ast.AST, dict[int, ast.AST]]]],
) -> tuple[str, int] | None:
    """Find an exact-name ambiguous local call inside a required returned expression."""
    if node is None:
        return None
    for current in ast.walk(node):
        if not isinstance(current, ast.Call) or is_container_read_call(current, tracked):
            continue
        if not touches_tracked(current, tracked):
            continue
        name = call_name(current)
        if not name:
            continue
        count = len(function_index.get(name, []))
        if count > 1:
            return name, count
    return None


def first_ambiguous_call(
    events: list[tuple[str, ast.AST, str]],
    tracked: set[str],
    function_index: dict[str, list[tuple[str, list[str], ast.AST, dict[int, ast.AST]]]],
) -> tuple[ast.Call, str, str, int] | None:
    for kind, node, snippet in events:
        if kind != "call" or not isinstance(node, ast.Call):
            continue
        name = call_name(node)
        if not name:
            continue
        defs = function_index.get(name, [])
        # No local definition may be an external call/constructor; only multiple local
        # definitions are genuinely ambiguous for exact binding.
        if len(defs) > 1 and touches_tracked(node, tracked):
            return node, snippet, name, len(defs)
    return None


def interprocedural_evidence(
    *,
    lines: list[str],
    path_name: str,
    handler: ast.ExceptHandler,
    try_node: ast.AST | None,
    function_node: ast.AST | None,
    parents: dict[int, ast.AST],
    function_index: dict[str, list[tuple[str, list[str], ast.AST, dict[int, ast.AST]]]],
    class_index: dict[str, list[tuple[str, list[str], ast.ClassDef, dict[int, ast.AST]]]],
    call_sites: dict[str, list[tuple[str, list[str], ast.Call, dict[int, ast.AST]]]],
) -> str:
    """Build bounded value-directed expanded evidence with at most two call edges.

    The trace is conservative: exact structural bindings are followed, ambiguous local
    definitions remain unknown, and control-transfer handlers are represented explicitly.
    """
    if try_node is None or not isinstance(function_node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        return "origin=<none>; terminal=unknown"

    try_end = getattr(try_node, "end_lineno", getattr(try_node, "lineno", 0))
    try_assigned = assigned_keys(list(getattr(try_node, "body", [])))
    handler_assigned = assigned_keys(list(handler.body))
    candidate_tracked = set(try_assigned) | set(handler_assigned)
    post_used = keys_used_after(function_node, try_end)
    tracked = {key for key in candidate_tracked if related_key(key, post_used)}
    # If nothing is read later, keep handler assignments as direct effects. This preserves
    # evidence for persistence/mutation patterns whose AST use may live in an enclosing node.
    if not tracked:
        tracked = set(handler_assigned)

    handler_returns = direct_handler_returns(handler)
    control = handler_control_transfer(handler)

    effects: list[str] = []
    for key in sorted(handler_assigned):
        effects.append(f"{key}=handler-assigned")
    if control == "continue":
        effects.append("control=continue")
    elif control == "break":
        effects.append("control=break")
    elif control == "raise":
        effects.append("control=raise")
    if handler_returns:
        for ret in handler_returns[:2]:
            effects.append(f"return@{getattr(ret, 'lineno', 0)}={node_source(lines, ret, 150)}")
    if not effects and tracked:
        effects.append("fallback=preexisting-value-preserved")
    if not tracked and not handler_returns and control is None:
        return "origin=affected=<none>; terminal=unknown"

    function_name = function_node.name
    origin = (
        f"origin={path_name}:{getattr(handler, 'lineno', 0)} function={function_name} "
        f"affected={','.join(sorted(tracked)) or '<control/return-only>'} "
        f"effect={' | '.join(effects) if effects else '<none>'}"
    )

    # Control transfer is semantically stronger than generic post-handler reads. In particular,
    # `continue` means statements later in the current iteration are not executed at all.
    if control == "raise":
        return clip(f"{origin}; local=<control-transfer>; edges=<none>; terminal=explicit_failure evidence={node_source(lines, handler, 360)}", 1450)
    if control == "continue":
        terminal, evidence_text = loop_omission_evidence(lines=lines, handler=handler, try_node=try_node, parents=parents)
        return clip(f"{origin}; local=<control-transfer>; edges=<none>; terminal={terminal} evidence={evidence_text}", 1450)
    if control == "break":
        return clip(
            f"{origin}; local=<control-transfer>; edges=<none>; terminal=loop_termination evidence=break exits enclosing loop after caught failure",
            1450,
        )

    events = first_relevant_flow_events(lines, function_node, tracked, after_line=try_end, limit=10) if tracked else []
    local = " | ".join(f"{kind}:{snippet}" for kind, _node, snippet in events[:6]) or "<none>"
    edges: list[str] = []
    terminal = "unknown"
    terminal_evidence = "<not proven>"

    # Direct fallback returns are caller-visible. Follow one exact caller binding when available.
    if handler_returns and not tracked:
        sites = call_sites.get(function_name, [])
        if len(function_index.get(function_name, [])) == 1 and len(sites) == 1:
            caller_path, caller_lines, call, caller_parents = sites[0]
            binding = assignment_binding_for_call(call, caller_parents)
            caller_fn = enclosing_function(call, caller_parents)
            if binding and isinstance(caller_fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
                edges.append(f"edge1={function_name}->{caller_fn.name} binding=return->{binding} at {caller_path}:{getattr(call, 'lineno', 0)}")
                caller_events = first_relevant_flow_events(caller_lines, caller_fn, {binding}, after_line=getattr(call, "lineno", 0), limit=10)
                exact = exact_call_candidate(caller_events, {binding}, function_index, caller_parents)
                failure = next(((n, sn) for k, n, sn in caller_events if k == "explicit_failure"), None)
                ret = next(((n, sn) for k, n, sn in caller_events if k == "return"), None)
                if failure is not None:
                    terminal, terminal_evidence = "explicit_failure", failure[1]
                elif exact is not None:
                    node2, snippet2, _name2, _def2, _bindings2 = exact
                    terminal, terminal_evidence = terminal_kind_for_call(node2), snippet2
                elif ret is not None:
                    terminal, terminal_evidence = "normal_return", ret[1]
        if terminal == "unknown":
            terminal, terminal_evidence = "normal_return", node_source(lines, handler_returns[0], 240)
        return clip(f"{origin}; local={local}; {'; '.join(edges) if edges else 'edges=<none>'}; terminal={terminal} evidence={terminal_evidence}", 1450)

    # A tracked value placed into a known returned data container is already an outward sink.
    for kind, node, snippet in events:
        if kind == "return" and isinstance(node, ast.Return):
            binding = return_container_binding(node, tracked, class_index)
            if binding:
                terminal = "normal_return"
                terminal_evidence = f"returned_container_binding={binding}; {snippet}"
                break

    # A local constructor can carry an affected value into a structured result/data object. When
    # the constructed object is assigned, continue from that exact result variable without
    # consuming an interprocedural edge. This exposes e.g. mapping.get(...) -> ResultEnvelope.value
    # -> result -> process(result).
    flow_events = events
    flow_tracked = tracked
    constructor_note = ""
    if terminal == "unknown":
        constructor = constructor_sink_candidate(events, tracked, class_index, parents)
        if constructor is not None:
            ctor_call, ctor_snippet, ctor_name, ctor_binding, result_binding = constructor
            constructor_note = f"constructor={ctor_name} binding={ctor_binding}"
            if result_binding:
                constructor_note += f" result->{result_binding}"
                flow_tracked = {result_binding}
                flow_events = first_relevant_flow_events(
                    lines, function_node, flow_tracked, after_line=getattr(ctor_call, "lineno", 0), limit=10
                )
                local = f"{local} | {constructor_note}" if local != "<none>" else constructor_note
            else:
                terminal = "core_call"
                terminal_evidence = f"{constructor_note}; {ctor_snippet}"

    # Prefer the highest-value exact call consuming the current propagated value. Logging/UI
    # calls remain local evidence but lose to persistence/core propagation.
    exact_local = exact_call_candidate(flow_events, flow_tracked, function_index, parents) if terminal == "unknown" else None
    if exact_local is not None:
        call, snippet, name, definition, bindings = exact_local
        callee_path, callee_lines, callee_node, _callee_parents = definition
        binding_text = ", ".join(f"{a}->{p}" for a, p in bindings)
        edges.append(f"edge1={function_name}->{name} binding={binding_text} at {path_name}:{getattr(call, 'lineno', 0)}")
        callee_tracked = {param for _arg, param in bindings}
        callee_events = first_relevant_flow_events(callee_lines, callee_node, callee_tracked, limit=10)
        failure = next(((n, sn) for k, n, sn in callee_events if k == "explicit_failure"), None)
        exact_second = exact_call_candidate(callee_events, callee_tracked, function_index, _callee_parents)
        return_second = next(((n, sn) for k, n, sn in callee_events if k == "return"), None)
        if failure is not None:
            terminal, terminal_evidence = "explicit_failure", failure[1]
        elif exact_second is not None:
            node2, snippet2, name2, _definition2, bindings2 = exact_second
            edges.append(
                f"edge2={name}->{name2} binding={','.join(f'{a}->{p}' for a,p in bindings2)} "
                f"at {callee_path}:{getattr(node2, 'lineno', 0)}"
            )
            terminal, terminal_evidence = terminal_kind_for_call(node2), snippet2
        elif return_second is not None:
            node2, snippet2 = return_second
            ambiguous_return = ambiguous_call_in_node(node2.value if isinstance(node2, ast.Return) else None, callee_tracked, function_index)
            if ambiguous_return is not None:
                name2, count2 = ambiguous_return
                terminal = "unknown"
                terminal_evidence = f"ambiguous second-hop callee {name2}: {count2} definitions in required return; {snippet2}"
            else:
                container_binding = return_container_binding(node2, callee_tracked, class_index) if isinstance(node2, ast.Return) else None
                terminal = "normal_return"
                terminal_evidence = f"returned_container_binding={container_binding}; {snippet2}" if container_binding else snippet2
        else:
            ambiguous = first_ambiguous_call(callee_events, callee_tracked, function_index)
            if ambiguous is not None:
                _node2, snippet2, name2, count2 = ambiguous
                terminal = "unknown"
                terminal_evidence = f"ambiguous second-hop callee {name2}: {count2} definitions; {snippet2}"

    # If no exact callee path resolved, a returned tracked value can still be followed into one
    # unambiguous caller binding. Multiple caller sites remain unknown rather than guessed.
    if terminal == "unknown" and not edges:
        return_events = [(node, snippet) for kind, node, snippet in events if kind == "return" and isinstance(node, ast.Return)]
        if return_events:
            ambiguous_local = first_ambiguous_call(events, tracked, function_index)
            if ambiguous_local is not None:
                _call, snippet, name, count = ambiguous_local
                terminal_evidence = f"ambiguous/unresolved callee {name}: {count} definitions; {snippet}"
            else:
                sites = call_sites.get(function_name, [])
                if len(function_index.get(function_name, [])) == 1 and len(sites) == 1:
                    caller_path, caller_lines, call, caller_parents = sites[0]
                    binding = assignment_binding_for_call(call, caller_parents)
                    caller_fn = enclosing_function(call, caller_parents)
                    if binding and isinstance(caller_fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        edges.append(f"edge1={function_name}->{caller_fn.name} binding=return->{binding} at {caller_path}:{getattr(call, 'lineno', 0)}")
                        caller_events = first_relevant_flow_events(caller_lines, caller_fn, {binding}, after_line=getattr(call, "lineno", 0), limit=10)
                        failure = next(((n, sn) for k, n, sn in caller_events if k == "explicit_failure"), None)
                        exact_second = exact_call_candidate(caller_events, {binding}, function_index, caller_parents)
                        ret = next(((n, sn) for k, n, sn in caller_events if k == "return"), None)
                        if failure is not None:
                            terminal, terminal_evidence = "explicit_failure", failure[1]
                        elif exact_second is not None:
                            node2, snippet2, name2, _definition2, bindings2 = exact_second
                            edges.append(
                                f"edge2={caller_fn.name}->{name2} binding={','.join(f'{a}->{p}' for a,p in bindings2)} "
                                f"at {caller_path}:{getattr(node2, 'lineno', 0)}"
                            )
                            terminal, terminal_evidence = terminal_kind_for_call(node2), snippet2
                        elif ret is not None:
                            ret_node, ret_snippet = ret
                            ambiguous_return = ambiguous_call_in_node(
                                ret_node.value if isinstance(ret_node, ast.Return) else None, {binding}, function_index
                            )
                            if ambiguous_return is not None:
                                name2, count2 = ambiguous_return
                                terminal, terminal_evidence = "unknown", f"ambiguous second-hop callee {name2}: {count2} definitions in required return; {ret_snippet}"
                            else:
                                terminal, terminal_evidence = "normal_return", ret_snippet
                    else:
                        terminal, terminal_evidence = "normal_return", return_events[0][1]
                elif len(sites) > 1:
                    terminal_evidence = f"{len(sites)} caller sites; ambiguous fan-out"
                else:
                    # The tracked value is in the function's returned expression; this is a
                    # concrete caller-visible sink even when no local caller is available.
                    terminal, terminal_evidence = "normal_return", return_events[0][1]

    if terminal != "unknown" and any(word in terminal_evidence.lower() for word in ("ambiguous", "unresolved")):
        terminal = "unknown"

    return clip(
        f"{origin}; local={local}; {'; '.join(edges) if edges else 'edges=<none>'}; terminal={terminal} evidence={terminal_evidence}",
        1650,
    )


def candidate_record(path: Path, lines: list[str], handler: ast.ExceptHandler, parents, stmt_lists) -> dict[str, Any]:
    try_node = nearest(handler, parents, (ast.Try, getattr(ast, "TryStar", ast.Try)))
    operation = nodes_source(lines, list(getattr(try_node, "body", [])), 850) if try_node else "<unknown>"
    handler_text = nodes_source(lines, list(handler.body), 800)
    downstream = nodes_source(lines, downstream_nodes(try_node, parents, stmt_lists) if try_node else [], 420)
    scope = ".".join(scope_names(handler, parents)) or "<module>"
    start = getattr(handler, "lineno", 0)
    end = getattr(handler, "end_lineno", start)
    record_id = f"{display_path(path)}:{start}-{end}"
    text = (
        f"scope: {scope}\n"
        f"caught: {caught_text(handler)}\n"
        f"operation: {operation}\n"
        f"handler: {handler_text}\n"
        f"downstream: {downstream}"
    )
    return {"id": record_id, "text": clip(text, 2400)}


def discover(scope: str, include_items: bool) -> dict[str, Any]:
    issues: list[dict[str, str]] = []
    items: list[dict[str, Any]] = []
    total = 0
    files = iter_python_files(scope)
    for path in files:
        try:
            _text, lines, tree = parse_file(path)
        except (OSError, UnicodeDecodeError, SyntaxError) as exc:
            issues.append({"source": display_path(path), "message": f"{type(exc).__name__}: {exc}"})
            continue
        parents, stmt_lists = build_maps(tree)
        handlers = [node for node in ast.walk(tree) if isinstance(node, ast.ExceptHandler)]
        handlers.sort(key=lambda node: (getattr(node, "lineno", 0), getattr(node, "end_lineno", 0)))
        total += len(handlers)
        if include_items:
            items.extend(candidate_record(path, lines, handler, parents, stmt_lists) for handler in handlers)
    if issues:
        result = {"status": "error", "scope": scope, "total": total, "issues": issues[:50]}
        if include_items:
            result["items"] = []
        return result
    result: dict[str, Any] = {"status": "ok", "scope": scope, "total": total}
    if include_items:
        result["items"] = items
    return result


def parse_id(value: str) -> tuple[str, int, int] | None:
    try:
        path_part, range_part = value.rsplit(":", 1)
        start_s, end_s = range_part.split("-", 1)
        return path_part.replace("\\", "/"), int(start_s), int(end_s)
    except Exception:
        return None


def call_name(call: ast.Call) -> str | None:
    func = call.func
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return None


def line_window(lines: list[str], lineno: int, radius: int = 1, limit: int = 320) -> str:
    start = max(1, lineno - radius)
    end = min(len(lines), lineno + radius)
    return clip(source_for_lines(lines, start, end), limit)


def evidence(scope: str, ids: list[str], max_items: int, max_sources: int, max_chars: int, detail: str = "standard") -> dict[str, Any]:
    wanted = []
    invalid: list[dict[str, str]] = []
    for value in ids:
        parsed = parse_id(value)
        if parsed is None:
            invalid.append({"message": f"invalid handler id: {value}"})
        else:
            wanted.append((value, *parsed))
    if invalid:
        return {"status": "error", "scope": scope, "requested": len(ids), "packetIds": [], "sourceCount": 0, "chars": 0, "items": [], "issues": invalid[:50]}

    all_files = iter_python_files(scope)
    path_lookup = {display_path(path): path for path in all_files}

    # Apply deterministic item/source bounds before parsing. Evidence parsing touches only
    # target source files; non-target files are read only for lightweight call-site hints.
    bounded_wanted: list[tuple[str, str, int, int]] = []
    bounded_sources: list[str] = []
    bounded_source_set: set[str] = set()
    for record in wanted:
        if len(bounded_wanted) >= max_items:
            break
        _value, path_name, _start, _end = record
        if path_name not in bounded_source_set:
            if len(bounded_sources) >= max_sources:
                break
            bounded_sources.append(path_name)
            bounded_source_set.add(path_name)
        bounded_wanted.append(record)

    for _value, path_name, _start, _end in bounded_wanted:
        if path_name not in path_lookup:
            return {
                "status": "error",
                "scope": scope,
                "requested": len(ids),
                "packetIds": [],
                "sourceCount": 0,
                "chars": 0,
                "items": [],
                "issues": [{"source": path_name, "message": f"source for review target is unavailable: {_value}"}],
            }

    file_cache: dict[str, tuple[Path, list[str], ast.AST, dict[int, ast.AST], dict[int, tuple[list[ast.stmt], int]]]] = {}
    handlers: dict[tuple[str, int, int], ast.ExceptHandler] = {}
    function_for_handler: dict[tuple[str, int, int], ast.AST | None] = {}

    for shown in bounded_sources:
        path = path_lookup[shown]
        try:
            _text, lines, tree = parse_file(path)
        except (OSError, UnicodeDecodeError, SyntaxError) as exc:
            return {
                "status": "error",
                "scope": scope,
                "requested": len(ids),
                "packetIds": [],
                "sourceCount": 0,
                "chars": 0,
                "items": [],
                "issues": [{"source": shown, "message": f"{type(exc).__name__}: {exc}"}],
            }
        parents, stmt_lists = build_maps(tree)
        file_cache[shown] = (path, lines, tree, parents, stmt_lists)
        for node in ast.walk(tree):
            if isinstance(node, ast.ExceptHandler):
                key = (shown, getattr(node, "lineno", 0), getattr(node, "end_lineno", getattr(node, "lineno", 0)))
                handlers[key] = node
                function_for_handler[key] = nearest(node, parents, (ast.FunctionDef, ast.AsyncFunctionDef))

    # Validate bounded IDs before emitting any evidence and collect function names.
    function_names: set[str] = set()
    for value, path_name, start, end in bounded_wanted:
        key = (path_name, start, end)
        if key not in handlers:
            return {
                "status": "error",
                "scope": scope,
                "requested": len(ids),
                "packetIds": [],
                "sourceCount": 0,
                "chars": 0,
                "items": [],
                "issues": [{"source": path_name, "message": f"stale or unresolved review target: {value}"}],
            }
        function_node = function_for_handler.get(key)
        if isinstance(function_node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            function_names.add(function_node.name)

    # Lightweight caller hints: scan source text once without reparsing every file AST.
    call_index: dict[str, list[tuple[str, int, str]]] = {name: [] for name in function_names}
    if function_names:
        patterns = {name: re.compile(rf"\b{re.escape(name)}\s*\(") for name in function_names}
        for path in all_files:
            shown = display_path(path)
            try:
                text = path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError) as exc:
                return {
                    "status": "error",
                    "scope": scope,
                    "requested": len(ids),
                    "packetIds": [],
                    "sourceCount": 0,
                    "chars": 0,
                    "items": [],
                    "issues": [{"source": shown, "message": f"{type(exc).__name__}: {exc}"}],
                }
            lines = text.splitlines(keepends=True)
            for lineno, line in enumerate(lines, 1):
                stripped = line.lstrip()
                if stripped.startswith("def ") or stripped.startswith("async def "):
                    continue
                for name, pattern in patterns.items():
                    if pattern.search(line):
                        call_index[name].append((
                            shown,
                            lineno,
                            line_window(lines, lineno, 2 if detail == "expanded" else 1, 620 if detail == "expanded" else 320),
                        ))

    # Expanded mode builds one bounded AST index for exact value-directed tracing.
    # Standard evidence keeps the cheaper text-only caller scan above.
    function_index: dict[str, list[tuple[str, list[str], ast.AST, dict[int, ast.AST]]]] = {}
    class_index: dict[str, list[tuple[str, list[str], ast.ClassDef, dict[int, ast.AST]]]] = {}
    call_sites: dict[str, list[tuple[str, list[str], ast.Call, dict[int, ast.AST]]]] = {}
    if detail == "expanded":
        for path in all_files:
            shown = display_path(path)
            try:
                _text, project_lines, project_tree = parse_file(path)
            except (OSError, UnicodeDecodeError, SyntaxError) as exc:
                return {
                    "status": "error",
                    "scope": scope,
                    "requested": len(ids),
                    "packetIds": [],
                    "sourceCount": 0,
                    "chars": 0,
                    "items": [],
                    "issues": [{"source": shown, "message": f"{type(exc).__name__}: {exc}"}],
                }
            project_parents, _project_stmt_lists = build_maps(project_tree)
            for node in ast.walk(project_tree):
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    function_index.setdefault(node.name, []).append((shown, project_lines, node, project_parents))
                elif isinstance(node, ast.ClassDef):
                    class_index.setdefault(node.name, []).append((shown, project_lines, node, project_parents))
                elif isinstance(node, ast.Call):
                    name = call_name(node)
                    if name:
                        call_sites.setdefault(name, []).append((shown, project_lines, node, project_parents))

    packet: list[dict[str, str]] = []
    packet_ids: list[str] = []
    sources: set[str] = set()
    chars = 0

    for value, path_name, start, end in bounded_wanted:
        key = (path_name, start, end)
        handler = handlers[key]
        _path, lines, _tree, parents, stmt_lists = file_cache[path_name]
        try_node = nearest(handler, parents, (ast.Try, getattr(ast, "TryStar", ast.Try)))
        scope_node = nearest(handler, parents, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
        function_node = function_for_handler.get(key)
        scope_name = ".".join(scope_names(handler, parents)) or "<module>"
        operation = nodes_source(lines, list(getattr(try_node, "body", [])), 420) if try_node else "<unknown>"
        handler_text = nodes_source(lines, list(handler.body), 420)
        downstream = nodes_source(lines, downstream_nodes(try_node, parents, stmt_lists) if try_node else [], 320)
        returns = function_returns(function_node)
        return_evidence = nodes_source(lines, returns[-2:], 360) if returns else "<none>"
        # Avoid repeating most of the same function body already present in operation/handler/downstream.
        # A compact signature/context line plus caller hints carries the structural context needed for review.
        context = line_window(lines, getattr(scope_node, "lineno", start), 0, 260) if scope_node else line_window(lines, start, 1, 260)
        callers: list[str] = []
        if isinstance(function_node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for caller_path, caller_line, snippet in call_index.get(function_node.name, []):
                if caller_path == path_name and getattr(function_node, "lineno", 0) <= caller_line <= getattr(function_node, "end_lineno", 0):
                    continue
                callers.append(f"{caller_path}:{caller_line}: {clip(snippet, 420 if detail == "expanded" else 170)}")
                if len(callers) >= (4 if detail == "expanded" else 2):
                    break
        expanded_tail = ""
        dataflow = ""
        semantic_hints = ""
        interprocedural = ""
        sentinel_handling = ""
        structured_terminal = ""
        handler_flow = ""
        if detail == "expanded":
            handler_flow = handler_control_flow_evidence(
                lines=lines, handler=handler, try_node=try_node, parents=parents
            )
        if detail == "expanded" and isinstance(function_node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            tail_start = getattr(try_node, "end_lineno", end) + 1 if try_node else end + 1
            tail_end = getattr(function_node, "end_lineno", tail_start)
            tail_text = source_for_lines(lines, tail_start, tail_end)
            expanded_tail = clip(tail_text, 520) if tail_text.strip() else "<none>"
            dataflow = dataflow_evidence(lines, try_node, function_node)
            semantic_hints = expanded_semantic_hints(lines, try_node, function_node)
            sentinel_handling = sentinel_handling_evidence(
                lines=lines,
                path_name=path_name,
                handler=handler,
                try_node=try_node,
                function_node=function_node,
                function_index=function_index,
                call_sites=call_sites,
            )
            structured_terminal = structured_terminal_evidence(
                lines=lines,
                path_name=path_name,
                handler=handler,
                try_node=try_node,
                function_node=function_node,
                parents=parents,
                function_index=function_index,
                class_index=class_index,
                call_sites=call_sites,
            )
            interprocedural = interprocedural_evidence(
                lines=lines,
                path_name=path_name,
                handler=handler,
                try_node=try_node,
                function_node=function_node,
                parents=parents,
                function_index=function_index,
                class_index=class_index,
                call_sites=call_sites,
            )
        evidence_text = (
            f"id: {value}\n"
            f"scope: {scope_name}\n"
            f"caught: {caught_text(handler)}\n"
            f"operation: {operation}\n"
            f"handler: {handler_text}\n"
            f"downstream: {downstream}\n"
            f"function_returns: {return_evidence}\n"
            f"context: {context}\n"
            f"callers: {' | '.join(callers) if callers else '<none found>'}"
            + (
                f"\ndataflow: {dataflow}\nsemantic_hints: {semantic_hints}\nsentinel_handling: {sentinel_handling}\nstructured_terminal_flow: {structured_terminal}\ninterprocedural_flow: {interprocedural}\nhandler_control_flow: {handler_flow}\nexpanded_function_tail: {expanded_tail}"
                if detail == "expanded" else ""
            )
        )
        evidence_text = clip(evidence_text, 3600 if detail == "expanded" else 2100)
        projected = chars + len(evidence_text)
        if packet and projected > max_chars:
            break
        if not packet and len(evidence_text) > max_chars:
            evidence_text = clip(evidence_text, max_chars)
            projected = len(evidence_text)
        packet.append({"id": value, "source": path_name, "evidence": evidence_text})
        packet_ids.append(value)
        sources.add(path_name)
        chars = projected

    return {
        "status": "ok",
        "scope": scope,
        "requested": len(ids),
        "packetIds": packet_ids,
        "sourceCount": len(sources),
        "chars": chars,
        "items": packet,
    }


def main() -> None:
    request = json.load(sys.stdin)
    action = request.get("action")
    scope = str(request.get("scope") or ".")
    if action == "count":
        result = discover(scope, False)
    elif action == "discover":
        result = discover(scope, True)
    elif action == "evidence":
        result = evidence(
            scope,
            [str(value) for value in request.get("ids") or []],
            max(1, min(int(request.get("maxItems") or 80), 500)),
            max(1, min(int(request.get("maxSources") or 10), 100)),
            max(1000, min(int(request.get("maxChars") or 40000), 250000)),
            "expanded" if request.get("detail") == "expanded" else "standard",
        )
    else:
        result = {"status": "error", "scope": scope, "total": 0, "issues": [{"message": f"unknown action: {action}"}]}
    json.dump(result, sys.stdout, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    main()
