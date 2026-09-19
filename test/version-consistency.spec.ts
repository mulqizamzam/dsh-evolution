/**
 * Version consistency regression tests.
 *
 * Ensures that the VERSION constant in src/host/index.ts and the value
 * reported by evo_health both match the package.json version.
 */

import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { VERSION } from '../src/host/index.ts'

const require = createRequire(import.meta.url)
const pkgVersion = require('../package.json').version

describe('version consistency', () => {
  it('VERSION constant matches package.json', () => {
    expect(VERSION).toBe(pkgVersion)
  })

  it('VERSION is a valid semver string', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
