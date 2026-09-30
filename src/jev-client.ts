import type { JevSettings } from "./config.ts"

const SYSTEM_ONE_URL = {
  typesafe: "https://api.typesafe.ai/v1/systemone",
  openrouter: "https://openrouter.ai/api/v1/systemone",
} as const

type Candidate = {
  name: string
  description?: string
}

type SelectSkillsOptions = {
  settings: JevSettings
  apiKey: string
  currentInput: string
  conversation: Array<{ role: "user" | "assistant"; text: string }>
  conversationTruncated: boolean
  candidates: Candidate[]
  explicitSkills: string[]
  loadedSkills: string[]
  signal?: AbortSignal
  fetch?: typeof fetch
}

export type JevSkillScore = {
  name: string
  noul: number
}

export type SelectSkillsResult = {
  selected: string[]
  scores: JevSkillScore[]
  latencyMs: number
}

export class JevSelectionError extends Error {
  constructor(
    readonly kind:
      | "aborted"
      | "timeout"
      | "request-too-large"
      | "http-unauthorized"
      | "http-rate-limit"
      | "http-server"
      | "http-client"
      | "response"
      | "network",
  ) {
    super(`Jev skill selection failed: ${kind}`)
  }
}

function combinedSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

function parseScores(value: unknown, candidates: Candidate[]): JevSkillScore[] {
  if (typeof value !== "object" || value === null) {
    throw new JevSelectionError("response")
  }
  const answers = (value as { answers?: unknown }).answers
  if (typeof answers !== "object" || answers === null) {
    throw new JevSelectionError("response")
  }

  return candidates.map((candidate, index) => {
    const answer = (answers as Record<string, unknown>)[`skill_${index}`]
    if (typeof answer !== "object" || answer === null) {
      throw new JevSelectionError("response")
    }
    const typed = answer as { type?: unknown; noul?: unknown }
    if (
      typed.type !== "noul" ||
      typeof typed.noul !== "number" ||
      !Number.isFinite(typed.noul) ||
      typed.noul < 0 ||
      typed.noul > 1
    ) {
      throw new JevSelectionError("response")
    }
    return { name: candidate.name, noul: typed.noul }
  })
}

export async function selectSkills(
  options: SelectSkillsOptions,
): Promise<SelectSkillsResult> {
  if (options.signal?.aborted) throw new JevSelectionError("aborted")
  const questions = Object.fromEntries(
    options.candidates.map((candidate, index) => [
      `skill_${index}`,
      {
        type: "noul",
        instructions: [
          `Should the ${JSON.stringify(candidate.name)} skill be loaded to help answer the current user input?`,
          candidate.description
            ? `Skill description: ${candidate.description}`
            : "The skill has no description.",
          "Answer yes only when the skill is directly relevant and useful.",
        ].join("\n"),
      },
    ]),
  )
  const body = JSON.stringify({
    state: {
      currentInput: options.currentInput,
      conversation: options.conversation,
      conversationTruncated: options.conversationTruncated,
      explicitSkills: options.explicitSkills,
      loadedSkills: options.loadedSkills,
    },
    model: options.settings.model,
    questions,
  })
  if (
    new TextEncoder().encode(body).byteLength > options.settings.maxRequestBytes
  ) {
    throw new JevSelectionError("request-too-large")
  }

  const startedAt = performance.now()
  let response: Response
  const signal = combinedSignal(options.settings.timeoutMs, options.signal)
  try {
    response = await (options.fetch ?? globalThis.fetch)(
      SYSTEM_ONE_URL[options.settings.provider],
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
        },
        body,
        redirect: "error",
        signal,
      },
    )
  } catch {
    if (options.signal?.aborted) throw new JevSelectionError("aborted")
    if (signal.aborted) throw new JevSelectionError("timeout")
    throw new JevSelectionError("network")
  }
  if (options.signal?.aborted) throw new JevSelectionError("aborted")
  if (signal.aborted) throw new JevSelectionError("timeout")
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new JevSelectionError("http-unauthorized")
    }
    if (response.status === 429) {
      throw new JevSelectionError("http-rate-limit")
    }
    if (response.status >= 500) {
      throw new JevSelectionError("http-server")
    }
    throw new JevSelectionError("http-client")
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    if (options.signal?.aborted) throw new JevSelectionError("aborted")
    if (signal.aborted) throw new JevSelectionError("timeout")
    throw new JevSelectionError("response")
  }
  if (options.signal?.aborted) throw new JevSelectionError("aborted")
  if (signal.aborted) throw new JevSelectionError("timeout")
  const scores = parseScores(payload, options.candidates).toSorted(
    (left, right) => right.noul - left.noul,
  )
  return {
    selected: scores
      .filter((score) => score.noul >= options.settings.minRelevance)
      .slice(0, options.settings.maxSkills)
      .map((score) => score.name),
    scores,
    latencyMs: performance.now() - startedAt,
  }
}
