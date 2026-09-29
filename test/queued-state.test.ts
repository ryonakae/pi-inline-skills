import { expect, test } from "bun:test"
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai"
import { bodyCount, gate, setup, text, waitFor } from "./harness.ts"

test("steering consumes before an earlier follow-up without reserving the skill", async () => {
  const hold = gate()
  const h = await setup({
    responses: [
      async () => {
        await hold.promise
        return fauxAssistantMessage("initial")
      },
      fauxAssistantMessage("steer"),
      fauxAssistantMessage("follow-up"),
    ],
  })
  try {
    const run = h.session.prompt("initial")
    await waitFor(() => h.calls.length === 1)
    await h.session.prompt("/alpha later", { streamingBehavior: "followUp" })
    await h.session.prompt("/alpha now", { streamingBehavior: "steer" })
    hold.release()
    await run
    expect(h.calls[1]!.messages.map(text)).toContain("/alpha now")
    expect(h.calls[1]!.messages.map(text)).not.toContain("/alpha later")
    expect(bodyCount(h.calls[1]!, "alpha")).toBe(1)
    expect(h.calls[2]!.messages.map(text)).toContain("/alpha later")
    expect(bodyCount(h.calls[2]!, "alpha")).toBe(1)
    expect(h.entries()).toHaveLength(1)
  } finally {
    hold.release()
    h.session.dispose()
  }
})

test("provider retry reuses the batch decision and delivers a queued body once per request and once in history", async () => {
  const hold = gate()
  const h = await setup({
    jev: true,
    settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } },
    responses: [
      async () => {
        await hold.promise
        return fauxAssistantMessage("initial")
      },
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "rate limit exceeded",
      }),
      fauxAssistantMessage("recovered"),
    ],
  })
  try {
    const run = h.session.prompt("initial")
    await waitFor(() => h.calls.length === 1)
    await h.session.prompt("/alpha retry", { streamingBehavior: "steer" })
    hold.release()
    await run
    expect(h.calls).toHaveLength(3)
    expect(h.payloads.map((payload) => payload.state.currentInput)).toEqual([
      "initial",
      "/alpha retry",
    ])
    for (const request of h.calls.slice(1)) {
      expect(bodyCount(request, "alpha")).toBe(1)
      expect(request.messages.map(text).join("\n")).toContain(
        "<skill_read_instructions>",
      )
    }
    expect(h.entries()).toHaveLength(1)
    expect(h.displayed).toHaveLength(1)
  } finally {
    hold.release()
    h.session.dispose()
  }
})

test.each(["error", "abort", "tool-error"] as const)(
  "queued body survives %s without duplicate persistence on the next input",
  async (outcome) => {
    const hold = gate()
    const queued = gate()
    const h = await setup({
      tools: true,
      responses: [
        async () => {
          await hold.promise
          return fauxAssistantMessage("initial")
        },
        async () => {
          if (outcome === "abort") {
            await queued.promise
            return fauxAssistantMessage("late")
          }
          if (outcome === "tool-error")
            return fauxAssistantMessage(
              fauxToolCall("read", { path: "/does-not-exist/SKILL.md" }),
              { stopReason: "toolUse" },
            )
          return fauxAssistantMessage("", {
            stopReason: "error",
            errorMessage: "EXPECTED_FAILURE",
          })
        },
        fauxAssistantMessage("handled"),
        fauxAssistantMessage("next"),
      ],
    })
    try {
      const run = h.session.prompt("initial")
      await waitFor(() => h.calls.length === 1)
      await h.session.prompt("/alpha consumed", { streamingBehavior: "steer" })
      hold.release()
      await waitFor(() => h.calls.length >= 2)
      if (outcome === "abort") {
        const aborting = h.session.abort()
        queued.release()
        await aborting
      }
      await run
      expect(h.entries()).toHaveLength(1)
      await h.session.prompt("/beta next")
      expect(bodyCount(h.calls.at(-1)!, "alpha")).toBe(1)
      expect(bodyCount(h.calls.at(-1)!, "beta")).toBe(1)
      expect(h.entries()).toHaveLength(2)
    } finally {
      hold.release()
      queued.release()
      h.session.dispose()
    }
  },
)

test.each([false, true, "unknown"] as const)(
  "off/child/unknown preserve manual loading without HTTP: %s",
  async (child) => {
    const h = await setup({
      jev: child !== false,
      child,
      responses: [fauxAssistantMessage("done")],
    })
    try {
      await h.session.prompt("/alpha explicit")
      expect(h.payloads).toHaveLength(0)
      expect(bodyCount(h.calls[0]!, "alpha")).toBe(1)
    } finally {
      h.session.dispose()
    }
  },
)

test("Jev failures omit only the recommendation, including on retry", async () => {
  const h = await setup({
    jev: true,
    fetch: async () => new Response("SECRET_SERVER_BODY", { status: 503 }),
    settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } },
    responses: [
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "rate limit exceeded",
      }),
      fauxAssistantMessage("done"),
    ],
  })
  try {
    await h.session.prompt("/alpha explicit")
    expect(h.payloads).toHaveLength(1)
    for (const request of h.calls) {
      expect(bodyCount(request, "alpha")).toBe(1)
      expect(request.messages.map(text).join("\n")).not.toContain(
        "<skill_read_instructions>",
      )
      expect(request.messages.map(text).join("\n")).not.toContain(
        "SECRET_SERVER_BODY",
      )
    }
  } finally {
    h.session.dispose()
  }
})
