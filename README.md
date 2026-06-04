# WordPress Content Pull

A CLI tool that pulls all public content from a WordPress site via the REST API and saves it as Markdown files. Content is fetched in its fully rendered form — shortcodes are parsed, blocks are rendered — not as raw block markup.

## Requirements

- Node.js 18 or later (for native `fetch`)
- A WordPress site with the REST API enabled (default on all WordPress sites since 4.7), or a WordPress.com-hosted site

## Installation

### Via npx (no install required)

```bash
npx github:bigorangelab/content-pull https://example.com
```

### Cloned locally

```bash
git clone https://github.com/bigorangelab/content-pull
cd content-pull
npm install
node index.js https://example.com
```

### Installed globally

```bash
npm install -g github:bigorangelab/content-pull
content-pull https://example.com
```

## Usage

### Pull public content (no authentication required)

```bash
node index.js <url>
```

This fetches all publicly available post types — posts, pages, and any custom post types registered with the REST API — and saves them as Markdown files. Files are grouped by post type inside a folder named after the site domain:

```text
./example.com/
  post/
    hello-world.md
    my-second-post.md
  page/
    about.md
    contact.md
  product/         ← custom post types too
    widget-pro.md
```

With `--layout url`, files follow the canonical URL path of each post instead:

```text
./example.com/
  blog/
    hello-world/
      index.md
  about/
    index.md
```

### Options

| Flag | Short | Description |
|------|-------|-------------|
| `--output <dir>` | `-o` | Directory to write files into (default: current directory) |
| `--types <list>` | `-t` | Comma-separated post type slugs to pull (default: all public types) |
| `--format <fmt>` | `-f` | Output format: `md` (default), `html`, or `docx` |
| `--layout <mode>` | `-l` | File layout: `type` (default) or `url` |
| `--aggregate` | `-a` | Combine all posts into a single file named after the site domain |
| `--user <name>` | `-u` | WordPress username (overrides stored credentials) |
| `--pass <pass>` | `-p` | WordPress application password (overrides stored credentials) |
| `--delay <ms>` | `-d` | Milliseconds to wait between requests (default: `500`) |

### Examples

```bash
# Pull everything as Markdown, grouped by post type
node index.js https://example.com --output ./out
# → ./out/example.com/post/hello-world.md

# Mirror the site's URL structure
node index.js https://example.com --layout url --output ./out
# → ./out/example.com/blog/hello-world/index.md

# Pull only posts and pages
node index.js https://example.com --types post,page

# Pull as a single aggregated Markdown file (named after the site)
node index.js https://example.com --aggregate --output ./out
# → ./out/example.com.md

# Pull as individual Word documents
node index.js https://example.com --format docx --output ./out
# → ./out/example.com/post/hello-world.docx

# Pull as a single Word document (useful for editorial review)
node index.js https://example.com --format docx --aggregate --output ./out
# → ./out/example.com.docx

# Pull as raw HTML files mirroring the URL structure
node index.js https://example.com --format html --layout url --output ./out
# → ./out/example.com/blog/hello-world/index.html

# Pull with explicit credentials
node index.js https://example.com --user george --pass abcd-efgh-ijkl-mnop

# Slow down requests for a heavily loaded site
node index.js https://example.com --delay 1000

# Speed up requests for a local or dedicated dev site
node index.js https://example.com --delay 0
```

## Authentication

Authentication is optional for public content. If your site has private posts, custom post types restricted to logged-in users, or you want to pull draft content, you can authenticate using [WordPress Application Passwords](https://make.wordpress.org/core/2020/11/05/application-passwords-integration-guide/) (built into WordPress since 5.6).

### Interactive auth (recommended)

```bash
node index.js auth https://example.com
```

This will:

1. Look up the Application Passwords authorization endpoint from your site's REST API
2. Open your browser to the WordPress authorization screen
3. Start a local callback server to receive the credentials after you approve
4. Save the credentials to `~/.content-pull/credentials.json` (permissions: `0600`)

Once authenticated, subsequent `content-pull` runs against that site will use the stored credentials automatically.

### Manual credentials

If you'd rather create an Application Password manually (via **Users → Profile → Application Passwords** in wp-admin), pass them directly:

```bash
node index.js https://example.com --user george --pass "abcd efgh ijkl mnop"
```

Application passwords contain spaces when displayed in wp-admin — either quote them or remove the spaces when passing on the command line.

### Stored credentials

Credentials are stored in `~/.content-pull/credentials.json`, keyed by site URL. The file is written with mode `0600`. You can inspect or edit it directly to remove or update entries.

```json
{
  "https://example.com": {
    "user": "george",
    "pass": "abcd efgh ijkl mnop"
  }
}
```

## Output format

### Markdown (default)

Each file is saved as `<domain>/<post-type>/<slug>.md` (layout `type`) or `<domain>/<url-path>/index.md` (layout `url`), with YAML frontmatter:

```markdown
---
title: "Hello World"
date: 2024-01-15T09:30:00
modified: 2024-06-01T14:22:00
link: https://example.com/hello-world/
---

This is the post content, converted from HTML to Markdown.

## Heading

Paragraph text, **bold**, _italic_, [links](https://example.com), etc.
```

File modification times (`mtime`) are set to match the post's `modified` date from WordPress, so the filesystem timestamps reflect when content was last updated on the site.

With `--aggregate`, a single file named after the site hostname (e.g. `example.com.md`) is written to the output directory. Posts are separated by `---` rules and each opens with `## <title>` and a metadata line.

### HTML (`--format html`)

Each post is saved as a self-contained `.html` file with `<meta>` tags for date, modified, and canonical URL. The path follows the active `--layout` setting. With `--aggregate`, a single `example.com.html` is written containing all posts as `<article>` elements, each with a `data-content-pull-meta` attribute carrying the same JSON object used by DOCX delimiters.

### Word documents (`--format docx`)

Each post is saved as a `.docx` file. The path follows the active `--layout` setting. With `--aggregate`, a single `example.com.docx` is written. Content is converted directly from WordPress's rendered HTML — headings, paragraphs, bold, italic, links, and tables are preserved; images are skipped.

Each post begins with a `ContentPullMeta` paragraph — a small grey monospaced line containing a JSON object that identifies the post:

```json
{"slug":"hello-world","type":"post","link":"https://example.com/hello-world/","date":"2024-01-15T09:30:00","modified":"2024-06-01T14:22:00"}
```

In an aggregate DOCX, every post (except the first) starts on a new page. The `ContentPullMeta` line is the machine-readable delimiter that marks the beginning of each post's content and is preserved even after a human edits the document.

## Round-trip editing

The `reimport` subcommand applies an edited DOCX back to WordPress. It diffs the original and edited documents at the paragraph level, maps changes to Gutenberg blocks in the post source, and pushes updates via the REST API.

```bash
content-pull reimport https://example.com original.docx edited.docx [--dry-run]
```

### How it works

1. Both DOCXs are parsed and split on `ContentPullMeta` paragraphs to identify each post
2. A paragraph-level LCS diff finds what changed, was added, or was removed per post
3. For each changed paragraph, the tool fetches the post's raw block source (`content.raw`, requires auth) and finds the matching Gutenberg block by text comparison
4. **Simple changes** (plain text swap in a leaf block) are applied programmatically
5. **Complex changes** (rich inline HTML, additions, deletions) are sent to an LLM to determine the correct block edit
6. Changes where LLM confidence is below 90% are written to `reimport-review.json` for human or agent review

### LLM configuration

Set one of these to enable LLM-assisted merging:

| Variable | Effect |
|----------|--------|
| `ANTHROPIC_API_KEY` | Use Anthropic Claude (`claude-sonnet-4-6`) |
| `OPENAI_API_KEY` | Use OpenAI (`gpt-4o` by default) |
| `OPENAI_BASE_URL` | Point at any OpenAI-compatible endpoint (Ollama, vLLM, LM Studio) |
| `OPENAI_MODEL` | Override the model name (e.g. `llama3`, `mistral`) |

```bash
# Anthropic
ANTHROPIC_API_KEY=sk-ant-... content-pull reimport https://example.com original.docx edited.docx

# Ollama (no API key needed)
OPENAI_BASE_URL=http://localhost:11434/v1 OPENAI_MODEL=llama3 \
  content-pull reimport https://example.com original.docx edited.docx
```

Without any LLM configured, only programmatic matches are applied; everything else goes to the review file.

### How delimiters work

Each post in a generated DOCX begins with a `ContentPullMeta`-styled paragraph (grey monospace text) containing a JSON object:

```json
{"slug":"hello-world","type":"post","link":"https://example.com/hello-world/","date":"2024-01-15T09:30:00","modified":"2024-06-01T14:22:00"}
```

The equivalent in HTML aggregate output is `<article data-content-pull-meta='{"slug":...}'>`. Both are preserved through editing and are what `reimport` uses to match content back to WordPress posts.

## Post types

By default, all post types registered with the REST API are pulled, except for WordPress-internal types that don't represent user content:

- `attachment` (media library)
- `nav_menu_item` (navigation menus)
- `wp_block` (reusable blocks)
- `wp_navigation` (navigation post type)
- `wp_template` / `wp_template_part` (block theme templates)
- `wp_global_styles` (theme style variations)
- `wp_font_family` / `wp_font_face` (font management)

To pull only specific types, use `--types`:

```bash
node index.js https://example.com --types post,page,event
```

## WordPress.com sites

Sites hosted on WordPress.com (`*.wordpress.com` or custom domains on the WordPress.com platform) are supported automatically. For `*.wordpress.com` hostnames the tool uses the WordPress.com REST API (`public-api.wordpress.com`) directly. For self-hosted sites, it tries the standard WordPress REST API first and falls back to the WordPress.com API if the REST API is unavailable (e.g. disabled by a security plugin, or the site is behind Jetpack).

WordPress.com public content requires no authentication.

## How it works

1. Detects which API to use: `.wordpress.com` hostnames use the WordPress.com REST API; all others try the WordPress REST API (`/wp-json/wp/v2/`) and fall back to WordPress.com if that fails
2. Fetches the list of post types and filters out WordPress-internal types
3. For each post type, paginates through all published posts (100 per page)
4. Requests rendered HTML content — shortcodes, blocks, and dynamic content are fully resolved
5. Converts the HTML to Markdown using [Turndown](https://github.com/mixmark-io/turndown), or builds Word document paragraphs for `--format docx`
6. Writes output files and sets each file's `mtime` to the post's last modified date

## License

GPL-2.0-or-later
