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
    return None


def assigned_keys(nodes: list[ast.AST]) -> set[str]:
    keys: set[str] = set()
    mutators = {"append", "extend", "update", "add", "discard", "remove", "pop", "clear", "setdefault"}

    def add_target(target: ast.AST) -> None:
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
        if detail == "expanded" and isinstance(function_node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            tail_start = getattr(try_node, "end_lineno", end) + 1 if try_node else end + 1
            tail_end = getattr(function_node, "end_lineno", tail_start)
            tail_text = source_for_lines(lines, tail_start, tail_end)
            expanded_tail = clip(tail_text, 520) if tail_text.strip() else "<none>"
            dataflow = dataflow_evidence(lines, try_node, function_node)
            semantic_hints = expanded_semantic_hints(lines, try_node, function_node)
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
                f"\ndataflow: {dataflow}\nsemantic_hints: {semantic_hints}\nexpanded_function_tail: {expanded_tail}"
                if detail == "expanded" else ""
            )
        )
        evidence_text = clip(evidence_text, 3200 if detail == "expanded" else 2100)
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
