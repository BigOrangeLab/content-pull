---
name: content-pull
description: "Pull all public content from a WordPress site via REST API and save as Markdown or Word files. Use when an agent needs to ingest, archive, process, or round-trip-edit WordPress post content programmatically."
compatibility: "Any WordPress site with REST API enabled (default since WP 4.7), or any WordPress.com-hosted site. Requires Node.js 18+."
license: GPL-2.0-or-later
metadata:
    author: georgestephanis
    version: "1.1"
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

Do NOT use the `auth` subcommand in agentic contexts — it opens a browser. See [Credentials (non-interactive)](#credentials-non-interactive) below.

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
| `--format` | `-f` | `md` | Output format: `md` or `docx` |
| `--aggregate` | `-a` | off | Combine all posts into one file |
| `--user` | `-u` | from creds file | WordPress username |
| `--pass` | `-p` | from creds file | WordPress application password |
| `--delay` | `-d` | `500` | Ms between HTTP requests |

### 4. WordPress.com sites

Sites hosted on WordPress.com are supported without any extra flags. The tool detects `*.wordpress.com` hostnames automatically and uses the WordPress.com REST API (`https://public-api.wordpress.com/rest/v1.1/`). For self-hosted sites with the `.org` REST API disabled, the tool tries `.org` first and silently falls back to the WordPress.com API.

WordPress.com public content requires no credentials.

### 5. Understand the output

Files are written to `<outputDir>/<postType>/<slug>.md`. Each file has YAML frontmatter followed by the post body as Markdown:

```
site-content/
  post/
    hello-world.md
    my-second-post.md
  page/
    about.md
    contact.md
  event/          ← custom post types are included automatically
    conference-2025.md
```

Frontmatter fields on every file:

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

Pass `--format docx` to write Word documents instead of Markdown. Combined with `--aggregate`, this produces a single `content.docx` — useful for handing off to a human editor.

```bash
# Single Word document of all posts and pages
node index.js https://example.com --output ./out --format docx --aggregate --types post,page --delay 0
```

Each post in the DOCX begins with a `ContentPullMeta` paragraph — a small grey monospaced line containing a JSON object:

```
{"slug":"hello-world","type":"post","link":"https://example.com/hello-world/","date":"2024-01-15T09:30:00","modified":"2024-06-01T14:22:00"}
```

In an aggregate DOCX, every post except the first starts on a new page. The `ContentPullMeta` line persists after editing and is the hook for parsing changes back out (see [Round-trip workflow](#round-trip-workflow) below).

### 7. Aggregate Markdown

Pass `--aggregate` (without `--format docx`) to write a single `content.md`. Posts are separated by `---` rules; each opens with `## <title>` and a metadata line.

### 8. Post types skipped by default

These WordPress-internal types are always skipped regardless of `--types`:

`attachment`, `nav_menu_item`, `wp_block`, `wp_navigation`, `wp_template`, `wp_template_part`, `wp_global_styles`, `wp_font_family`, `wp_font_face`

To skip additional internal types, edit `SKIP_TYPES` in `index.js`.

## Round-trip workflow

This workflow lets a human editor revise content in Word and have those changes pushed back to WordPress.

### Step 1 — Pull to DOCX

```bash
node index.js https://example.com --output ./review --format docx --aggregate --types post,page
# → ./review/content.docx
```

### Step 2 — Human edits the document

The editor opens `content.docx`, rewrites body text, and saves. They must not delete or edit the grey `ContentPullMeta` lines — those are the post identifiers.

### Step 3 — Parse the edited DOCX

A DOCX file is a ZIP archive. The content lives in `word/document.xml`. Each post section is delimited by a paragraph whose style is `ContentPullMeta` (XML: `<w:pStyle w:val="ContentPullMeta"/>`).

**Algorithm:**

1. Unzip the `.docx` and parse `word/document.xml` as XML.
2. Walk all `<w:p>` (paragraph) elements.
3. When a `<w:p>` has `<w:pStyle w:val="ContentPullMeta"/>` in its `<w:pPr>`, read the text content of that paragraph — it is the JSON metadata object.
4. Collect all following paragraphs as content until the next `ContentPullMeta` paragraph or end of document.

**Minimal example using `fast-xml-parser` and `jszip`:**

```js
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { readFileSync } from 'fs';

const zip = await JSZip.loadAsync(readFileSync('./review/content.docx'));
const xml = await zip.file('word/document.xml').async('string');

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
const doc = parser.parse(xml);
const paragraphs = doc['w:document']['w:body']['w:p'];

const posts = [];
let current = null;

for (const para of [].concat(paragraphs)) {
  const style = para['w:pPr']?.['w:pStyle']?.['@_w:val'];
  const text = [].concat(para['w:r'] ?? [])
    .map(r => [].concat(r['w:t'] ?? []).join(''))
    .join('');

  if (style === 'ContentPullMeta') {
    if (current) posts.push(current);
    current = { meta: JSON.parse(text), paragraphs: [] };
  } else if (current && text.trim()) {
    current.paragraphs.push(text);
  }
}
if (current) posts.push(current);
```

Each entry in `posts` has:
- `meta.slug` — WordPress post slug
- `meta.type` — post type (e.g. `post`, `page`)
- `meta.link` — canonical URL on the site
- `meta.date` / `meta.modified` — original timestamps
- `paragraphs` — edited content as plain-text lines

### Step 4 — Push changes back to WordPress

Use the WordPress REST API with the stored credentials to update each post:

```js
for (const { meta, paragraphs } of posts) {
  const content = paragraphs.join('\n\n');
  await fetch(`${siteUrl}/wp-json/wp/v2/${meta.type}s?slug=${meta.slug}`)
    .then(r => r.json())
    .then(([post]) => fetch(`${siteUrl}/wp-json/wp/v2/${meta.type}s/${post.id}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: basicAuthHeader,
      },
      body: JSON.stringify({ content }),
    }));
}
```

> **Note:** The content pushed back is plain text (inline formatting was stripped during DOCX generation). If preserving HTML structure on the way back matters, convert the paragraph text to HTML before posting, or use a Markdown-to-HTML step.

## Verification

Successful run prints:

```
Pulling from: https://example.com (WordPress.org REST API)
Post types:   post, page
Output format: md
Request delay: 500ms

Posts... 42 saved → ./post/
Pages... 8 saved → ./page/

Done.
```

For a WordPress.com site the label will read `WordPress.com API`. For DOCX aggregate:

```
Pulling from: https://example.com (WordPress.org REST API)
Post types:   post, page
Output format: docx (aggregate)
Request delay: 500ms

Posts... 42 collected
Pages... 8 collected
Aggregate saved → ./content.docx

Done.
```

Exit code 0. For Markdown: each listed post type has a subdirectory containing `.md` files (or `content.md` in the output root with `--aggregate`). For DOCX: individual `.docx` files per post type directory, or `content.docx` in the output root with `--aggregate`.

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
