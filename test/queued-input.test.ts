import { expect, test } from "bun:test"
import { fauxAssistantMessage } from "@earendil-works/pi-ai"
import { bodyCount, gate, setup, text, waitFor } from "./harness.ts"

test.each(["steer", "followUp"] as const)(
  "queued %s selects only when consumed and receives read instructions, not bodies",
  async (streamingBehavior) => {
    const hold = gate()
    const h = await setup({
      jev: true,
      responses: [
        async () => {
          await hold.promise
          return fauxAssistantMessage("initial")
        },
        fauxAssistantMessage("queued"),
      ],
    })
    try {
      const run = h.session.prompt("initial")
      await waitFor(() => h.calls.length === 1)
      await h.session.prompt("/alpha investigate", { streamingBehavior })
      expect(h.payloads).toHaveLength(1)
      hold.release()
      await run
      expect(h.payloads).toHaveLength(2)
      expect(h.payloads[1]!.state.currentInput).toBe("/alpha investigate")
      expect(bodyCount(h.calls[1]!, "alpha")).toBe(1)
      expect(bodyCount(h.calls[1]!, "beta")).toBe(0)
      expect(h.calls[1]!.messages.map(text).join("\n")).toContain(
        "<skill_read_instructions>",
      )
      expect(h.entries()).toHaveLength(1)
    } finally {
      hold.release()
      h.session.dispose()
    }
  },
)

test.each(["steer", "followUp"] as const)(
  "cleared %s inputs neither load skills nor call Jev",
  async (streamingBehavior) => {
    const hold = gate()
    const h = await setup({
      jev: true,
      responses: [
        async () => {
          await hold.promise
          return fauxAssistantMessage("initial")
        },
        fauxAssistantMessage("next"),
      ],
    })
    try {
      const run = h.session.prompt("initial")
      await waitFor(() => h.calls.length === 1)
      await h.session.prompt("/alpha abandoned", { streamingBehavior })
      h.session.clearQueue()
      hold.release()
      await run
      await h.session.prompt("unrelated")
      expect(h.payloads.map((payload) => payload.state.currentInput)).toEqual([
        "initial",
        "unrelated",
      ])
      expect(bodyCount(h.calls[1]!, "alpha")).toBe(0)
      expect(h.entries()).toHaveLength(0)
    } finally {
      hold.release()
      h.session.dispose()
    }
  },
)
