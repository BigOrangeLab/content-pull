#!/usr/bin/env node

import { writeFileSync, mkdirSync, utimesSync, readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { createServer } from 'http';
import { spawn } from 'child_process';
import { URL } from 'url';
import TurndownService from 'turndown';
import { Document, Packer, Paragraph, HeadingLevel, PageBreak } from 'docx';

const USER_AGENT = 'content-pull/1.0.0 (https://github.com/bigorangelab/content-pull)';
const DEFAULT_DELAY_MS = 500;
const WPCOM_API = 'https://public-api.wordpress.com/rest/v1.1';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// WordPress internal types that aren't useful as content
const SKIP_TYPES = new Set([
  'attachment', 'nav_menu_item', 'wp_block', 'wp_navigation',
  'wp_template', 'wp_template_part', 'wp_global_styles',
  'wp_font_family', 'wp_font_face',
]);

const CREDS_FILE = join(homedir(), '.content-pull', 'credentials.json');

function normalizeUrl(url) {
  return url.replace(/\/$/, '').toLowerCase();
}

function loadCredentials(siteUrl) {
  if (!existsSync(CREDS_FILE)) return null;
  const all = JSON.parse(readFileSync(CREDS_FILE, 'utf8'));
  return all[normalizeUrl(siteUrl)] ?? null;
}

function saveCredentials(siteUrl, { user, pass }) {
  mkdirSync(join(homedir(), '.content-pull'), { recursive: true });
  const all = existsSync(CREDS_FILE)
    ? JSON.parse(readFileSync(CREDS_FILE, 'utf8'))
    : {};
  all[normalizeUrl(siteUrl)] = { user, pass };
  writeFileSync(CREDS_FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
}

function basicAuth(user, pass) {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open';
  spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
}

async function apiFetch(url, authHeader) {
  const headers = { Accept: 'application/json', 'User-Agent': USER_AGENT };
  if (authHeader) headers.Authorization = authHeader;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return { body: await res.json(), headers: res.headers };
}

async function fetchAll(apiBase, restBase, authHeader, delay) {
  const items = [];
  let page = 1;
  while (true) {
    if (page > 1) await sleep(delay);
    const { body, headers } = await apiFetch(
      `${apiBase}/${restBase}?per_page=100&page=${page}&_fields=slug,date,modified,title,content,link`,
      authHeader
    );
    if (!Array.isArray(body) || body.length === 0) break;
    items.push(...body);
    const totalPages = parseInt(headers.get('X-WP-TotalPages') ?? '1', 10);
    if (page >= totalPages) break;
    page++;
  }
  return items;
}

// --- WordPress.com REST API ---

function normalizeWpcomPost(post) {
  return {
    slug: post.slug,
    date: post.date,
    modified: post.modified ?? post.date,
    link: post.URL,
    title: { rendered: post.title },
    content: { rendered: post.content },
  };
}

async function getWpcomTypes(siteId) {
  const { body } = await apiFetch(`${WPCOM_API}/sites/${siteId}/post-types/`);
  return Object.values(body.post_types ?? {})
    .filter(t => t.api_queryable && !SKIP_TYPES.has(t.name))
    .map(t => ({ slug: t.name, name: t.label, rest_base: t.name }));
}

async function fetchAllWpcom(siteId, typeSlug, delay) {
  const items = [];
  let offset = 0;
  while (true) {
    if (offset > 0) await sleep(delay);
    const { body } = await apiFetch(
      `${WPCOM_API}/sites/${siteId}/posts/?type=${typeSlug}&status=publish&number=100&offset=${offset}&fields=slug,date,modified,title,content,URL`
    );
    const posts = body.posts ?? [];
    if (posts.length === 0) break;
    items.push(...posts.map(normalizeWpcomPost));
    offset += posts.length;
    if (offset >= (body.found ?? 0)) break;
  }
  return items;
}

// --- Auth subcommand ---

async function doAuth(siteUrl) {
  const baseUrl = siteUrl.replace(/\/$/, '');

  const { body: root } = await apiFetch(`${baseUrl}/wp-json/`);
  const authEndpoint = root?.authentication?.['application-passwords']?.endpoints?.authorization;

  if (!authEndpoint) {
    console.error('Site does not support Application Passwords or REST API is not accessible.');
    process.exit(1);
  }

  await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const reqUrl = new URL(req.url, 'http://localhost');
      const user = reqUrl.searchParams.get('user_login');
      const pass = reqUrl.searchParams.get('password');

      if (user && pass) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Authenticated!</h1><p>You can close this tab.</p></body></html>');
        server.close();
        saveCredentials(siteUrl, { user, pass });
        console.log(`\nAuthenticated as: ${user}`);
        console.log(`Credentials saved for: ${baseUrl}`);
        resolve();
      } else {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing credentials — auth may have been cancelled.');
        server.close();
        reject(new Error('Auth cancelled or failed.'));
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const successUrl = `http://localhost:${port}/`;
      const authUrl = `${authEndpoint}?app_name=${encodeURIComponent('content-pull')}&success_url=${encodeURIComponent(successUrl)}`;

      console.log('Opening browser for authentication...');
      console.log(`If it does not open automatically, visit:\n${authUrl}\n`);
      openBrowser(authUrl);
    });

    server.on('error', reject);
  });
}

// --- DOCX helpers ---

function stripInlineMarkdown(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    .replace(/`(.+?)`/g, '$1');
}

function markdownToDocxParagraphs(md) {
  const paragraphs = [];
  for (const line of md.split('\n')) {
    const t = line.trim();
    if (!t || t === '---') continue;
    if (t.startsWith('### ')) {
      paragraphs.push(new Paragraph({ text: t.slice(4), heading: HeadingLevel.HEADING_3 }));
    } else if (t.startsWith('## ')) {
      paragraphs.push(new Paragraph({ text: t.slice(3), heading: HeadingLevel.HEADING_2 }));
    } else if (t.startsWith('# ')) {
      paragraphs.push(new Paragraph({ text: t.slice(2), heading: HeadingLevel.HEADING_1 }));
    } else {
      paragraphs.push(new Paragraph({ text: stripInlineMarkdown(t) }));
    }
  }
  return paragraphs;
}

async function buildDocx(paragraphs) {
  const doc = new Document({ sections: [{ children: paragraphs }] });
  return Packer.toBuffer(doc);
}

// --- Serialisers ---

function writeItemMarkdown(item, td, dir) {
  const title = item.title?.rendered?.replace(/<[^>]+>/g, '') ?? item.slug;
  const md = td.turndown(item.content?.rendered ?? '');
  const frontmatter = [
    '---',
    `title: ${JSON.stringify(title)}`,
    `date: ${item.date}`,
    `modified: ${item.modified}`,
    `link: ${item.link}`,
    '---',
    '',
  ].join('\n');
  const filePath = join(dir, `${item.slug}.md`);
  writeFileSync(filePath, `${frontmatter}\n${md}\n`);
  const mtime = new Date(item.modified);
  utimesSync(filePath, mtime, mtime);
}

async function writeItemDocx(item, td, dir) {
  const title = item.title?.rendered?.replace(/<[^>]+>/g, '') ?? item.slug;
  const md = td.turndown(item.content?.rendered ?? '');
  const paragraphs = [
    new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ text: `${item.date} | ${item.link}` }),
    ...markdownToDocxParagraphs(md),
  ];
  const buf = await buildDocx(paragraphs);
  writeFileSync(join(dir, `${item.slug}.docx`), buf);
}

async function writeAggregate(allCollected, outputDir, format, td) {
  if (format === 'docx') {
    const paragraphs = [];
    for (const { typeName, items } of allCollected) {
      paragraphs.push(new Paragraph({ text: typeName, heading: HeadingLevel.HEADING_1 }));
      for (const item of items) {
        const title = item.title?.rendered?.replace(/<[^>]+>/g, '') ?? item.slug;
        const md = td.turndown(item.content?.rendered ?? '');
        paragraphs.push(new Paragraph({ text: title, heading: HeadingLevel.HEADING_2 }));
        paragraphs.push(new Paragraph({ text: `${item.date} | ${item.link}` }));
        paragraphs.push(...markdownToDocxParagraphs(md));
        paragraphs.push(new Paragraph({ children: [new PageBreak()] }));
      }
    }
    const buf = await buildDocx(paragraphs);
    writeFileSync(join(outputDir, 'content.docx'), buf);
    console.log(`Aggregate saved → ./content.docx`);
  } else {
    const sections = [];
    for (const { typeName, items } of allCollected) {
      sections.push(`# ${typeName}\n`);
      for (const item of items) {
        const title = item.title?.rendered?.replace(/<[^>]+>/g, '') ?? item.slug;
        const md = td.turndown(item.content?.rendered ?? '');
        sections.push([
          `## ${title}`,
          `date: ${item.date} | modified: ${item.modified} | link: ${item.link}`,
          '',
          md,
        ].join('\n'));
      }
    }
    writeFileSync(join(outputDir, 'content.md'), sections.join('\n\n---\n\n') + '\n');
    console.log(`Aggregate saved → ./content.md`);
  }
}

// --- Pull subcommand ---

async function doPull(siteUrl, opts) {
  const baseUrl = siteUrl.replace(/\/$/, '');
  const { hostname } = new URL(baseUrl);
  const outputDir = resolve(opts.output);
  const format = opts.format ?? 'md';
  const aggregate = opts.aggregate ?? false;
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  const delay = opts.delay ?? DEFAULT_DELAY_MS;

  let authHeader = null;
  if (opts.user && opts.pass) {
    authHeader = basicAuth(opts.user, opts.pass);
  } else {
    const stored = loadCredentials(siteUrl);
    if (stored) authHeader = basicAuth(stored.user, stored.pass);
  }

  // Detect which API to use: wpcom-hosted sites go straight to the .com API;
  // everything else tries the .org REST API first and falls back to .com.
  let postTypes, fetchItems, apiLabel;
  const preferWpcom = hostname.endsWith('.wordpress.com');

  if (!preferWpcom) {
    try {
      const apiBase = `${baseUrl}/wp-json/wp/v2`;
      const { body: types } = await apiFetch(`${apiBase}/types`, authHeader);
      postTypes = Object.values(types).filter(t => t.rest_base && !SKIP_TYPES.has(t.slug));
      fetchItems = type => fetchAll(apiBase, type.rest_base, authHeader, delay);
      apiLabel = 'WordPress.org REST API';
    } catch {
      console.log('WordPress.org REST API unavailable, trying WordPress.com API...');
    }
  }

  if (!postTypes) {
    postTypes = await getWpcomTypes(hostname);
    fetchItems = type => fetchAllWpcom(hostname, type.slug, delay);
    apiLabel = 'WordPress.com API';
  }

  if (opts.types) {
    postTypes = postTypes.filter(t => opts.types.includes(t.slug));
  }

  if (postTypes.length === 0) {
    console.error('No matching post types found.');
    process.exit(1);
  }

  console.log(`Pulling from: ${baseUrl} (${apiLabel})`);
  console.log(`Post types:   ${postTypes.map(t => t.slug).join(', ')}`);
  console.log(`Output format: ${format}${aggregate ? ' (aggregate)' : ''}`);
  console.log(`Request delay: ${delay}ms\n`);

  mkdirSync(outputDir, { recursive: true });

  const allCollected = [];

  for (let i = 0; i < postTypes.length; i++) {
    if (i > 0) await sleep(delay);
    const type = postTypes[i];
    process.stdout.write(`${type.name}... `);
    let items;
    try {
      items = await fetchItems(type);
    } catch (e) {
      console.log(`skipped (${e.message})`);
      continue;
    }

    if (items.length === 0) {
      console.log('0 items');
      continue;
    }

    if (aggregate) {
      allCollected.push({ typeName: type.name, typeSlug: type.slug, items });
      console.log(`${items.length} collected`);
    } else {
      const dir = join(outputDir, type.slug);
      mkdirSync(dir, { recursive: true });
      for (const item of items) {
        if (format === 'docx') {
          await writeItemDocx(item, td, dir);
        } else {
          writeItemMarkdown(item, td, dir);
        }
      }
      console.log(`${items.length} saved → ./${type.slug}/`);
    }
  }

  if (aggregate && allCollected.length > 0) {
    await writeAggregate(allCollected, outputDir, format, td);
  }

  console.log('\nDone.');
}

// --- CLI entry point ---

const USAGE = `
Usage:
  content-pull <url> [options]    Pull content from a WordPress site
  content-pull auth <url>         Authenticate via Application Passwords

Options:
  --output,    -o <dir>    Output directory (default: current directory)
  --types,     -t <list>   Comma-separated post types (default: all public)
  --format,    -f <fmt>    Output format: md (default) or docx
  --aggregate, -a          Combine all posts into a single file
  --user,      -u <name>   WordPress username (overrides stored credentials)
  --pass,      -p <pass>   WordPress application password
  --delay,     -d <ms>     Milliseconds to wait between requests (default: ${DEFAULT_DELAY_MS})
`.trim();

const args = process.argv.slice(2);
const opts = { output: '.', types: null, format: 'md', aggregate: false, user: null, pass: null, delay: null };
const positional = [];

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--output':    case '-o': opts.output = args[++i]; break;
    case '--types':     case '-t': opts.types = args[++i].split(',').map(s => s.trim()); break;
    case '--format':    case '-f': opts.format = args[++i]; break;
    case '--aggregate': case '-a': opts.aggregate = true; break;
    case '--user':      case '-u': opts.user = args[++i]; break;
    case '--pass':      case '-p': opts.pass = args[++i]; break;
    case '--delay':     case '-d': opts.delay = parseInt(args[++i], 10); break;
    default:
      if (!args[i].startsWith('-')) positional.push(args[i]);
  }
}

const subcommand = positional[0];
const urlArg = positional[1] ?? positional[0];

if (!urlArg) {
  console.error(USAGE);
  process.exit(1);
}

if (subcommand === 'auth') {
  doAuth(urlArg).catch(e => { console.error(e.message); process.exit(1); });
} else {
  doPull(urlArg, opts).catch(e => { console.error(e.message); process.exit(1); });
}
