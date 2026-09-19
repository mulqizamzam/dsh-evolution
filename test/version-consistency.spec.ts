/**
 * Version consistency regression tests.
 *
 * Ensures that the VERSION constant exported by src/host/index.ts matches the
 * package.json version.  Since tsdown inlines the version as a string literal
 * (PKG_VERSION define) at build time, the test reads package.json directly and
 * compares.
 */

import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { VERSION } from '../src/host/index.ts'

const pkgVersion = createRequire(import.meta.url)('../package.json').version

describe('version consistency', () => {
  it('VERSION constant matches package.json', () => {
    expect(VERSION).toBe(pkgVersion)
  })

  it('VERSION is a valid semver string', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
