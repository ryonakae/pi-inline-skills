import { expect, test } from "bun:test"
import { rmSync, writeFileSync } from "node:fs"
import { fauxAssistantMessage } from "@earendil-works/pi-ai"
import { restoreLoadedSkillNames } from "../src/loaded-skills.ts"
import { bodyCount, gate, setup, text, waitFor } from "./harness.ts"

test("Jev inserts a hidden body in the first request and notifies only after persistence", async () => {
  const response = gate()
  const h = await setup({
    jev: true,
    responses: [
      async () => {
        await response.promise
        return fauxAssistantMessage("done")
      },
    ],
  })
  try {
    const run = h.session.prompt("/alpha investigate")
    await waitFor(() => h.calls.length === 1)
    expect(h.payloads).toHaveLength(1)
    expect(h.authProviders).toEqual([])
    expect(h.requests[0]!.url).toBe("https://api.typesafe.ai/v1/systemone")
    expect(h.requests[0]!.init?.headers).toEqual({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    })
    expect(bodyCount(h.calls[0]!, "alpha")).toBe(1)
    expect(bodyCount(h.calls[0]!, "beta")).toBe(1)
    expect(h.calls[0]!.messages.map(text).join("\n")).not.toContain(
      "<skill_read_instructions>",
    )
    expect(h.entries()).toHaveLength(1)
    expect(h.notifications).not.toContain("inline-skills: loaded beta by Jev")

    response.release()
    await run
    expect(h.entries()).toHaveLength(2)
    expect(h.entries().map((entry) => entry.display)).toEqual([true, false])
    expect(h.displayed).toHaveLength(1)
    expect(h.entries()[1]!.details).toMatchObject({ source: "jev" })
    expect(h.notifications).toEqual(["inline-skills: loaded beta by Jev"])
    expect(
      [
        ...restoreLoadedSkillNames(h.session.sessionManager.getBranch()),
      ].toSorted(),
    ).toEqual(["alpha", "beta"])
    expect(h.payloads[0]!.state.conversation).toEqual([
      { role: "user", text: "/alpha investigate" },
    ])
    expect(JSON.stringify(h.payloads)).not.toContain("SKILL_BODY")
  } finally {
    response.release()
    h.session.dispose()
  }
})

test("a no-match Jev result stays silent and persists nothing", async () => {
  const h = await setup({
    jev: true,
    fetch: async (payload) =>
      Response.json({
        answers: Object.fromEntries(
          Object.keys(payload.questions).map((key) => [
            key,
            { type: "noul", noul: 0.1 },
          ]),
        ),
      }),
    responses: [fauxAssistantMessage("done")],
  })
  try {
    await h.session.prompt("investigate")
    expect(h.calls).toHaveLength(1)
    expect(h.entries()).toHaveLength(0)
    expect(h.notifications).toEqual([])
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

test("provider retry reuses the constructed automatic body", async () => {
  let betaPath = ""
  const h = await setup({
    jev: true,
    settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } },
    responses: [
      () => {
        writeFileSync(betaPath, "CHANGED_SKILL_BODY")
        return fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "rate limit exceeded",
        })
      },
      fauxAssistantMessage("recovered"),
    ],
  })
  betaPath = h.skillPaths["beta"]!
  try {
    await h.session.prompt("investigate")
    expect(h.requests).toHaveLength(1)
    for (const request of h.calls) {
      expect(bodyCount(request, "beta")).toBe(1)
      expect(request.messages.map(text).join("\n")).not.toContain(
        "CHANGED_SKILL_BODY",
      )
    }
    expect(h.entries()).toHaveLength(1)
    expect(h.notifications).toEqual(["inline-skills: loaded beta by Jev"])
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

test("automatic bodies preserve descending Jev relevance order", async () => {
  const h = await setup({
    jev: true,
    fetch: async (payload) =>
      Response.json({
        answers: Object.fromEntries(
          Object.entries(payload.questions).map(([key, question]) => [
            key,
            {
              type: "noul",
              noul: question.instructions.includes('"beta"')
                ? 0.99
                : question.instructions.includes('"alpha"')
                  ? 0.9
                  : 0.1,
            },
          ]),
        ),
      }),
    responses: [fauxAssistantMessage("done")],
  })
  try {
    await h.session.prompt("investigate")
    const injection = h.calls[0]!.messages.map(text).find((value) =>
      value.includes("<inline_skills>"),
    )!
    expect(injection.indexOf('name="beta"')).toBeLessThan(
      injection.indexOf('name="alpha"'),
    )
    expect(h.entries()).toHaveLength(1)
    expect(h.entries()[0]!.details).toMatchObject({
      names: ["beta", "alpha"],
      source: "jev",
    })
    expect(h.notifications).toEqual([
      "inline-skills: loaded beta, alpha by Jev",
    ])
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

test("a continuation after a completed agent run does not duplicate its automatic body", async () => {
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
    expect(bodyCount(h.calls[0]!, "beta")).toBe(1)
    expect(bodyCount(h.calls[1]!, "beta")).toBe(1)
    expect(h.entries()).toHaveLength(1)
    expect(h.notifications).toEqual(["inline-skills: loaded beta by Jev"])
  } finally {
    h.session.dispose()
  }
})

test("an unreadable automatic skill warns once and can be retried by the next request", async () => {
  let betaPath = ""
  let removed = false
  const h = await setup({
    jev: true,
    fetch: async (payload) => {
      if (!removed) {
        removed = true
        rmSync(betaPath)
      }
      return Response.json({
        answers: Object.fromEntries(
          Object.entries(payload.questions).map(([key, question]) => [
            key,
            {
              type: "noul",
              noul: question.instructions.includes('"beta"') ? 0.99 : 0.1,
            },
          ]),
        ),
      })
    },
    responses: [fauxAssistantMessage("first"), fauxAssistantMessage("next")],
  })
  betaPath = h.skillPaths["beta"]!
  try {
    await h.session.prompt("investigate")
    expect(h.payloads).toHaveLength(1)
    expect(bodyCount(h.calls[0]!, "beta")).toBe(0)
    expect([
      ...restoreLoadedSkillNames(h.session.sessionManager.getBranch()),
    ]).toEqual([])
    expect(h.entries()).toHaveLength(0)
    expect(h.notifications).toEqual(["inline-skills: failed to load beta"])

    writeFileSync(h.skillPaths["beta"]!, "BETA_SKILL_BODY")
    await h.session.prompt("investigate again")
    expect(h.payloads).toHaveLength(2)
    expect(bodyCount(h.calls[1]!, "beta")).toBe(1)
    expect(h.notifications).toEqual([
      "inline-skills: failed to load beta",
      "inline-skills: loaded beta by Jev",
    ])
  } finally {
    h.session.dispose()
  }
})

test("partial automatic load failure persists and notifies only successful skills", async () => {
  let betaPath = ""
  const h = await setup({
    jev: true,
    fetch: async (payload) => {
      rmSync(betaPath)
      return Response.json({
        answers: Object.fromEntries(
          Object.entries(payload.questions).map(([key, question]) => [
            key,
            {
              type: "noul",
              noul: question.instructions.includes('"plan"') ? 0.1 : 0.99,
            },
          ]),
        ),
      })
    },
    responses: [fauxAssistantMessage("done")],
  })
  betaPath = h.skillPaths["beta"]!
  try {
    await h.session.prompt("investigate")
    expect(bodyCount(h.calls[0]!, "beta")).toBe(0)
    expect(bodyCount(h.calls[0]!, "alpha")).toBe(1)
    expect(h.entries()).toHaveLength(1)
    expect(h.entries()[0]!.details).toMatchObject({
      names: ["alpha"],
      source: "jev",
    })
    expect(h.notifications).toEqual([
      "inline-skills: failed to load beta",
      "inline-skills: loaded alpha by Jev",
    ])
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

test("abort after automatic insertion preserves the body and notifies only its persisted load", async () => {
  const hold = gate()
  const h = await setup({
    jev: true,
    responses: [
      async () => {
        await hold.promise
        return fauxAssistantMessage("interrupted")
      },
      fauxAssistantMessage("next"),
    ],
  })
  try {
    const run = h.session.prompt("investigate")
    await waitFor(() => h.calls.length === 1)
    expect(bodyCount(h.calls[0]!, "beta")).toBe(1)
    expect(h.entries()).toHaveLength(0)
    expect(h.notifications).toEqual([])
    const aborting = h.session.abort()
    hold.release()
    await aborting
    await run
    expect(h.entries()).toHaveLength(1)
    expect(h.entries()[0]!.display).toBe(false)
    expect(h.notifications).toEqual(["inline-skills: loaded beta by Jev"])
    await h.session.prompt("/beta continue")
    expect(bodyCount(h.calls[1]!, "beta")).toBe(1)
    expect(h.entries()).toHaveLength(1)
    expect(h.notifications).toEqual(["inline-skills: loaded beta by Jev"])
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
      for (const call of h.calls) expect(bodyCount(call, "beta")).toBe(0)
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
