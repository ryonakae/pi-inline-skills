const CHILD_CONTEXT_SYMBOL = Symbol.for("pi-subagents:child-context")

export type ChildContextStatus =
  | { supported: true; isChildSession: boolean }
  | { supported: false; reason: "missing" | "version" }

type ChildContextAccessor = {
  version: 1
  isChildSession(): boolean
}

function isAccessor(value: unknown): value is ChildContextAccessor {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Partial<ChildContextAccessor>
  return (
    candidate.version === 1 && typeof candidate.isChildSession === "function"
  )
}

export function captureChildContext(): ChildContextStatus {
  const accessor = (globalThis as Record<PropertyKey, unknown>)[
    CHILD_CONTEXT_SYMBOL
  ]
  if (accessor === undefined) return { supported: false, reason: "missing" }
  if (!isAccessor(accessor)) return { supported: false, reason: "version" }
  return { supported: true, isChildSession: accessor.isChildSession() }
}
