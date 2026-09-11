import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function loadWebCard() {
  const reactStub = [
    'const React = {',
    '  createElement(type, props, ...children) {',
    '    const child = children.length === 1 ? children[0] : children',
    '    return { type, props: { ...(props || {}), children: child } }',
    '  },',
    '}',
    'export default React',
    'export const useState = initial => [initial, () => {}]',
    '',
  ].join('\n')
  const plugin = {
    name: 'stub-web-card-react',
    setup(builder) {
      builder.onResolve({ filter: /^react$/ }, () => ({ path: 'react-stub', namespace: 'web-card-stub' }))
      builder.onLoad({ filter: /.*/, namespace: 'web-card-stub' }, () => ({
        contents: reactStub,
        loader: 'js',
      }))
    },
  }
  const result = await build({
    stdin: {
      contents: "export { VideoCardDesktop } from './components/video/VideoCard.web.tsx'",
      resolveDir: appRoot,
      sourcefile: 'web-card-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    plugins: [plugin],
    tsconfigRaw: { compilerOptions: { jsx: 'transform', baseUrl: appRoot, paths: { '@/*': ['./*'] } } },
    write: false,
  })
  const directory = fs.mkdtempSync(path.join(appRoot, '.video-card-web-'))
  const output = path.join(directory, 'card.cjs')
  fs.writeFileSync(output, result.outputFiles[0].text)
  try {
    return await import(`${pathToFileURL(output).href}?${Math.random()}`)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

function materialize(node) {
  if (!node || typeof node !== 'object') return node
  if (typeof node.type === 'function') return materialize(node.type(node.props))
  const children = node.props?.children
  return {
    ...node,
    props: {
      ...node.props,
      children: Array.isArray(children)
        ? children.map(materialize)
        : materialize(children),
    },
  }
}

function collect(node, result = []) {
  if (!node || typeof node !== 'object') return result
  result.push(node)
  const children = node.props?.children
  if (Array.isArray(children)) children.forEach(child => collect(child, result))
  else collect(children, result)
  return result
}

test('VideoCard.web shares the live channel handlers between avatar and channel name', async () => {
  const { VideoCardDesktop } = await loadWebCard()
  let channelPresses = 0
  const onPress = () => {}
  const onChannelPress = () => {
    channelPresses += 1
  }
  const root = materialize(VideoCardDesktop({
    id: 'video-1',
    title: 'Video',
    channelName: 'Creator',
    onPress,
    onChannelPress,
  }))
  const channelTargets = collect(root).filter(node => (
    typeof node.props?.onClick === 'function' &&
    node.props.onClick !== onPress &&
    typeof node.props?.onMouseEnter === 'function' &&
    typeof node.props?.onMouseLeave === 'function'
  ))

  assert.equal(channelTargets.length, 2, 'both rendered channel targets should carry the shared handlers')
  assert.equal(channelTargets[0].props.onClick, channelTargets[1].props.onClick)
  assert.equal(channelTargets[0].props.onMouseEnter, channelTargets[1].props.onMouseEnter)
  assert.equal(channelTargets[0].props.onMouseLeave, channelTargets[1].props.onMouseLeave)

  let stopped = false
  channelTargets[0].props.onClick({ stopPropagation: () => { stopped = true } })
  assert.equal(stopped, true)
  assert.equal(channelPresses, 1)
})
