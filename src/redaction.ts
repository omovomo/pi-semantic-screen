import type { RedactionResult } from "./engine.ts";

type Rule = {
  pattern: RegExp;
  replace: string | ((...args: unknown[]) => string);
};

const CREDENTIAL_NAME =
  String.raw`(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|client[_-]?secret|credential)`;

const RULES: Rule[] = [
  {
    pattern: /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/g,
    replace: "[REDACTED_PRIVATE_KEY]",
  },
  {
    pattern: /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}={0,2}/gi,
    replace: "Bearer [REDACTED]",
  },
  {
    pattern: /\b(?:sk-ant-|sk-|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_\-.]{12,}\b/g,
    replace: "[REDACTED_TOKEN]",
  },
  {
    pattern: /\bAKIA[A-Z0-9]{16}\b/g,
    replace: "[REDACTED_AWS_ACCESS_KEY]",
  },
  {
    pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g,
    replace: "[REDACTED_API_KEY]",
  },
  {
    pattern: new RegExp(`\\b(${CREDENTIAL_NAME})\\b(\\s*[:=]\\s*)(["'])([^"'\\r\\n]{6,})\\3`, "gi"),
    replace: (...args: unknown[]) => `${String(args[1])}${String(args[2])}${String(args[3])}[REDACTED]${String(args[3])}`,
  },
  {
    pattern: new RegExp(`\\b(${CREDENTIAL_NAME})\\b(\\s*[:=]\\s*)([^\\s,;]{8,})`, "gi"),
    replace: (...args: unknown[]) => `${String(args[1])}${String(args[2])}[REDACTED]`,
  },
];

export function redactSecrets(input: string): RedactionResult {
  let text = input;
  let count = 0;

  for (const rule of RULES) {
    text = text.replace(rule.pattern, (...args: unknown[]) => {
      count += 1;
      if (typeof rule.replace === "string") return rule.replace;
      return rule.replace(...args);
    });
  }

  return { text, count };
}
