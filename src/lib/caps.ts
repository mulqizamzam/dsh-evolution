/** Text clamping caps for model-visible output. */
export interface EvoCaps {
  /** Max chars per field in tool output. */
  fieldChars: number
  /** Max chars for a full tool output. */
  outputChars: number
  /** Max items in a list response. */
  listLimit: number
}

export const DEFAULT_CAPS: EvoCaps = {
  fieldChars: 500,
  outputChars: 4000,
  listLimit: 50,
}

/** Clamp text to a max length, appending an ellipsis if truncated. */
export function clampText(input: string, max: number): string {
  if (typeof input !== 'string') return ''
  if (input.length <= max) return input
  return input.slice(0, max - 3) + '...'
}
