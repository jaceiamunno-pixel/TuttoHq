// Registers the alias resolve hook (for --import). Verify tooling only.
import { register } from "node:module"
register(new URL("./pco-import-loader.mjs", import.meta.url).href)
