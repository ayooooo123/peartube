import { parseArgs } from 'node:util'

const PLATFORMS = ['android', 'ios', 'desktop']

export function parseAppTestArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      platform: { type: 'string' },
      attach: { type: 'string' },
      seed: { type: 'boolean', default: false },
      'record-only': { type: 'boolean', default: false },
      eyes: { type: 'string', default: 'omp' },
      flow: { type: 'string' },
    },
    allowPositionals: false,
  })
  if (!values.platform) throw new Error('--platform is required (android|ios|desktop|all)')
  const platforms = values.platform === 'all' ? [...PLATFORMS] : [values.platform]
  for (const p of platforms) if (!PLATFORMS.includes(p)) throw new Error(`unknown --platform ${p}`)
  if (!['omp', 'look'].includes(values.eyes)) throw new Error(`unknown --eyes ${values.eyes}`)
  return {
    platform: values.platform,
    platforms,
    attach: values.attach ?? null,
    seed: values.seed,
    recordOnly: values['record-only'],
    eyes: values.eyes,
    flow: values.flow ?? null,
  }
}
