/**
 * Fake LLM provider for P12 tests that need generation enabled.
 * Returns a well-formed candidate JSON on the first stream call.
 */
export function makeFakeLlm(): {
  stream: (opts: unknown) => AsyncIterable<{ type: string; text?: string; index?: number; usage?: Record<string, number>; reason?: unknown }>
  nextCandidateName: string
} {
  let candidateName = 'degradation-fix-v1'
  const fakeStream = async function* () {
    yield {
      type: 'text-delta',
      index: 0,
      text: JSON.stringify({
        manifest: {
          name: candidateName,
          version: '1.0.0',
          type: 'retry-strategy',
          description: 'Fix degradation via retry strategy',
          entryPoint: 'src/index.ts',
          benchmarkCases: [{
            id: 'case-1',
            description: 'retry passes',
            input: 'test',
            expectedExitCode: 0,
            timeoutMs: 5000,
            successCriteria: 'exit 0',
          }],
        },
        files: [{ path: 'src/index.ts', content: 'export default { retry: true }' }],
        tests: [{ path: 'test/index.spec.ts', content: 'test' }],
      }),
    }
    yield { type: 'finish', reason: { kind: 'completed' } }
  }

  return {
    stream: fakeStream,
    get nextCandidateName() { return candidateName },
    set nextCandidateName(v: string) { candidateName = v },
  }
}
