import { JSON_OBJECT_OUTPUT, defineTool, registerToolSafe, text } from '../../dsh.ts'
import type { ExperienceRecord, ModuleDeps, Pattern, ToolDefinition } from '../../types.ts'
import { neutralizeDeep } from '../../../lib/sanitize.ts'

const RENDER = (_args: Record<string, unknown>, value: never): Array<{ type: 'text'; text: string }> => text(value)

function signature(record: ExperienceRecord): string {
  return [record.prompt ?? '', record.summary ?? '', ...(record.errors ?? [])]
    .join('\n')
    .trim()
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ')
    .slice(0, 1000)
}

export function auditMemory(experiences: ExperienceRecord[], patterns: Pattern[], retentionDays: number, now = Date.now()) {
  const groups = new Map<string, ExperienceRecord[]>()
  for (const record of experiences) {
    const key = signature(record)
    if (!key) continue
    const group = groups.get(key) ?? []
    group.push(record)
    groups.set(key, group)
  }
  const duplicateGroups = [...groups.values()]
    .filter(group => group.length > 1)
    .map(group => ({ count: group.length, ids: group.map(record => record.id).slice(0, 10) }))
    .sort((a, b) => b.count - a.count)
  const cutoff = now - Math.max(1, retentionDays) * 24 * 60 * 60 * 1000
  const stalePatterns = patterns.filter(pattern => {
    const created = Date.parse(pattern.createdAt)
    return Number.isFinite(created) && created < cutoff && pattern.confidence < 0.5
  }).map(pattern => ({
    id: pattern.id,
    type: pattern.type,
    confidence: pattern.confidence,
    createdAt: pattern.createdAt,
    reason: 'older than retention window and confidence below 0.5',
  }))
  return {
    experienceCount: experiences.length,
    patternCount: patterns.length,
    duplicateGroupCount: duplicateGroups.length,
    duplicateRecordCount: duplicateGroups.reduce((sum, group) => sum + group.count - 1, 0),
    duplicateGroups: duplicateGroups.slice(0, 20),
    stalePatternCount: stalePatterns.length,
    stalePatterns: stalePatterns.slice(0, 50),
    retentionDays,
    destructiveActionTaken: false,
  }
}

export const name = 'memory-lifecycle'

export function apply(deps: ModuleDeps): void {
  const tool: ToolDefinition = defineTool({
    name: 'evo_memory_lifecycle',
    description: 'Audit evolution memory for duplicate experience signatures and old low-confidence patterns. By default this is read-only; set applyRetention=true to explicitly run the existing configured experience-retention policy.',
    parameters: {
      type: 'object',
      properties: {
        applyRetention: { type: 'boolean', description: 'If true, apply the configured max-record and retention-day pruning policy. Defaults to false (audit only).' },
    },
      required: [],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async (args: never) => {
      const a = (args ?? {}) as Record<string, unknown>
      const cfg = deps.cfg().experience
      const [experiences, patterns] = await Promise.all([
        deps.store.listExperiences(10000),
        deps.store.listPatterns(1000),
      ])
      const report = auditMemory(experiences, patterns, cfg.retentionDays)
      if (a.applyRetention !== true) return neutralizeDeep({ ok: true, mode: 'audit-only', ...report })
      const removed = await deps.store.pruneExperiences(cfg.maxRecords, cfg.retentionDays)
      const remaining = await deps.store.listExperiences(10000)
      return neutralizeDeep({
        ok: true,
        mode: 'retention-applied',
        ...report,
        destructiveActionTaken: removed > 0,
        removedExperienceCount: removed,
        remainingExperienceCount: remaining.length,
        note: 'Pruning follows the existing configured retention policy; duplicate records and patterns are reported, not deleted.',
      })
    },
  } as never)
  const result = registerToolSafe(deps.ctx, tool)
  if (!result.ok) deps.warn('memory-lifecycle: tool registration failed: ' + result.error)
  deps.log('memory-lifecycle: registered evo_memory_lifecycle')
}
