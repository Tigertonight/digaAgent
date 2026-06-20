export interface UiShapeViolation {
  surface: string;
  fieldPath: string;
  expected: string;
  receivedType: string;
  sourceEventType?: string;
  agentId?: string;
  sessionId?: string;
  createdAt: number;
}

export interface RecordUiShapeViolationInput {
  surface: string;
  fieldPath: string;
  expected: string;
  received: unknown;
  sourceEventType?: string;
  agentId?: string;
  sessionId?: string;
}

const seen = new Map<string, number>();
const DEDUPE_MS = 30_000;

function receivedType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

export function recordUiShapeViolation(
  input: RecordUiShapeViolationInput
): UiShapeViolation | null {
  const now = Date.now();
  const key = `${input.surface}:${input.fieldPath}:${input.sourceEventType ?? ""}`;
  const last = seen.get(key) ?? 0;
  if (now - last < DEDUPE_MS) return null;
  seen.set(key, now);
  const violation: UiShapeViolation = {
    surface: input.surface,
    fieldPath: input.fieldPath,
    expected: input.expected,
    receivedType: receivedType(input.received),
    sourceEventType: input.sourceEventType,
    agentId: input.agentId,
    sessionId: input.sessionId,
    createdAt: now,
  };
  if (
    typeof console !== "undefined" &&
    typeof console.warn === "function" &&
    typeof process !== "undefined" &&
    process.env.NODE_ENV !== "production"
  ) {
    console.warn("[ui-shape] normalized malformed UI payload", violation);
  }
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(
      new CustomEvent("diga:ui_shape_violation", { detail: violation })
    );
  }
  return violation;
}

export function resetUiShapeDiagnosticsForTests(): void {
  seen.clear();
}
