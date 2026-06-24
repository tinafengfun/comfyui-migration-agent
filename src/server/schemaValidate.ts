/**
 * Runtime validator for the three migration-agent schemas (§F).
 *
 * Why this module exists:
 *   - §A wrote JSON Schema files (skill-frontmatter / recipe / feedback-event).
 *   - Without a runtime check, those files are just documentation. Any agent
 *     code path that writes a feedback event or loads a recipe can drift from
 *     the schema and the bug only surfaces weeks later.
 *   - This module is the "L1 runtime gate" called out in design doc §6.1:
 *     invalid documents must be rejected before they enter the system.
 *
 * Design choices:
 *   - Lazy init: schemas compile on first use, not at import time. Keeps
 *     server startup fast and lets unit tests stub schema files.
 *   - Files read once and cached. Call `resetSchemaCache()` in tests.
 *   - `validate()` returns a discriminated union — never throws on validation
 *     failure. Callers decide: hard-fail (write path) vs soft-warn (read path).
 *   - Missing schema file => error result, not throw. The runtime gate still
 *     trips, which is correct: if the schema isn't there, we can't claim the
 *     data is valid.
 */
import { Ajv2020 as Ajv } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { AnySchema, ErrorObject, ValidateFunction } from "ajv";
import { readFileSync } from "node:fs";
import { SCHEMA_FILES } from "./paths";

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export type SchemaKind = "skillFrontmatter" | "recipe" | "feedbackEvent";

export interface ValidationOk {
  ok: true;
  /** Ajv can mutate the input via defaults; this is the post-validation value. */
  value: unknown;
}

export interface ValidationErr {
  ok: false;
  /** Short human-readable summary of the first error. */
  message: string;
  /** All errors, in Ajv's `{path, message, schemaPath}` shape. */
  errors: Array<{ path: string; message: string }>;
  /** Name of the schema that was applied. */
  schema: SchemaKind;
}

export type ValidationResult = ValidationOk | ValidationErr;

// ─────────────────────────────────────────────────────────────────────────────
// Ajv setup (lazy)
// ─────────────────────────────────────────────────────────────────────────────

let ajv: Ajv | null = null;
const compiledValidator: Partial<Record<SchemaKind, ValidateFunction>> = {};
let initError: string | null = null;

function getAjv(): Ajv {
  if (ajv) return ajv;
  ajv = new Ajv({
    allErrors: true,
    strict: true,
    // Don't mutate inputs by default — callers should opt in via `useDefaults`.
    useDefaults: false
  });
  addFormats(ajv);
  return ajv;
}

function loadSchema(kind: SchemaKind): ValidateFunction {
  const cached = compiledValidator[kind];
  if (cached) return cached;

  const file = SCHEMA_FILES[kind];
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    const msg = `schemaValidate: cannot read ${file}: ${(e as Error).message}`;
    initError = msg;
    throw new Error(msg);
  }

  let schema: AnySchema;
  try {
    schema = JSON.parse(raw) as AnySchema;
  } catch (e) {
    const msg = `schemaValidate: ${file} is not valid JSON: ${(e as Error).message}`;
    initError = msg;
    throw new Error(msg);
  }

  const validate = getAjv().compile<AnySchema>(schema);
  compiledValidator[kind] = validate;
  return validate;
}

/** Test-only: force re-read of schema files on next validate(). */
export function resetSchemaCache(): void {
  ajv = null;
  (Object.keys(compiledValidator) as Array<keyof typeof compiledValidator>).forEach(
    (k) => delete compiledValidator[k]
  );
  initError = null;
}

/** Test-only: peek at the most recent init error without re-running. */
export function getLastInitError(): string | null {
  return initError;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate a value against one of the migration-agent schemas.
 * Returns `{ok: true}` or `{ok: false, errors: [...]}`.
 * Never throws for invalid data; only throws if the schema file itself is
 * missing or corrupt (a deployment-time problem worth crashing on).
 */
export function validate(kind: SchemaKind, value: unknown): ValidationResult {
  const fn = loadSchema(kind);
  const ok = fn(value);
  if (ok) return { ok: true, value };

  const errs = (fn.errors ?? []) as ErrorObject[];
  return {
    ok: false,
    schema: kind,
    message: errs[0]
      ? `${errs[0].instancePath || "(root)"}: ${errs[0].message}`
      : "validation failed",
    errors: errs.map((e) => ({
      path: e.instancePath || "(root)",
      message: e.message ?? "invalid"
    }))
  };
}

/** Convenience predicates. */
export const validateSkillFrontmatter = (v: unknown): ValidationResult =>
  validate("skillFrontmatter", v);
export const validateRecipe = (v: unknown): ValidationResult => validate("recipe", v);
export const validateFeedbackEvent = (v: unknown): ValidationResult =>
  validate("feedbackEvent", v);

/**
 * Assert form: throws on invalid input. Use on write paths where invalid
 * data must halt the operation (e.g. before appending to feedback-events.jsonl).
 */
export function assertValid(kind: SchemaKind, value: unknown): void {
  const r = validate(kind, value);
  if (!r.ok) {
    const lines = r.errors.map((e) => `  - ${e.path}: ${e.message}`).join("\n");
    throw new Error(
      `schemaValidate(${r.schema}): invalid ${kind} document:\n${lines}`
    );
  }
}

/**
 * Format a ValidationResult as a single human-readable string.
 * Useful for surfacing in agent logs or ask_user prompts.
 */
export function formatResult(r: ValidationResult): string {
  if (r.ok) return "OK";
  return `[${r.schema}] ${r.message}\n` + r.errors.map((e) => `  - ${e.path}: ${e.message}`).join("\n");
}
