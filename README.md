# WordPress Content Pull

A CLI tool that pulls all public content from a WordPress site via the REST API and saves it as Markdown files. Content is fetched in its fully rendered form — shortcodes are parsed, blocks are rendered — not as raw block markup.

## Requirements

- Node.js 18 or later (for native `fetch`)
- A WordPress site with the REST API enabled (default on all WordPress sites since 4.7)

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

This fetches all publicly available post types — posts, pages, and any custom post types registered with the REST API — and saves them as Markdown files in subdirectories of the current working directory.

```
./post/
  hello-world.md
  my-second-post.md
./page/
  about.md
  contact.md
./product/         ← custom post types too
  widget-pro.md
```

### Options

| Flag | Short | Description |
|------|-------|-------------|
| `--output <dir>` | `-o` | Directory to write files into (default: current directory) |
| `--types <list>` | `-t` | Comma-separated post type slugs to pull (default: all public types) |
| `--user <name>` | `-u` | WordPress username (overrides stored credentials) |
| `--pass <pass>` | `-p` | WordPress application password (overrides stored credentials) |
| `--delay <ms>` | `-d` | Milliseconds to wait between requests (default: `500`) |

### Examples

```bash
# Pull everything into the current directory
node index.js https://example.com

# Pull into a specific output directory
node index.js https://example.com --output ./site-backup

# Pull only posts and pages
node index.js https://example.com --types post,page

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

Each file is saved as `<post-type>/<slug>.md` with YAML frontmatter:

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

## How it works

1. Fetches `/wp-json/wp/v2/types` to discover all post types registered with the REST API
2. For each post type, paginates through all posts using `?per_page=100` with the `X-WP-TotalPages` header
3. Requests `content.rendered` — the server-side rendered HTML, with all shortcodes, blocks, and dynamic content resolved
4. Converts the HTML to Markdown using [Turndown](https://github.com/mixmark-io/turndown)
5. Writes each post as `<type>/<slug>.md` with YAML frontmatter and sets the file `mtime` to the post's last modified date

## License

GPL-2.0-or-later
