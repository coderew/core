// @ts-check
import fs from 'node:fs'
import pico from 'picocolors'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
// 遍历packages目录下所有的子包，读取每个包中的package.json文件，判断pkg的private和buildOptions，只要不为true或者配置了buildOptions，该包就是编译目标
export const targets = fs.readdirSync('packages').filter(f => {
  if (!fs.statSync(`packages/${f}`).isDirectory()) {
    return false
  }
  const pkg = require(`../packages/${f}/package.json`)
  if (pkg.private && !pkg.buildOptions) {
    return false
  }
  return true
})

export function fuzzyMatchTarget(partialTargets, includeAllMatching) {
  const matched = []
  partialTargets.forEach(partialTarget => {
    for (const target of targets) {
      if (target.match(partialTarget)) {
        matched.push(target)
        if (!includeAllMatching) {
          break
        }
      }
    }
  })
  if (matched.length) {
    return matched
  } else {
    console.log()
    console.error(
      `  ${pico.white(pico.bgRed(' ERROR '))} ${pico.red(
        `Target ${pico.underline(partialTargets)} not found!`
      )}`
    )
    console.log()

    process.exit(1)
  }
}
