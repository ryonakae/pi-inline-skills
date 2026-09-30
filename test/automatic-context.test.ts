import { expect, test } from "bun:test"
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai"
import { restoreLoadedSkillNames } from "../src/loaded-skills.ts"
import { bodyCount, gate, setup, text, waitFor } from "./harness.ts"

test("Jev recommends a standard read without loading its body; successful read removes the instruction", async () => {
  let path = ""
  const h = await setup({
    jev: true,
    tools: true,
    responses: [
      () =>
        fauxAssistantMessage(fauxToolCall("read", { path }), {
          stopReason: "toolUse",
        }),
      fauxAssistantMessage("done"),
    ],
  })
  path = h.skillPaths["beta"]!
  try {
    await h.session.prompt("/alpha investigate")
    expect(h.payloads).toHaveLength(1)
    expect(h.authProviders).toEqual([])
    expect(h.requests[0]!.url).toBe("https://api.typesafe.ai/v1/systemone")
    expect(h.requests[0]!.init?.headers).toEqual({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    })
    expect(bodyCount(h.calls[0]!, "alpha")).toBe(1)
    expect(bodyCount(h.calls[0]!, "beta")).toBe(0)
    expect(h.calls[0]!.messages.map(text).join("\n")).toContain(`read`)
    expect(
      h.calls[0]!.messages.map(text).some(
        (value) =>
          value.includes("<skill_read_instructions>") && value.includes(path),
      ),
    ).toBe(true)
    expect(h.calls[1]!.messages.map(text).join("\n")).not.toContain(
      "<skill_read_instructions>",
    )
    expect(bodyCount(h.calls[1]!, "beta")).toBe(1)
    expect(h.entries()).toHaveLength(1)
    expect(
      [
        ...restoreLoadedSkillNames(h.session.sessionManager.getBranch()),
      ].toSorted(),
    ).toEqual(["alpha", "beta"])
    expect(JSON.stringify(h.session.sessionManager.getBranch())).not.toContain(
      "<skill_read_instructions>",
    )
    expect(h.payloads[0]!.state.conversation).toEqual([
      { role: "user", text: "/alpha investigate" },
    ])
    expect(JSON.stringify(h.payloads)).not.toContain("SKILL_BODY")
  } finally {
    h.session.dispose()
  }
})

test("OpenRouter resolves Pi provider auth only for the candidate batch", async () => {
  const h = await setup({
    jev: true,
    jevProvider: "openrouter",
    resolveOpenRouterKey: async () => "OPENROUTER_SYNTHETIC_KEY",
    responses: [fauxAssistantMessage("done")],
  })
  try {
    await h.session.prompt("investigate")
    expect(h.authProviders).toEqual(["openrouter"])
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0]!.url).toBe("https://openrouter.ai/api/v1/systemone")
    expect(h.requests[0]!.init?.headers).toEqual({
      Authorization: "Bearer OPENROUTER_SYNTHETIC_KEY",
      "Content-Type": "application/json",
    })
    expect(JSON.stringify(h.payloads)).not.toContain("OPENROUTER_SYNTHETIC_KEY")
  } finally {
    h.session.dispose()
  }
})

test("OpenRouter never falls back to the TypeSafe environment key", async () => {
  const h = await setup({
    jev: true,
    jevProvider: "openrouter",
    resolveOpenRouterKey: async () => undefined,
    responses: [fauxAssistantMessage("done")],
  })
  try {
    await h.session.prompt("investigate")
    expect(h.authProviders).toEqual(["openrouter"])
    expect(h.requests).toEqual([])
    expect(h.notifications).toContain(
      "inline-skills: Jev selection skipped (openrouter credentials unavailable)",
    )
  } finally {
    h.session.dispose()
  }
})

test.each([
  ["disabled", { jev: false }, "investigate"],
  ["child session", { jev: true, child: true }, "investigate"],
  ["no candidates", { jev: true }, "/alpha /beta /plan explicit"],
  ["zero maxSkills", { jev: true, jevMaxSkills: 0 }, "investigate"],
] as const)(
  "%s does not resolve OpenRouter credentials or send Jev HTTP",
  async (_name, setupOptions, prompt) => {
    const h = await setup({
      ...setupOptions,
      jevProvider: "openrouter",
      responses: [fauxAssistantMessage("done")],
    })
    try {
      await h.session.prompt(prompt)
      expect(h.authProviders).toEqual([])
      expect(h.requests).toEqual([])
    } finally {
      h.session.dispose()
    }
  },
)

test("a completed batch does not resolve credentials again", async () => {
  const h = await setup({
    jev: true,
    jevProvider: "openrouter",
    responses: [fauxAssistantMessage("done")],
  })
  try {
    await h.session.prompt("investigate")
    expect(h.authProviders).toEqual(["openrouter"])
    await h.session.extensionRunner.emitContext(
      h.session.sessionManager.buildSessionProjection().messages,
    )
    expect(h.authProviders).toEqual(["openrouter"])
    expect(h.requests).toHaveLength(1)
  } finally {
    h.session.dispose()
  }
})

test("provider retry reuses one pending credential resolution and Jev decision", async () => {
  const h = await setup({
    jev: true,
    jevProvider: "openrouter",
    settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } },
    responses: [
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "rate limit exceeded",
      }),
      fauxAssistantMessage("recovered"),
    ],
  })
  try {
    await h.session.prompt("investigate")
    expect(h.authProviders).toEqual(["openrouter"])
    expect(h.requests).toHaveLength(1)
  } finally {
    h.session.dispose()
  }
})

test("bounded current input omits a long tail from the entire Jev payload", async () => {
  const sentinel = "DROPPED_LONG_TAIL_SENTINEL"
  const h = await setup({
    jev: true,
    responses: [fauxAssistantMessage("done")],
  })
  try {
    await h.session.prompt(`${"A".repeat(13000)}${sentinel}`)
    expect(h.payloads).toHaveLength(1)
    expect(JSON.stringify(h.payloads)).not.toContain(sentinel)
    expect(h.payloads[0]!.state.currentInput).toBe("A".repeat(12000))
    expect(h.payloads[0]!.state.conversation).toEqual([
      { role: "user", text: "A".repeat(12000) },
    ])
    expect(h.payloads[0]!.state).toMatchObject({ conversationTruncated: true })
  } finally {
    h.session.dispose()
  }
})

test("bounded queued input omits users dropped by the conversation message limit from the entire Jev payload", async () => {
  const sentinel = "DROPPED_QUEUED_USER_SENTINEL"
  const hold = gate()
  const h = await setup({
    jev: true,
    settings: { steeringMode: "all" },
    responses: [
      async () => {
        await hold.promise
        return fauxAssistantMessage("initial answer")
      },
      fauxAssistantMessage("done"),
    ],
  })
  try {
    const run = h.session.prompt("initial request")
    await waitFor(() => h.calls.length === 1)
    await h.session.prompt(sentinel, { streamingBehavior: "steer" })
    await h.session.prompt("retained-one", { streamingBehavior: "steer" })
    await h.session.prompt("retained-two", { streamingBehavior: "steer" })
    await h.session.prompt("retained-three", { streamingBehavior: "steer" })
    await h.session.prompt("retained-four", { streamingBehavior: "steer" })
    await h.session.prompt("retained-five", { streamingBehavior: "steer" })
    await h.session.prompt("retained-six", { streamingBehavior: "steer" })
    hold.release()
    await run
    expect(h.payloads).toHaveLength(2)
    expect(JSON.stringify(h.payloads)).not.toContain(sentinel)
    const expected = [
      "retained-one",
      "retained-two",
      "retained-three",
      "retained-four",
      "retained-five",
      "retained-six",
    ]
    expect(h.payloads[1]!.state.currentInput).toBe(expected.join("\n\n"))
    expect(h.payloads[1]!.state.conversation).toEqual(
      expected.map((value) => ({ role: "user", text: value })),
    )
    expect(h.payloads[1]!.state).toMatchObject({ conversationTruncated: true })
  } finally {
    hold.release()
    h.session.dispose()
  }
})

test("read instructions preserve descending Jev relevance order", async () => {
  const h = await setup({
    jev: true,
    fetch: async (payload) =>
      Response.json({
        answers: Object.fromEntries(
          Object.entries(payload.questions).map(([key, question]) => [
            key,
            {
              type: "noul",
              noul: question.instructions.includes('"beta"') ? 0.99 : 0.9,
            },
          ]),
        ),
      }),
    responses: [fauxAssistantMessage("done")],
  })
  try {
    await h.session.prompt("investigate")
    const instruction = h.calls[0]!.messages.map(text).find((value) =>
      value.includes("<skill_read_instructions>"),
    )!
    expect(instruction.indexOf('"beta"')).toBeLessThan(
      instruction.indexOf('"alpha"'),
    )
  } finally {
    h.session.dispose()
  }
})

test("idle context evaluation after completion cannot revive a recommendation or repeat HTTP", async () => {
  const h = await setup({
    jev: true,
    responses: [fauxAssistantMessage("done")],
  })
  try {
    await h.session.prompt("investigate")
    const messages = await h.session.extensionRunner.emitContext(
      h.session.sessionManager.buildSessionProjection().messages,
    )
    expect(h.payloads).toHaveLength(1)
    expect(messages.map(text).join("\n")).not.toContain(
      "<skill_read_instructions>",
    )
  } finally {
    h.session.dispose()
  }
})

test("a continuation after a completed agent run does not revive its read instructions", async () => {
  let continued = false
  const h = await setup({
    jev: true,
    extensions: [
      (pi) => {
        pi.on("agent_before_settle", () => {
          if (continued) return
          continued = true
          return {
            continue: true,
            entries: [
              {
                type: "custom_message",
                customType: "continuation",
                content: "Continue without new user input.",
                display: false,
              },
            ],
          }
        })
      },
    ],
    responses: [
      fauxAssistantMessage("done"),
      fauxAssistantMessage("continuation"),
    ],
  })
  try {
    await h.session.prompt("investigate")
    expect(h.calls).toHaveLength(2)
    expect(h.payloads).toHaveLength(1)
    expect(h.calls[0]!.messages.map(text).join("\n")).toContain(
      "<skill_read_instructions>",
    )
    expect(h.calls[1]!.messages.map(text).join("\n")).not.toContain(
      "<skill_read_instructions>",
    )
  } finally {
    h.session.dispose()
  }
})

test("failed read retains the recommendation for the request but never marks the skill loaded", async () => {
  const h = await setup({
    jev: true,
    tools: true,
    responses: [
      fauxAssistantMessage(
        fauxToolCall("read", { path: "/missing/SKILL.md" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
      fauxAssistantMessage("next"),
    ],
  })
  try {
    await h.session.prompt("investigate")
    expect(h.payloads).toHaveLength(1)
    expect(h.calls[1]!.messages.map(text).join("\n")).toContain(
      "<skill_read_instructions>",
    )
    expect([
      ...restoreLoadedSkillNames(h.session.sessionManager.getBranch()),
    ]).toEqual([])
    expect(h.entries()).toHaveLength(0)
    await h.session.prompt("/beta explicit next")
    expect(bodyCount(h.calls[2]!, "beta")).toBe(1)
    expect(h.calls[2]!.messages.map(text).join("\n")).not.toContain(
      "<skill_read_instructions>",
    )
  } finally {
    h.session.dispose()
  }
})

test("all-at-once users form one automatic batch; identical later input is a distinct batch", async () => {
  const hold = gate()
  const h = await setup({
    jev: true,
    settings: { steeringMode: "all" },
    responses: [
      async () => {
        await hold.promise
        return fauxAssistantMessage("initial")
      },
      fauxAssistantMessage("batch"),
      fauxAssistantMessage("later"),
    ],
  })
  try {
    const run = h.session.prompt("initial")
    await waitFor(() => h.calls.length === 1)
    await h.session.prompt("investigate", { streamingBehavior: "steer" })
    await h.session.prompt("investigate", { streamingBehavior: "steer" })
    hold.release()
    await run
    expect(h.payloads).toHaveLength(2)
    expect(h.payloads[1]!.state.currentInput).toBe("investigate\n\ninvestigate")
    expect(
      h.payloads[1]!.state.conversation.filter(
        (message) => message.text === "investigate",
      ),
    ).toHaveLength(2)
    await h.session.prompt("investigate")
    expect(h.payloads).toHaveLength(3)
  } finally {
    hold.release()
    h.session.dispose()
  }
})

test.each(["abort", "tree", "switch", "end"] as const)(
  "a selection resolving after %s is discarded",
  async (event) => {
    const hold = gate()
    const h = await setup({
      jev: true,
      fetch: async (payload) => {
        await hold.promise
        return Response.json({
          answers: Object.fromEntries(
            Object.keys(payload.questions).map((key) => [
              key,
              { type: "noul", noul: 0.99 },
            ]),
          ),
        })
      },
      responses: [fauxAssistantMessage("done")],
    })
    try {
      const run = h.session.prompt("investigate")
      await waitFor(() => h.payloads.length === 1)
      let aborting: Promise<void> | undefined
      if (event === "abort") aborting = h.session.abort()
      else if (event === "tree")
        await h.session.extensionRunner.emit({
          type: "session_tree",
          newLeafId: "new",
          oldLeafId: "old",
        })
      else if (event === "switch")
        await h.session.extensionRunner.emit({
          type: "session_before_switch",
          reason: "new",
        })
      else
        await h.session.extensionRunner.emit({
          type: "agent_end",
          messages: [],
        })
      hold.release()
      await aborting
      await run
      for (const call of h.calls)
        expect(call.messages.map(text).join("\n")).not.toContain(
          "<skill_read_instructions>",
        )
      if (event === "abort") expect(h.calls).toHaveLength(0)
      else expect(h.calls).toHaveLength(1)
      expect([
        ...restoreLoadedSkillNames(h.session.sessionManager.getBranch()),
      ]).toEqual([])
    } finally {
      hold.release()
      h.session.dispose()
    }
  },
)
