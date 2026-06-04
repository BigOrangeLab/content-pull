# content-pull

CLI tool that pulls WordPress site content via the REST API and saves it as Markdown files.

## What this is

A single-file Node.js CLI (`index.js`). No build step. No framework. Native `fetch` (Node 18+) handles all HTTP.

## File structure

```
index.js          Entry point and entire implementation
package.json      Package metadata and dependencies
```

## Running it

```bash
node index.js <url> [options]
node index.js auth <url>
node index.js reimport <url> <original.docx> <edited.docx> [--dry-run]
```

No compilation needed. `npm install`, then run directly.

## Architecture

All logic lives in `index.js`. Key sections:

- **Utilities** (`decodeHtmlEntities`, `plainText`, `sleep`, `stripTags`) — shared helpers used throughout
- **Credential helpers** (`loadCredentials`, `saveCredentials`, `basicAuth`) — read/write `~/.content-pull/credentials.json`
- **`apiFetch(url, authHeader, method, data)`** — thin fetch wrapper; supports GET and POST with JSON body
- **WordPress.com API helpers** (`normalizeWpcomPost`, `getWpcomTypes`, `fetchAllWpcom`) — parallel to the `.org` fetch functions; normalise wpcom post shape to match `.org` shape so all serialisers are API-agnostic
- **DOCX helpers** (`inlineRuns`, `htmlToDocxParagraphs`, `buildDocx`, `metaParagraph`) — convert HTML directly to `docx` paragraph objects via `node-html-parser`; `buildDocx` defines the `ContentPullMeta` custom paragraph style
- **HTML serialiser** (`writeItemHtml`) — writes a self-contained `.html` file with `<meta>` tags and `data-content-pull-meta` attribute
- **Serialisers** (`writeItemMarkdown`, `writeItemDocx`, `writeAggregate`) — write individual or combined output files; `writeAggregate` names the file after the site hostname
- **Reimport helpers** (`normText`, `parseDocxXml`, `loadDocxPosts`, `diffParagraphs`, `parseWpBlocks`, `spliceBlockText`, `initLlmClient`, `llmMerge`) — paragraph-level DOCX diff and block-splice pipeline; LLM dispatch for complex cases
- **`doReimport(siteUrl, origPath, editedPath, opts)`** — orchestrates the full reimport flow; writes `reimport-review.json` for low-confidence items
- **`doAuth(siteUrl)`** — Application Passwords OAuth-style flow: discovers the auth endpoint from `/wp-json/`, starts a local HTTP server, opens browser, captures callback
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

- **HTML→DOCX directly** — `htmlToDocxParagraphs` uses `node-html-parser` to walk the rendered HTML DOM and produce `docx` paragraph objects. Turndown is not involved in the DOCX path.
- **`ContentPullMeta` style** — a custom named paragraph style (`w:val="ContentPullMeta"`) defined in every generated DOCX. Each post begins with one such paragraph containing JSON: `{"slug":..., "type":..., "link":..., "date":..., "modified":...}`. This survives human editing and is the hook for `reimport`.
- **Page breaks** — `pageBreakBefore: true` on the `ContentPullMeta` paragraph of every post except the first.
- **Aggregate filename** — uses the site hostname (`example.com.docx`), sanitised for filesystem safety.

## Reimport

`doReimport` orchestrates the round-trip flow:

1. `loadDocxPosts` unzips both DOCXs with `jszip`, parses `word/document.xml` with regex, splits on `ContentPullMeta` paragraphs
2. `diffParagraphs` runs an LCS diff, coalescing adjacent remove+add into `changed`
3. `parseWpBlocks` finds leaf-level Gutenberg blocks (those with no nested `<!-- wp:` blocks) by scanning `content.raw`
4. `spliceBlockText` replaces the inner HTML text of a matched block, preserving the outer tag and its attributes
5. `initLlmClient` picks Anthropic or OpenAI-compatible based on env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`)
6. `llmMerge` dispatches to the Anthropic messages API (tool use) or the OpenAI chat completions API (function calling), requesting a structured `{updated, confidence, reasoning}` response
7. Items with confidence < 90% are collected into `reimport-review.json`

## Dependencies

- `@anthropic-ai/sdk` ^0.39.0 — Anthropic API client (reimport LLM path)
- `docx` ^8.5.0 — Word document generation
- `jszip` ^3.10.1 — DOCX unzipping for reimport
- `node-html-parser` ^6.1.0 — HTML→DOCX conversion
- `openai` ^4.0.0 — OpenAI-compatible API client (reimport LLM path)
- `turndown` ^7.2.0 — HTML→Markdown conversion (Markdown output only)
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
