import { expect, test } from "bun:test"
import { rmSync, writeFileSync } from "node:fs"
import { fauxAssistantMessage } from "@earendil-works/pi-ai"
import { bodyCount, gate, setup, text, waitFor } from "./harness.ts"

test("normal manual input is saved and displayed before the model responds", async () => {
  const hold = gate()
  const h = await setup({
    responses: [
      async () => {
        await hold.promise
        return fauxAssistantMessage("done")
      },
    ],
  })
  try {
    const run = h.session.prompt("/alpha normal")
    await waitFor(() => h.calls.length === 1)
    expect(bodyCount(h.calls[0]!, "alpha")).toBe(1)
    expect(h.entries()).toHaveLength(1)
    expect(h.displayed).toHaveLength(1)
    hold.release()
    await run
  } finally {
    hold.release()
    h.session.dispose()
  }
})

test("manual exclusions remain loadable, and unreadable explicit skills do not block the request", async () => {
  const h = await setup({
    jev: true,
    responses: [fauxAssistantMessage("done")],
  })
  rmSync(h.skillPaths["alpha"]!)
  try {
    await h.session.prompt("/plan /alpha explicit")
    expect(bodyCount(h.calls[0]!, "plan")).toBe(1)
    expect(bodyCount(h.calls[0]!, "alpha")).toBe(0)
    expect(JSON.stringify(h.payloads[0]!.questions)).not.toContain('\\"plan\\"')
  } finally {
    h.session.dispose()
  }
})

test("consecutive one-at-a-time users get only their consumed manual skills", async () => {
  const hold = gate()
  const h = await setup({
    settings: { steeringMode: "one-at-a-time" },
    responses: [
      async () => {
        await hold.promise
        return fauxAssistantMessage("initial")
      },
      fauxAssistantMessage("alpha"),
      fauxAssistantMessage("beta"),
    ],
  })
  try {
    const run = h.session.prompt("initial")
    await waitFor(() => h.calls.length === 1)
    await h.session.prompt("/alpha first", { streamingBehavior: "steer" })
    await h.session.prompt("/beta second", { streamingBehavior: "steer" })
    hold.release()
    await run
    expect(bodyCount(h.calls[1]!, "alpha")).toBe(1)
    expect(bodyCount(h.calls[1]!, "beta")).toBe(0)
    expect(bodyCount(h.calls[2]!, "alpha")).toBe(1)
    expect(bodyCount(h.calls[2]!, "beta")).toBe(1)
    expect(h.entries()).toHaveLength(2)
  } finally {
    hold.release()
    h.session.dispose()
  }
})

test("all-at-once queued users receive both bodies before the response, with display and persistence at turn end", async () => {
  const hold = gate()
  const queued = gate()
  const h = await setup({
    settings: { steeringMode: "all" },
    responses: [
      async () => {
        await hold.promise
        return fauxAssistantMessage("initial")
      },
      async () => {
        await queued.promise
        return fauxAssistantMessage("queued")
      },
    ],
  })
  try {
    const run = h.session.prompt("initial")
    await waitFor(() => h.calls.length === 1)
    await h.session.prompt("/alpha first", { streamingBehavior: "steer" })
    await h.session.prompt("/beta second", { streamingBehavior: "steer" })
    hold.release()
    await waitFor(() => h.calls.length === 2)
    expect(bodyCount(h.calls[1]!, "alpha")).toBe(1)
    expect(bodyCount(h.calls[1]!, "beta")).toBe(1)
    expect(h.displayed).toHaveLength(0)
    expect(h.entries()).toHaveLength(0)
    queued.release()
    await run
    expect(h.displayed).toHaveLength(1)
    expect(h.entries()).toHaveLength(1)
  } finally {
    hold.release()
    queued.release()
    h.session.dispose()
  }
})

test("a retry uses exactly the queued body scheduled for persistence even if its source file changes", async () => {
  const hold = gate()
  let path = ""
  const h = await setup({
    settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } },
    responses: [
      async () => {
        await hold.promise
        return fauxAssistantMessage("initial")
      },
      () => {
        writeFileSync(path, "CHANGED_SKILL_BODY")
        return fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "rate limit exceeded",
        })
      },
      fauxAssistantMessage("recovered"),
    ],
  })
  path = h.skillPaths["alpha"]!
  try {
    const run = h.session.prompt("initial")
    await waitFor(() => h.calls.length === 1)
    await h.session.prompt("/alpha retry", { streamingBehavior: "steer" })
    hold.release()
    await run
    expect(bodyCount(h.calls[1]!, "alpha")).toBe(1)
    expect(bodyCount(h.calls[2]!, "alpha")).toBe(1)
    expect(h.calls[2]!.messages.map(text).join("\n")).not.toContain(
      "CHANGED_SKILL_BODY",
    )
    expect(h.entries()).toHaveLength(1)
    expect(JSON.stringify(h.entries())).toContain("ALPHA_SKILL_BODY")
  } finally {
    hold.release()
    h.session.dispose()
  }
})
