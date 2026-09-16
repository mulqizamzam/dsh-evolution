import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'

const PROJECT_ROOT = dirname(fileURLToPath(import.meta.url))

const host: UserConfig = {
  name: 'dsh-evolution',
  entry: { index: 'src/host/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  fixedExtension: false,
  dts: false,
  clean: true,
  external: ['schemastery'],
}

export default [host]
export { PROJECT_ROOT }
