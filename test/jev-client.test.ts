import { expect, test } from "bun:test"
import { DEFAULT_SETTINGS } from "../src/config.ts"
import { JevSelectionError, selectSkills } from "../src/jev-client.ts"

function options(overrides: Record<string, unknown> = {}) {
  return {
    settings: structuredClone(DEFAULT_SETTINGS.jev),
    apiKey: "SECRET_API_KEY",
    currentInput: "修正して",
    conversation: [
      { role: "assistant" as const, text: "実装しますか？" },
      { role: "user" as const, text: "お願いします" },
      { role: "user" as const, text: "修正して" },
    ],
    conversationTruncated: false,
    candidates: [
      { name: "alpha", description: "Alpha skill" },
      { name: "beta", description: "Beta skill" },
      { name: "gamma", description: "Gamma skill" },
    ],
    explicitSkills: ["manual"],
    loadedSkills: ["loaded"],
    ...overrides,
  }
}

test("one System One POST ranks all Noul answers without exposing the key", async () => {
  let calls = 0
  let capturedUrl = ""
  let capturedInit: RequestInit | undefined
  const result = await selectSkills(
    options({
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        calls += 1
        capturedUrl = String(input)
        capturedInit = init
        return new Response(
          JSON.stringify({
            answers: {
              skill_0: { type: "noul", noul: 0.86 },
              skill_1: { type: "noul", noul: 0.4 },
              skill_2: { type: "noul", noul: 0.98 },
            },
          }),
          { status: 200 },
        )
      },
    }),
  )

  expect(calls).toBe(1)
  expect(capturedUrl).toBe("https://api.typesafe.ai/v1/systemone")
  expect(capturedInit?.method).toBe("POST")
  expect(capturedInit?.redirect).toBe("error")
  expect(capturedInit?.headers).toEqual({
    Authorization: "Bearer SECRET_API_KEY",
    "Content-Type": "application/json",
  })
  expect(String(capturedInit?.body)).not.toContain("SECRET_API_KEY")
  expect(Object.keys(JSON.parse(String(capturedInit?.body)).questions)).toEqual(
    ["skill_0", "skill_1", "skill_2"],
  )
  expect(result.selected).toEqual(["gamma", "alpha"])
  expect(result.scores).toEqual([
    { name: "gamma", noul: 0.98 },
    { name: "alpha", noul: 0.86 },
    { name: "beta", noul: 0.4 },
  ])
})

test("request size is enforced in UTF-8 bytes before fetch", async () => {
  let calls = 0
  const settings = structuredClone(DEFAULT_SETTINGS.jev)
  settings.maxRequestBytes = 8

  await expect(
    selectSkills(
      options({
        settings,
        fetch: async () => {
          calls += 1
          return new Response()
        },
      }),
    ),
  ).rejects.toMatchObject({ kind: "request-too-large" })
  expect(calls).toBe(0)
})

test("caller abort is distinct and prevents a request", async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0

  await expect(
    selectSkills(
      options({
        signal: controller.signal,
        fetch: async () => {
          calls += 1
          return new Response()
        },
      }),
    ),
  ).rejects.toMatchObject({ kind: "aborted" })
  expect(calls).toBe(0)
})

test("timeout aborts the single request without retrying", async () => {
  const settings = structuredClone(DEFAULT_SETTINGS.jev)
  settings.timeoutMs = 5
  let calls = 0

  await expect(
    selectSkills(
      options({
        settings,
        fetch: async (_input: string | URL | Request, init?: RequestInit) => {
          calls += 1
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("synthetic timeout", "AbortError"))
            })
          })
        },
      }),
    ),
  ).rejects.toMatchObject({ kind: "timeout" })
  expect(calls).toBe(1)
})

test.each(["aborted", "timeout"] as const)(
  "body consumption preserves %s classification",
  async (kind) => {
    const controller = new AbortController()
    const settings = structuredClone(DEFAULT_SETTINGS.jev)
    settings.timeoutMs = 5
    await expect(
      selectSkills(
        options({
          settings,
          signal: controller.signal,
          fetch: async (_url: unknown, init?: RequestInit) => {
            class InterruptedResponse extends Response {
              override readonly json = async (): Promise<never> => {
                if (kind === "aborted") controller.abort()
                else
                  await new Promise<void>((resolve) =>
                    init?.signal?.addEventListener("abort", () => resolve(), {
                      once: true,
                    }),
                  )
                throw new Error("SECRET_RESPONSE_ERROR")
              }
            }
            return new InterruptedResponse()
          },
        }),
      ),
    ).rejects.toMatchObject({ kind })
  },
)

test("caller abort after JSON resolution cannot return a successful decision", async () => {
  const controller = new AbortController()
  await expect(
    selectSkills(
      options({
        signal: controller.signal,
        fetch: async () =>
          ({
            ok: true,
            json: async () => {
              controller.abort()
              return {
                answers: {
                  skill_0: { type: "noul", noul: 0.99 },
                  skill_1: { type: "noul", noul: 0.99 },
                  skill_2: { type: "noul", noul: 0.99 },
                },
              }
            },
          }) as Response,
      }),
    ),
  ).rejects.toMatchObject({ kind: "aborted" })
})

test("invalid Noul output is rejected without including response data", async () => {
  await expect(
    selectSkills(
      options({
        fetch: async () =>
          new Response(
            JSON.stringify({
              answers: {
                skill_0: { type: "noul", noul: 2 },
                skill_1: { type: "noul", noul: 0.9 },
                skill_2: { type: "noul", noul: 0.9 },
              },
            }),
          ),
      }),
    ),
  ).rejects.toMatchObject({ kind: "response" })
})

test.each([
  [401, "http-unauthorized"],
  [429, "http-rate-limit"],
  [503, "http-server"],
  [418, "http-client"],
] as const)(
  "HTTP %s is classified without its response body",
  async (status, kind) => {
    let caught: unknown
    try {
      await selectSkills(
        options({
          fetch: async () => new Response("SECRET_SERVER_ERROR", { status }),
        }),
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(JevSelectionError)
    expect(caught).toMatchObject({ kind })
    expect(String(caught)).not.toContain("SECRET_SERVER_ERROR")
  },
)
