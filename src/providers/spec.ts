import type { GenericSourceProviderConfig } from "./generic-source.ts";

export type EvidenceProviderSpec =
  | { kind: "builtin"; id: string }
  | { kind: "generic-source"; config: GenericSourceProviderConfig };
