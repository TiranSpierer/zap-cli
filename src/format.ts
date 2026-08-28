import { stringify } from "yaml";

export function toYaml(value: unknown): string {
  return stringify(value, { indent: 2, lineWidth: 0 }).trimEnd();
}

