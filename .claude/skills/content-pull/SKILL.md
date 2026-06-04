---
name: content-pull
description: "Pull all public content from a WordPress site via REST API and save as Markdown files. Use when an agent needs to ingest, archive, or process WordPress post content programmatically."
compatibility: "Any WordPress site with REST API enabled (default since WP 4.7). Requires Node.js 18+."
license: GPL-2.0-or-later
metadata:
    author: georgestephanis
    version: "1.0"
    written: "2026-06-04"
    written_against:
        content-pull: "1.0.0"
        node: "18"
---

# content-pull

`content-pull` fetches all publicly available post types from a WordPress site via the REST API and writes each post as a Markdown file with YAML frontmatter. It is a single-file Node.js CLI — no build step.

## When to use

- Ingesting WordPress content for downstream processing (search indexing, LLM context, static site generation)
- Archiving or mirroring a WordPress site's content as flat files
- Feeding post content into another workflow that expects Markdown

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
| `--user` | `-u` | from creds file | WordPress username |
| `--pass` | `-p` | from creds file | WordPress application password |
| `--delay` | `-d` | `500` | Ms between HTTP requests |

### 4. Understand the output

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

### 5. Post types skipped by default

These WordPress-internal types are always skipped regardless of `--types`:

`attachment`, `nav_menu_item`, `wp_block`, `wp_navigation`, `wp_template`, `wp_template_part`, `wp_global_styles`, `wp_font_family`, `wp_font_face`

To skip additional internal types, edit `SKIP_TYPES` in `index.js`.

## Verification

Successful run prints:

```
Pulling from: https://example.com
Post types:   post, page
Request delay: 500ms

Posts... 42 saved → ./post/
Pages... 8 saved → ./page/

Done.
```

Exit code 0. Each listed post type has a subdirectory containing `.md` files.

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
