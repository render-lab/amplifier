// Readers for values that came out of somebody else's JSON, where a field can
// be absent, null, or the wrong type.

/**
 * A value when it is a non-empty string, else undefined.
 *
 * An empty string reads as absent. Typefully and Slack both send "" for a field
 * they have no value for, and every caller here treats that the same as a
 * missing field.
 */
export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * A value when it is a JSON object, else undefined.
 *
 * `typeof null` is "object", so the null check is what makes this a guard
 * rather than a cast. Callers index the result by string key, which is how
 * Slack's and Typefully's nested payloads are read without a type per shape.
 */
export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The `id` on a nested object, such as a payload's `channel` or a reply's
 * `user`. Undefined when the field is absent or carries no id.
 */
export function nestedId(parent: unknown, field: string): string | undefined {
  return nonEmptyString(record(record(parent)?.[field])?.["id"]);
}
