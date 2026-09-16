// Domain types for the evolution plugin, plus the shared module dependency
// contract. Types only — no runtime imports, so module/store cycles are safe.

import type { HostContextShape } from './dsh.ts'
import type { ResolvedConfig } from './config.ts'
import type { EvolutionStore } from './store.ts'

// Experience Record
export interface ExperienceRecord {
  id: string
  timestamp: string
  taskId?: string
  agentVersion?: string
  prompt?: string
  summary?: string
  toolCalls?: Array<{ name: string; args?: unknown; result?: unknown }>
  errors?: string[]
  success: boolean
  score?: number
  durationMs?: number
  stepCount?: number
  metadata?: Record<string, unknown>
}

// Pattern
export type PatternEvidence = 'FACT' | 'INFERENCE' | 'HYPOTHESIS'
export type PatternType = 'failure' | 'success' | 'inefficiency' | 'opportunity'

export interface Pattern {
  id: string
  type: PatternType
  evidence: PatternEvidence
  description: string
  occurrences: number
  evidenceIds: string[]
  confidence: number
  createdAt: string
}

// Candidate
export type CandidateType = 'policy' | 'workflow' | 'skill' | 'routing-rule' | 'verification-strategy' | 'retry-strategy' | 'tool-selection-rule'

export interface CandidateModule {
  id: string
  parentVersion: string
  type: CandidateType
  name: string
  description: string
  reason: string
  evidenceIds: string[]
  patternIds: string[]
  files: Array<{ path: string; content: string }>
  tests: Array<{ path: string; content: string }>
  benchmarkConfig: BenchmarkConfig
  status: 'draft' | 'validated' | 'benchmarked' | 'promoted' | 'rejected'
  createdAt: string
  updatedAt: string
}

// Benchmark
export interface BenchmarkConfig {
  successRate: { min: number; weight: number }
  avgScore: { min: number; weight: number }
  errorRate: { max: number; weight: number }
  avgSteps: { max: number; weight: number }
  avgDurationMs: { max: number; weight: number }
}

export interface BenchmarkRun {
  id: string
  candidateId: string
  version: string
  baseline: string
  runs: number
  metrics: BenchmarkMetrics
  passed: boolean
  details: string
  createdAt: string
  /**
   * How the evidence was produced. `live` means the candidate actually
   * executed in a sandbox; `simulated` means it was inferred from stored
   * experience. The two must never be mixed silently, so the promotion gate
   * reads this field.
   */
  mode?: 'simulated' | 'live'
  /** The command executed for a live run. */
  command?: string
  /** Thresholds in force when the decision was made. */
  thresholds?: BenchmarkConfig
  /** Parent version the candidate was measured against. */
  parentVersion?: string
  /** Baseline side metrics for an A/B run. */
  baselineMetrics?: BenchmarkMetrics
  /** Comparative deltas for an A/B run. */
  comparison?: BenchmarkComparison
  /** Per-case execution results for an A/B run. */
  caseResults?: BenchmarkExecutionResult[]
}

export interface BenchmarkMetrics {
  successRate: number
  avgScore: number
  errorRate: number
  avgSteps: number
  avgDurationMs: number
}

// Version
export interface Version {
  id: string
  number: number
  label: string
  createdAt: string
  promotedFrom?: string
  benchmarkRunId?: string
  reason?: string
  status: 'active' | 'rolled-back'
  modules: string[]
}

/** The only surface a module may depend on. */
export interface ModuleDeps {
  ctx: HostContextShape
  /** Live config reader: CALL per use, never destructure at mount. */
  cfg: () => ResolvedConfig
  store: EvolutionStore
  log: (message: string) => void
  warn: (message: string) => void
}

// ── Agent Default Model (injected from host) ──

export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface AgentDefaultModelService {
  currentSelection(): ModelSelection
}

// ── Sandbox types ──

export interface SandboxExecOptions {
  cwd: string
  timeoutMs: number
  maxMemoryBytes?: number
  env?: Record<string, string>
  readOnlyMounts?: string[]
  readWriteMounts?: string[]
  allowNetwork?: boolean
}

export interface SandboxExecResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  oomKilled: boolean
  durationMs: number
  signal?: string
}

export interface SandboxRunner {
  exec(command: string, options: SandboxExecOptions): Promise<SandboxExecResult>
  isAvailable(): Promise<boolean>
  name: string
}

// ── LLM types (use host ctx.llm directly) ──

/** A minimal subset of the host LlmRuntime stream interface. */
export interface HostLlmStream {
  stream(options: HostLlmGenerateOptions): AsyncIterable<HostLlmStreamChunk>
}

/**
 * One model-facing content block. The host adapter iterates `content` as an
 * ARRAY (`content.some(...)`), so a plain string here fails at call time.
 */
export interface HostContentBlock {
  type: 'text'
  text: string
}

/** A hand-built one-shot message, matching the host's Message contract. */
export interface HostMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: HostContentBlock[]
  source: { kind: 'plugin'; plugin: string }
}

export interface HostLlmGenerateOptions {
  provider: string
  model: string
  messages: HostMessage[]
  system?: string
  maxTokens?: number
  temperature?: number
}

export type HostLlmStreamChunk =
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'usage'; usage: { promptTokens: number; completionTokens: number; totalTokens: number } }
  | { type: 'finish'; reason: unknown }

// ── Builder types ──

export interface CandidateFileSet {
  files: Array<{ path: string; content: string }>
  tests: Array<{ path: string; content: string }>
  manifest: CandidateManifest
}

export interface CandidateManifest {
  name: string
  version: string
  type: CandidateType
  description: string
  entryPoint: string
  testCommand?: string
  benchmarkCases: BenchmarkCase[]
  supportedFileTypes?: string[]
}

export interface CandidateValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

// ── Benchmark types (extended) ──

export interface BenchmarkCase {
  id: string
  description: string
  input: string
  expectedOutput?: string
  expectedExitCode?: number
  timeoutMs: number
  successCriteria: string
  requiredTools?: string[]
}

export interface BenchmarkExecutionResult {
  caseId: string
  passed: boolean
  score: number
  error?: string
  durationMs: number
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
}

export interface ABenchmarkRun {
  id: string
  candidateId: string
  version: string
  baseline: string
  runs: number
  baselineMetrics: BenchmarkMetrics
  candidateMetrics: BenchmarkMetrics
  comparison: BenchmarkComparison
  caseResults: BenchmarkExecutionResult[]
  passed: boolean
  details: string
  createdAt: string
}

export interface BenchmarkComparison {
  successRateDelta: number
  scoreDelta: number
  errorRateDelta: number
  latencyDeltaMs: number
  verdict: 'candidate-wins' | 'baseline-wins' | 'tie'
  rejectionReasons: string[]
}

// ── Promotion policy ──

export interface PromotionPolicy {
  minSuccessImprovement: number
  maxRegression: number
  maxLatencyMultiplier: number
  minCandidateCases: number
  minRuns: number
}

export const DEFAULT_PROMOTION_POLICY: PromotionPolicy = {
  minSuccessImprovement: 0.05,
  maxRegression: -0.05,
  maxLatencyMultiplier: 3.0,
  minCandidateCases: 1,
  minRuns: 3,
}

// ── Candidate runtime ──

export interface CandidateRuntimeResult {
  success: boolean
  exitCode: number | null
  stdout: string
  stderr: string
  durationMs: number
  error?: string
}

export interface CandidateRuntime {
  /** Load candidate files into an isolated environment, return the run dir. */
  load(candidateId: string, files: Array<{ path: string; content: string }>, cwd?: string): Promise<string>
  /** Execute a command in the candidate runtime. */
  exec(command: string, cwd: string, timeoutMs?: number): Promise<CandidateRuntimeResult>
  /** Cleanup: remove the temp directory. */
  cleanup(cwd: string): Promise<void>
}

// ── Session event contract (mirrors the real host shape) ──

/** Why a turn ended, as the host reports it. */
export type HostTurnEndReason =
  | { kind: 'completed' }
  | { kind: 'aborted'; reason?: unknown }
  | { kind: 'blocked' }
  | { kind: 'error'; error?: { message?: string; code?: string } }
  | { kind: 'max-tokens' }
  | { kind: 'interrupted' }

/** Minimal structural view of one host SessionEvent. */
export interface HostSessionEvent {
  type: string
  seq: number
  time: number
  data: Record<string, unknown>
}

/** Minimal structural view of the host Session the event listener receives. */
export interface HostSessionView {
  header: { id: string; cwd?: string }
  events: readonly HostSessionEvent[]
}

/** Outcome of one automatically-observed turn. */
export interface ObservedTurn {
  sessionId: string
  turn: number
  prompt?: string
  success: boolean
  reasonKind: string
  errors?: string[]
  stepCount: number
  durationMs: number
  toolCallNames: string[]
}

export type { ToolDefinition } from './dsh.ts'
