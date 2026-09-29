import { afterEach, expect, test } from "bun:test"
import { captureChildContext } from "../src/child-context.ts"

const symbol = Symbol.for("pi-subagents:child-context")
const original = (globalThis as Record<PropertyKey, unknown>)[symbol]

afterEach(() => {
  if (original === undefined) {
    delete (globalThis as Record<PropertyKey, unknown>)[symbol]
  } else {
    ;(globalThis as Record<PropertyKey, unknown>)[symbol] = original
  }
})

test("missing and incompatible child context contracts fail closed", () => {
  delete (globalThis as Record<PropertyKey, unknown>)[symbol]
  expect(captureChildContext()).toEqual({ supported: false, reason: "missing" })

  ;(globalThis as Record<PropertyKey, unknown>)[symbol] = Object.freeze({
    version: 2,
    isChildSession: () => false,
  })
  expect(captureChildContext()).toEqual({ supported: false, reason: "version" })
})

test.each([
  [false, { supported: true, isChildSession: false }],
  [true, { supported: true, isChildSession: true }],
] as const)(
  "captures main and child state during initialization",
  (child, expected) => {
    ;(globalThis as Record<PropertyKey, unknown>)[symbol] = Object.freeze({
      version: 1,
      isChildSession: () => child,
    })
    expect(captureChildContext()).toEqual(expected)
  },
)
