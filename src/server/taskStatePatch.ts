/**
 * Safe read-modify-write for a per-task `artifacts/task-state.json` ledger.
 *
 * Every per-step migration SDK session is instructed (see agent.md's Common
 * Migration Contract) to freehand-maintain this file itself -- there is no
 * deterministic backend write path for it. A real run corrupted the file:
 * Step 13's completion entry landed as a bare, keyless object OUTSIDE the
 * `steps` array (right after its closing `],`), followed by an orphaned extra
 * `]` -- because completing the terminal step requires touching both the
 * array's last element AND top-level fields that live after it, in one edit,
 * which is a structurally riskier shape than steps 00-12's simple in-place
 * object replace. This module gives the agent (via scripts/patch-task-state.mts)
 * a single call that always produces valid JSON instead of a raw text splice.
 */

export interface RepairResult {
  state: Record<string, unknown>;
  repaired: boolean;
}

/**
 * Detects and fixes exactly one confirmed corruption shape: the `"steps"`
 * array closes early (`],`), followed immediately by one or more bare
 * `{ ... }` objects that belong inside that array, each followed by an
 * orphaned extra `]`. Splices each dangling object back into the array and
 * drops the orphaned bracket(s).
 *
 * Deliberately narrow: if the text doesn't match this exact shape, returns it
 * unchanged rather than guessing further (matching the existing narrow repair
 * in phase1Agent.ts for its own, different corruption class).
 */
export function repairDanglingStepObjects(rawText: string): string {
  const arrayCloseIndex = rawText.indexOf('"steps"');
  if (arrayCloseIndex === -1) return rawText;

  // Find the first `],` that appears after `"steps"` and is immediately
  // followed (modulo whitespace) by a `{` -- the signature of a step object
  // dropped outside the array.
  const danglingPattern = /\],(\s*)\{/g;
  danglingPattern.lastIndex = arrayCloseIndex;
  const match = danglingPattern.exec(rawText);
  if (!match) return rawText;

  const spliceAt = match.index; // position of the `]`
  const before = rawText.slice(0, spliceAt);
  let rest = rawText.slice(spliceAt + 1); // drop the `]`, keep the `,` + dangling object(s) onward

  // rest now starts with `,\s*{ dangling object }` possibly followed by more
  // dangling objects and/or an orphaned `]`. Extract balanced-brace objects
  // one at a time until we hit something that isn't `,{...}`.
  const danglingObjects: string[] = [];
  let cursor = 0;
  while (true) {
    const commaMatch = /^\s*,\s*/.exec(rest.slice(cursor));
    if (!commaMatch) break;
    const objStart = cursor + commaMatch[0].length;
    if (rest[objStart] !== "{") break;
    const objEnd = findMatchingBrace(rest, objStart);
    if (objEnd === -1) break;
    danglingObjects.push(rest.slice(objStart, objEnd + 1));
    cursor = objEnd + 1;
  }
  if (danglingObjects.length === 0) return rawText;

  // Whatever remains after the dangling objects should start with an orphaned
  // `]` (the one that was meant to close `steps` before the corruption
  // duplicated it) -- drop exactly one.
  let remainder = rest.slice(cursor);
  const orphanedBracket = /^\s*\]/.exec(remainder);
  if (orphanedBracket) {
    remainder = remainder.slice(orphanedBracket[0].length);
  }

  const repairedText = `${before},${danglingObjects.join(",")}]${remainder}`;
  return repairedText;
}

function findMatchingBrace(text: string, openIndex: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Parses task-state.json text, auto-repairing the one confirmed corruption
 * shape if the direct parse fails. Rethrows the original SyntaxError
 * unchanged if the text doesn't match that shape or still fails after repair
 * -- never silently fabricates a fallback.
 */
export function parseTaskStateWithRepair(rawText: string): RepairResult {
  try {
    return { state: JSON.parse(rawText), repaired: false };
  } catch (originalError) {
    const repairedText = repairDanglingStepObjects(rawText);
    if (repairedText === rawText) throw originalError;
    try {
      return { state: JSON.parse(repairedText), repaired: true };
    } catch {
      throw originalError;
    }
  }
}

/**
 * Applies a step's completion entry (matched by `step` or `stepId`, tolerating
 * the schema drift already observed across steps 00-12) into `state.steps`,
 * replacing an existing entry in place or pushing a new one -- never touching
 * anything outside the array. Optionally shallow-merges top-level field
 * updates (e.g. overall status, current_step_id) onto the root object in the
 * same safe call, which is what eliminates the edit shape that caused the
 * original corruption (touching the array's last element and trailing
 * top-level fields together).
 */
export function applyStepPatch(
  state: Record<string, unknown>,
  stepPatch: Record<string, unknown> & { step?: string; stepId?: string },
  topLevelPatch?: Record<string, unknown>
): Record<string, unknown> {
  const stepId = stepPatch.step ?? stepPatch.stepId;
  if (!stepId) throw new Error("applyStepPatch: stepPatch must include a 'step' or 'stepId' field");

  const existingSteps = Array.isArray(state.steps) ? (state.steps as Record<string, unknown>[]) : [];
  const index = existingSteps.findIndex((entry) => entry.step === stepId || entry.stepId === stepId);
  const nextSteps = [...existingSteps];
  if (index >= 0) nextSteps[index] = stepPatch;
  else nextSteps.push(stepPatch);

  return {
    ...state,
    ...(topLevelPatch ?? {}),
    steps: nextSteps
  };
}
