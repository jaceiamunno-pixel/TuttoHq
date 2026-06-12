// Minimal ESM resolve hook so the verify harness can import the REAL TypeScript
// parser modules (which Node 24 runs via --experimental-strip-types). Resolves
// the project's "@/..." path alias to src/, and appends ".ts" to extensionless
// relative imports. Test-tooling only; not used by the app.

import { existsSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
import { resolve as resolvePath } from "node:path"

const SRC = pathToFileURL(resolvePath(process.cwd(), "src") + "/").href

export async function resolve(specifier, context, nextResolve) {
  // "@/x/y" → <repo>/src/x/y
  let spec = specifier
  if (spec.startsWith("@/")) spec = new URL(spec.slice(2), SRC).href

  // Already has an extension or resolves cleanly → let Node handle it.
  try {
    return await nextResolve(spec, context)
  } catch (err) {
    // Extensionless relative/alias import → try the .ts file.
    let url
    if (spec.startsWith("file:")) url = new URL(spec)
    else if (spec.startsWith(".")) url = new URL(spec, context.parentURL)
    else throw err
    const tsHref = url.href + ".ts"
    if (existsSync(fileURLToPath(tsHref))) return { url: tsHref, shortCircuit: true }
    throw err
  }
}
