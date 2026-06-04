# content-pull

CLI tool that pulls WordPress site content via the REST API and saves it as Markdown files.

## What this is

A single-file Node.js CLI (`index.js`). No build step. No framework. Dependencies are minimal: only `turndown` for HTML→Markdown conversion. Native `fetch` (Node 18+) handles all HTTP.

## File structure

```
index.js          Entry point and entire implementation
package.json      Package metadata and dependencies
```

## Running it

```bash
node index.js <url> [options]
node index.js auth <url>
```

No compilation needed. `npm install` to get `turndown`, then run directly.

## Architecture

All logic lives in `index.js`. Key sections:

- **Credential helpers** (`loadCredentials`, `saveCredentials`, `basicAuth`) — read/write `~/.content-pull/credentials.json`
- **`doAuth(siteUrl)`** — Application Passwords OAuth-style flow: discovers the auth endpoint from `/wp-json/`, starts a local HTTP server, opens browser, captures callback
- **`doPull(siteUrl, opts)`** — fetches post types, paginates through all posts, converts HTML to Markdown, writes files with correct timestamps
- **CLI entry point** — simple manual arg parsing at the bottom, no commander/yargs

## WordPress REST API details

- Post types: `GET /wp-json/wp/v2/types`
- Posts per type: `GET /wp-json/wp/v2/{rest_base}?per_page=100&page=N&_fields=slug,date,modified,title,content,link`
- Rendered content lives in `content.rendered` (default `context=view`) — shortcodes parsed, blocks rendered
- Pagination via `X-WP-TotalPages` response header
- Auth: HTTP Basic with WordPress Application Passwords (`username:app-password` base64-encoded)

## SKIP_TYPES

The `SKIP_TYPES` set at the top of `index.js` lists WordPress-internal post types to skip by default (`attachment`, `wp_template`, etc.). Add to this list if a site uses other internal types that shouldn't be pulled as content.

## Credentials file

`~/.content-pull/credentials.json` — JSON object keyed by normalized site URL. Written with mode `0600`. Do not commit this file.

## Rate limiting

`DEFAULT_DELAY_MS` (500ms) is applied between every HTTP request — between pagination pages within a post type, and between post types. Override with `--delay <ms>`. Pass `0` to disable entirely for local/dev sites.

The delay is applied via a `sleep` helper before each request after the first, so the first request of a run is always immediate.

## User-Agent

All requests send `User-Agent: content-pull/1.0.0 (https://github.com/bigorangelab/content-pull)`. Update the `USER_AGENT` constant at the top of `index.js` when the version changes.

## Dependencies

- `turndown` ^7.2.0 — HTML to Markdown conversion
- Node 18+ built-ins: `fetch`, `fs`, `path`, `os`, `http`, `child_process`, `url`

## Things to keep in mind

- Content is fetched as rendered HTML and then converted to Markdown. Fidelity depends on how clean the site's HTML is. Complex layouts, shortcode-generated tables, or embedded media will vary in quality.
- The tool sets file `mtime` to match `post.modified`. File `atime` is also set to `mtime` (macOS/Linux don't expose a separate "created" time via `utimes`).
- The auth callback server listens on `127.0.0.1` with a random OS-assigned port to avoid port conflicts.
- Cookie-based WordPress sessions interfere with Application Password auth — the user must be logged out of the target site in the browser, or use a private window.
