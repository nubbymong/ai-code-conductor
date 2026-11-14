## 2026-11-14 -- Patched dependencies for 2.1.3-beta.2

- Pre-cut check of the open Dependabot alerts against the `beta` lockfile (Dependabot reads only `main`). Already patched on `beta`: the MCP SDK, Electron, undici, body-parser, DOMPurify, vite, proxy-addr and source-map-js.
- Raised the override floors for hono (4.13.18), @hono/node-server (2.1.8), fast-uri (3.1.9) and ip-address (10.7.6), all in their current majors, and vitest to 4.1.12 (dev). Only the lockfile was refreshed; CI installs from it.
- Left for the next beta: katex (low). mermaid pins `^0.16.45` and the fix is 0.18.2, a 0.x major under a diagram renderer.
