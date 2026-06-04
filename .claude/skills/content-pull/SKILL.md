---
name: content-pull
description: "Pull all public content from a WordPress site via REST API and save as Markdown, HTML, or Word files. Use when an agent needs to ingest, archive, process, or round-trip-edit WordPress post content programmatically."
compatibility: "Any WordPress site with REST API enabled (default since WP 4.7), or any WordPress.com-hosted site. Requires Node.js 18+."
license: GPL-2.0-or-later
metadata:
    author: georgestephanis
    version: "1.2"
    written: "2026-06-04"
    written_against:
        content-pull: "1.0.0"
        node: "18"
---

# content-pull

`content-pull` fetches all publicly available post types from a WordPress site via the REST API and writes each post as a Markdown file or Word document. It is a single-file Node.js CLI — no build step.

## When to use

- Ingesting WordPress content for downstream processing (search indexing, LLM context, static site generation)
- Archiving or mirroring a WordPress site's content as flat files
- Generating a Word document for editorial review, with changes parseable back to WordPress
- Pulling content from WordPress.com-hosted sites where the self-hosted REST API is unavailable

Do NOT use the `auth` subcommand in agentic contexts — it opens a browser. See [Credentials (non-interactive)](#2-credentials-non-interactive) below.

## Inputs required

- **Site URL** — the root URL of the WordPress site (e.g. `https://example.com`)
- **Output directory** — where to write the Markdown files (defaults to current directory)
- **Credentials** — only needed for private/restricted content; see below
- **content-pull installed** — see [references/installation.md](references/installation.md)

## Procedure

### 1. Verify content-pull is available

```bash
node index.js --help 2>&1 | head -1
# or if installed globally:
content-pull --help 2>&1 | head -1
```

If not installed, see [references/installation.md](references/installation.md).

### 2. Credentials (non-interactive)

**Never run `content-pull auth <url>`** — it starts a local HTTP server and opens a browser, which hangs in non-interactive environments.

For public content, no credentials are needed — skip this step.

For private or restricted content, write credentials directly to `~/.content-pull/credentials.json`:

```bash
mkdir -p ~/.content-pull
cat > ~/.content-pull/credentials.json <<'EOF'
{
  "https://example.com": {
    "user": "your-username",
    "pass": "xxxx-xxxx-xxxx-xxxx-xxxx"
  }
}
EOF
chmod 600 ~/.content-pull/credentials.json
```

The key must be the site URL with no trailing slash, lowercased (matching `normalizeUrl` in the source). The `pass` value must be a [WordPress Application Password](https://make.wordpress.org/core/2020/11/05/application-passwords-integration-guide/), not the account password.

Alternatively, pass credentials inline to avoid the file entirely:

```bash
node index.js https://example.com --user your-username --pass xxxx-xxxx-xxxx-xxxx
```

### 3. Run the pull

```bash
node index.js <site-url> --output <dir> [--types <types>] [--delay <ms>]
```

Common invocations:

```bash
# Pull all public post types into ./site-content/
node index.js https://example.com --output ./site-content

# Pull only posts and pages, no delay (dev/local site)
node index.js https://example.com --output ./site-content --types post,page --delay 0

# Pull with inline credentials
node index.js https://example.com --output ./out --user george --pass abcd-efgh-ijkl-mnop

# Slow down for a production site under load
node index.js https://example.com --output ./out --delay 1000
```

**Flag reference:**

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--output` | `-o` | `.` (cwd) | Directory to write files into |
| `--types` | `-t` | all public | Comma-separated post type slugs |
| `--format` | `-f` | `md` | Output format: `md`, `html`, or `docx` |
| `--layout` | `-l` | `type` | File layout: `type` or `url` |
| `--aggregate` | `-a` | off | Combine all posts into one file named after the domain |
| `--user` | `-u` | from creds file | WordPress username |
| `--pass` | `-p` | from creds file | WordPress application password |
| `--delay` | `-d` | `500` | Ms between HTTP requests |

### 4. WordPress.com sites

Sites hosted on WordPress.com are supported without any extra flags. The tool detects `*.wordpress.com` hostnames automatically and uses the WordPress.com REST API (`https://public-api.wordpress.com/rest/v1.1/`). For self-hosted sites with the `.org` REST API disabled, the tool tries `.org` first and silently falls back to the WordPress.com API.

WordPress.com public content requires no credentials.

### 5. Understand the output

Non-aggregate files always land in a subdirectory named after the site hostname. The `--layout` flag controls the path structure within that:

**`--layout type` (default)** — `<outputDir>/<hostname>/<postType>/<slug>.ext`

```text
out/
  example.com/
    post/
      hello-world.md
    page/
      about.md
    event/
      conference-2025.md
```

**`--layout url`** — `<outputDir>/<hostname>/<canonical-url-path>/index.ext`

```text
out/
  example.com/
    blog/
      hello-world/
        index.md
    about/
      index.md
```

Markdown frontmatter fields:

```yaml
---
title: "Post Title"
date: 2024-06-01T10:00:00
modified: 2024-06-01T14:22:00
link: https://example.com/hello-world/
---
```

File `mtime` is set to match `post.modified`, so filesystem timestamps reflect when WordPress content was last changed.

Post body is HTML→Markdown via [Turndown](https://github.com/mixmark-io/turndown) with ATX headings (`#`) and fenced code blocks. Complex layouts (nested tables, shortcode-generated HTML) may convert imperfectly.

### 6. DOCX output

Pass `--format docx` to write Word documents. Content is converted directly from WordPress's rendered HTML — headings, paragraphs, bold, italic, and links are preserved; images are skipped. Combined with `--aggregate`, produces a single file named after the domain.

```bash
# Single Word document of all posts and pages
node index.js https://example.com --output ./out --format docx --aggregate --types post,page --delay 0
# → ./out/example.com.docx
```

Each post begins with a `ContentPullMeta` paragraph — a small grey monospaced line containing a JSON object:

```json
{"slug":"hello-world","type":"post","link":"https://example.com/hello-world/","date":"2024-01-15T09:30:00","modified":"2024-06-01T14:22:00"}
```

In an aggregate DOCX, every post except the first starts on a new page. The `ContentPullMeta` line persists after editing and is the hook for the `reimport` subcommand.

### 7. HTML output

Pass `--format html` to save the raw rendered HTML. Individual files: `<outputDir>/<type>/<slug>.html`. Aggregate: `<outputDir>/example.com.html`, with each post as `<article data-content-pull-meta='...'>`.

### 8. Aggregate Markdown

Pass `--aggregate` (without `--format docx` or `--format html`) to write a single `example.com.md`. Posts are separated by `---` rules; each opens with `## <title>` and a metadata line.

### 9. Post types skipped by default

These WordPress-internal types are always skipped regardless of `--types`:

`attachment`, `nav_menu_item`, `wp_block`, `wp_navigation`, `wp_template`, `wp_template_part`, `wp_global_styles`, `wp_font_family`, `wp_font_face`

To skip additional internal types, edit `SKIP_TYPES` in `index.js`.

## Round-trip workflow

Pull content to DOCX, hand it to a human editor, then push changes back to WordPress with the `reimport` subcommand.

### Step 1 — Pull to DOCX

```bash
node index.js https://example.com --output ./review --format docx --aggregate --types post,page
# → ./review/example.com.docx
```

### Step 2 — Human edits the document

The editor opens `example.com.docx`, rewrites body text, and saves. They must not delete or edit the grey `ContentPullMeta` lines — those are the post identifiers used by reimport.

### Step 3 — Reimport the edited DOCX

```bash
node index.js reimport https://example.com ./review/example.com.docx ./review/example.com-edited.docx
```

Always do a dry run first to review what would change:

```bash
node index.js reimport https://example.com original.docx edited.docx --dry-run
```

The reimport command:

1. Parses both DOCXs and diffs paragraphs per post (LCS algorithm)
2. For each change, fetches the post's raw Gutenberg block source from WordPress (`context=edit`, requires auth)
3. Matches changed paragraphs to leaf blocks by normalised text comparison
4. **Programmatic path** — simple text-only leaf blocks are spliced directly
5. **LLM path** — blocks with rich inline HTML, and all additions/deletions, are sent to an LLM for merging
6. Changes with LLM confidence < 90% are written to `reimport-review.json` for human or agent review

### LLM configuration for reimport

Set one of these environment variables:

| Variable | Effect |
|----------|--------|
| `ANTHROPIC_API_KEY` | Anthropic Claude (`claude-sonnet-4-6`) |
| `OPENAI_API_KEY` | OpenAI or compatible endpoint (`gpt-4o` default) |
| `OPENAI_BASE_URL` | Custom endpoint — Ollama, vLLM, LM Studio, etc. |
| `OPENAI_MODEL` | Override model name (e.g. `llama3`, `mistral`) |

```bash
# Anthropic
ANTHROPIC_API_KEY=sk-ant-... node index.js reimport https://example.com orig.docx edited.docx

# Ollama (no API key required)
OPENAI_BASE_URL=http://localhost:11434/v1 OPENAI_MODEL=llama3 \
  node index.js reimport https://example.com orig.docx edited.docx
```

Without an LLM, only programmatic matches are applied; everything else is written to the review file.

### Review file

`reimport-review.json` is written to the current directory when items cannot be applied at ≥90% confidence. Each entry contains:

- `change_type` — `changed`, `added`, or `removed`
- `orig` / `edit` — original and edited paragraph text
- `block_raw` — the WordPress block source being modified
- `llm_suggestion` — the LLM's best attempt at the merge
- `confidence` — LLM confidence score (0–100)
- `reasoning` — LLM's explanation

This file can be passed directly to an LLM agent with WordPress REST API access to resolve remaining items.

## Verification

Successful run prints:

```text
Pulling from: https://example.com (WordPress.org REST API)
Post types:   post, page
Output format: md
Request delay: 500ms

Posts... 42 saved → ./post/
Pages... 8 saved → ./page/

Done.
```

For a WordPress.com site the label will read `WordPress.com API`. For DOCX aggregate:

```text
Pulling from: https://example.com (WordPress.org REST API)
Post types:   post, page
Output format: docx (aggregate)
Request delay: 500ms

Posts... 42 collected
Pages... 8 collected
Aggregate saved → ./example.com.docx

Done.
```

Exit code 0. Individual files go in `<outputDir>/<hostname>/<postType>/` (layout `type`) or `<outputDir>/<hostname>/<url-path>/` (layout `url`). Aggregate files are named after the site hostname (`example.com.md`, `example.com.docx`, `example.com.html`) and written directly to the output root.

To spot-check a file:

```bash
head -8 site-content/post/hello-world.md
```

## Failure modes

**`HTTP 401: ...`**
— Credentials are wrong, missing, or the Application Password was revoked. Verify the credentials file key matches the exact normalized URL (`no trailing slash, lowercase`), or pass `--user`/`--pass` inline.

**`HTTP 403: ...`**
— The authenticated user lacks permission to read the post type. Check the user's role in WordPress.

**`HTTP 404` on `/wp-json/wp/v2/types`**
— The REST API is disabled or blocked (security plugin, custom `rest_authentication_errors` filter). Verify the site exposes `/wp-json/`.

**`No matching post types found.`**
— The slugs passed to `--types` don't match any registered REST-accessible post types. Run without `--types` first to see what's available, then filter.

**Post type listed but `skipped (...)`**
— The REST API returned a non-2xx for that post type's endpoint (e.g. a custom type requiring authentication). Check the error message in parentheses.

**Empty output directory**
— All post types returned 0 items. The site may have no published content, or all content may require authentication.

**`node: command not found` / `SyntaxError`**
— Node.js not installed or version below 18. `node --version` to check; need 18+ for native `fetch`.

## Rate limiting

Default delay is 500ms between every request. For local/dev sites pass `--delay 0`. For production sites under load, use `--delay 1000` or higher to be courteous. The delay applies between pagination pages within a post type AND between post types.
