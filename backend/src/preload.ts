import { plugin } from 'bun'
import { resolve } from 'path'

const cliSrc = resolve(import.meta.dir, '../../cli/src')

plugin({
    name: 'cli-alias',
    setup(build) {
        build.onResolve({ filter: /^@\// }, (args) => ({
            path: resolve(cliSrc, args.path.slice(2))
        }))
    }
})
