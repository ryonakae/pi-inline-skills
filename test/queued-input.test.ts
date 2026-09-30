import { expect, test } from "bun:test"
import { fauxAssistantMessage } from "@earendil-works/pi-ai"
import { bodyCount, gate, setup, waitFor } from "./harness.ts"

test.each(["steer", "followUp"] as const)(
  "queued %s selects only when consumed and receives the automatic body",
  async (streamingBehavior) => {
    const hold = gate()
    let settlements = 0
    const h = await setup({
      jev: true,
      fetch: async (payload) => {
        const selected =
          payload.state.currentInput === "initial" ? "alpha" : "beta"
        return Response.json({
          answers: Object.fromEntries(
            Object.entries(payload.questions).map(([key, question]) => [
              key,
              {
                type: "noul",
                noul: question.instructions.includes(`"${selected}"`)
                  ? 0.99
                  : 0.1,
              },
            ]),
          ),
        })
      },
      extensions: [
        (pi) => {
          pi.on("agent_settled", () => {
            settlements++
          })
        },
      ],
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
      await h.session.prompt("/plan investigate", { streamingBehavior })
      expect(h.payloads).toHaveLength(1)
      expect(bodyCount(h.calls[0]!, "beta")).toBe(0)
      hold.release()
      await run
      expect(h.payloads).toHaveLength(2)
      expect(h.payloads[1]!.state.currentInput).toBe("/plan investigate")
      expect(bodyCount(h.calls[1]!, "alpha")).toBe(1)
      expect(bodyCount(h.calls[1]!, "beta")).toBe(1)
      expect(bodyCount(h.calls[1]!, "plan")).toBe(1)
      expect(h.entries()).toHaveLength(3)
      expect(h.entries().map((entry) => entry.display)).toEqual([
        false,
        true,
        false,
      ])
      expect(h.notifications).toEqual([
        "Skill automatically loaded by Jev: alpha",
        ["Skill loaded: plan", "Skill automatically loaded by Jev: beta"].join(
          "\n",
        ),
      ])
      expect(settlements).toBe(1)
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
      expect(h.entries()).toHaveLength(1)
      expect(h.entries()[0]!.details).toMatchObject({
        names: ["beta"],
        source: "jev",
      })
    } finally {
      hold.release()
      h.session.dispose()
    }
  },
)
