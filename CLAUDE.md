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
- **WordPress.com API helpers** (`normalizeWpcomPost`, `getWpcomTypes`, `fetchAllWpcom`) — parallel to the `.org` fetch functions; normalize wpcom post shape to match `.org` shape so all serialisers are API-agnostic
- **DOCX helpers** (`markdownToDocxParagraphs`, `buildDocx`, `metaParagraph`) — convert Markdown text to `docx` paragraph objects; `buildDocx` defines the `ContentPullMeta` custom paragraph style
- **Serialisers** (`writeItemMarkdown`, `writeItemDocx`, `writeAggregate`) — write individual or combined output files in the requested format
- **`doPull(siteUrl, opts)`** — detects which API to use, fetches post types, paginates through all posts, delegates to the appropriate serialiser
- **CLI entry point** — simple manual arg parsing at the bottom, no commander/yargs

## WordPress REST API details

### WordPress.org (self-hosted)

- Post types: `GET /wp-json/wp/v2/types`
- Posts per type: `GET /wp-json/wp/v2/{rest_base}?per_page=100&page=N&_fields=slug,date,modified,title,content,link`
- Rendered content lives in `content.rendered` (default `context=view`) — shortcodes parsed, blocks rendered
- Pagination via `X-WP-TotalPages` response header
- Auth: HTTP Basic with WordPress Application Passwords (`username:app-password` base64-encoded)

### WordPress.com

- Base URL: `https://public-api.wordpress.com/rest/v1.1/sites/{hostname}/`
- Post types: `GET .../post-types/` — filter to `api_queryable: true`
- Posts per type: `GET .../posts/?type={slug}&status=publish&number=100&offset=N`
- Pagination: offset-based; total post count returned as `found` in the response body
- Auth: not required for public content
- Post shape differs from `.org` — `title` is a plain string, `content` is a plain string, `URL` instead of `link`; `normalizeWpcomPost()` maps these to the `.org` shape

### API detection

`doPull` detects which API to use:
1. Hostname ends with `.wordpress.com` → wpcom API directly
2. Otherwise, tries `.org` API (`/wp-json/wp/v2/types`); if that throws, falls back to wpcom

## DOCX output

The `docx` package (v8) is used for Word document generation. Key design decisions:

- **`ContentPullMeta` style** — a custom named paragraph style (`w:val="ContentPullMeta"`) defined in every generated DOCX. Each post begins with one such paragraph containing a JSON string: `{"slug":..., "type":..., "link":..., "date":..., "modified":...}`. This survives human editing and is the hook for round-trip parsing.
- **Page breaks** — `pageBreakBefore: true` on the `ContentPullMeta` paragraph of every post except the first. This keeps the break attached to the start of the post rather than orphaned at the end of the previous one.
- Inline Markdown formatting (bold, italic, links) is stripped to plain text — best-effort fidelity.

## Dependencies

- `docx` ^8.5.0 — Word document generation
- `turndown` ^7.2.0 — HTML to Markdown conversion
- Node 18+ built-ins: `fetch`, `fs`, `path`, `os`, `http`, `child_process`, `url`

## SKIP_TYPES

The `SKIP_TYPES` set at the top of `index.js` lists WordPress-internal post types to skip by default (`attachment`, `wp_template`, etc.). Add to this list if a site uses other internal types that shouldn't be pulled as content.

## Credentials file

`~/.content-pull/credentials.json` — JSON object keyed by normalized site URL. Written with mode `0600`. Do not commit this file.

## Rate limiting

`DEFAULT_DELAY_MS` (500ms) is applied between every HTTP request — between pagination pages within a post type, and between post types. Override with `--delay <ms>`. Pass `0` to disable entirely for local/dev sites.

The delay is applied via a `sleep` helper before each request after the first, so the first request of a run is always immediate.

## User-Agent

All requests send `User-Agent: content-pull/1.0.0 (https://github.com/bigorangelab/content-pull)`. Update the `USER_AGENT` constant at the top of `index.js` when the version changes.


## Things to keep in mind

- Content is fetched as rendered HTML and then converted to Markdown. Fidelity depends on how clean the site's HTML is. Complex layouts, shortcode-generated tables, or embedded media will vary in quality.
- The tool sets file `mtime` to match `post.modified`. File `atime` is also set to `mtime` (macOS/Linux don't expose a separate "created" time via `utimes`).
- The auth callback server listens on `127.0.0.1` with a random OS-assigned port to avoid port conflicts.
- Cookie-based WordPress sessions interfere with Application Password auth — the user must be logged out of the target site in the browser, or use a private window.
