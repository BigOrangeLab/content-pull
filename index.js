#!/usr/bin/env node

import { writeFileSync, mkdirSync, utimesSync, readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { createServer } from 'http';
import { spawn } from 'child_process';
import { URL } from 'url';
import TurndownService from 'turndown';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { Document, Packer, Paragraph, HeadingLevel, TextRun, ExternalHyperlink } from 'docx';
import JSZip from 'jszip';
import { parse as parseHtml } from 'node-html-parser';

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

function decodeHtmlEntities(str) {
  return str
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ');
}

function plainText(html) {
  return decodeHtmlEntities((html ?? '').replace(/<[^>]+>/g, ''));
}

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

async function apiFetch(url, authHeader, method = 'GET', data = null) {
  const headers = { Accept: 'application/json', 'User-Agent': USER_AGENT };
  if (authHeader) headers.Authorization = authHeader;
  if (data) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: data ? JSON.stringify(data) : undefined });
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

// --- Reimport helpers ---

function normText(t) {
  return t.replace(/\s+/g, ' ').trim().toLowerCase();
}

const decodeXmlEntities = decodeHtmlEntities;

function parseDocxXml(xml) {
  const paras = [];
  for (const [pXml] of xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    const styleMatch = pXml.match(/<w:pStyle w:val="([^"]+)"/);
    const texts = [];
    for (const [, t] of pXml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g))
      texts.push(decodeXmlEntities(t));
    paras.push({ style: styleMatch?.[1] ?? null, text: texts.join('') });
  }
  return paras;
}

async function loadDocxPosts(filePath) {
  const zip = await JSZip.loadAsync(readFileSync(filePath));
  const xml = await zip.file('word/document.xml').async('string');
  const paras = parseDocxXml(xml);
  const posts = [];
  let current = null;
  for (const { style, text } of paras) {
    if (style === 'ContentPullMeta') {
      if (current) posts.push(current);
      try { current = { meta: JSON.parse(text), paragraphs: [] }; } catch { current = null; }
    } else if (current && text.trim()) {
      current.paragraphs.push(text.trim());
    }
  }
  if (current) posts.push(current);
  return posts;
}

function diffParagraphs(orig, edit) {
  const n = orig.length, m = edit.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++)
      dp[i][j] = normText(orig[i - 1]) === normText(edit[j - 1])
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
  const ops = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && normText(orig[i - 1]) === normText(edit[j - 1])) {
      ops.push({ type: 'equal', orig: orig[i - 1], edit: edit[j - 1] }); i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: 'added', edit: edit[j - 1] }); j--;
    } else {
      ops.push({ type: 'removed', orig: orig[i - 1] }); i--;
    }
  }
  ops.reverse();
  const result = [];
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].type === 'removed' && ops[k + 1]?.type === 'added') {
      result.push({ type: 'changed', orig: ops[k].orig, edit: ops[k + 1].edit }); k++;
    } else {
      result.push(ops[k]);
    }
  }
  return result;
}

function parseWpBlocks(raw) {
  const blocks = [];
  for (const open of raw.matchAll(/<!-- wp:([\w/-]+)(?:\s+({[\s\S]*?}))?\s*-->/g)) {
    const name = open[1];
    const closeTag = `<!-- /wp:${name} -->`;
    const contentStart = open.index + open[0].length;
    const closePos = raw.indexOf(closeTag, contentStart);
    if (closePos === -1) continue;
    const innerHTML = raw.slice(contentStart, closePos);
    if (innerHTML.includes('<!-- wp:')) continue;
    blocks.push({
      name,
      innerHTML,
      innerText: stripTags(innerHTML),
      start: open.index,
      end: closePos + closeTag.length,
      raw: raw.slice(open.index, closePos + closeTag.length),
    });
  }
  return blocks;
}

function spliceBlockText(block, newText) {
  const m = block.innerHTML.match(/^(\s*<([\w]+)([^>]*)>)([\s\S]*?)(<\/\2>\s*)$/);
  if (!m) return null;
  const [, open, , , , close] = m;
  const newInner = `${open}${newText}${close}`;
  const innerStart = block.raw.indexOf(block.innerHTML);
  if (innerStart === -1) return null;
  return block.raw.slice(0, innerStart) + newInner + block.raw.slice(innerStart + block.innerHTML.length);
}

function initLlmClient() {
  if (process.env.ANTHROPIC_API_KEY) {
    return { type: 'anthropic', client: new Anthropic(), model: 'claude-sonnet-4-6' };
  }
  const baseURL = process.env.OPENAI_BASE_URL;
  const apiKey = process.env.OPENAI_API_KEY ?? 'no-key'; // local servers often need any non-empty string
  const model = process.env.OPENAI_MODEL ?? (baseURL ? 'llama3' : 'gpt-4o');
  if (process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL) {
    return { type: 'openai', client: new OpenAI({ apiKey, baseURL }), model };
  }
  return null;
}

async function llmMerge(llmClient, change, blockRaw, fullRaw) {
  // Returns { updatedRaw: string, confidence: number, reasoning: string }
  // blockRaw is the specific block if we found one; fullRaw is the entire post content
  const context = blockRaw
    ? `BLOCK TO UPDATE:\n\`\`\`\n${blockRaw}\n\`\`\``
    : `FULL POST BLOCK CONTENT (find and update the right block):\n\`\`\`\n${fullRaw}\n\`\`\``;

  const actionDesc = change.type === 'changed'
    ? `Change this text:\n  FROM: ${change.orig}\n  TO:   ${change.edit}`
    : change.type === 'added'
    ? `Insert this new paragraph at the appropriate position:\n  "${change.edit}"`
    : `Remove the block containing this text:\n  "${change.orig}"`;

  const prompt = `You are a WordPress content migration assistant. Apply an editorial change back to WordPress block markup.

${actionDesc}

${context}

Rules:
- Preserve all block attributes (the JSON in <!-- wp:name {...} -->), CSS classes, and HTML structure
- For a text change, only update the text; preserve inline formatting (bold, italic, links) where it still applies
- For an addition, generate a new wp:paragraph block and insert it in the right place
- For a deletion, remove the entire block containing that text
- Return ${blockRaw ? 'the updated block' : 'the full updated post content'}

Respond using the merge_result tool.`;

  const toolSchema = {
    type: 'object',
    properties: {
      updated:    { type: 'string',  description: 'The updated block or full post content' },
      confidence: { type: 'integer', description: 'Confidence 0–100 that this is correct' },
      reasoning:  { type: 'string',  description: 'Brief explanation and any concerns' },
    },
    required: ['updated', 'confidence', 'reasoning'],
  };

  try {
    if (llmClient.type === 'anthropic') {
      const response = await llmClient.client.messages.create({
        model: llmClient.model,
        max_tokens: 2048,
        tools: [{ name: 'merge_result', description: 'The result of applying the editorial change', input_schema: toolSchema }],
        tool_choice: { type: 'tool', name: 'merge_result' },
        messages: [{ role: 'user', content: prompt }],
      });
      const toolUse = response.content.find(b => b.type === 'tool_use');
      if (!toolUse) throw new Error('No tool_use block in response');
      return toolUse.input;
    } else {
      const response = await llmClient.client.chat.completions.create({
        model: llmClient.model,
        max_tokens: 2048,
        tools: [{ type: 'function', function: { name: 'merge_result', description: 'The result of applying the editorial change', parameters: toolSchema } }],
        tool_choice: { type: 'function', function: { name: 'merge_result' } },
        messages: [{ role: 'user', content: prompt }],
      });
      const toolCall = response.choices[0]?.message?.tool_calls?.[0];
      if (!toolCall) throw new Error('No tool_call in response');
      return JSON.parse(toolCall.function.arguments);
    }
  } catch (e) {
    return { updated: blockRaw ?? fullRaw, confidence: 0, reasoning: `LLM call failed: ${e.message}` };
  }
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

function inlineRuns(node, fmt = {}) {
  const runs = [];
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      const text = decodeHtmlEntities(child.text.replace(/\s+/g, ' '));
      if (text) runs.push(new TextRun({ text, ...fmt }));
    } else if (child.nodeType === 1) {
      const tag = child.tagName?.toLowerCase();
      if (tag === 'strong' || tag === 'b') {
        runs.push(...inlineRuns(child, { ...fmt, bold: true }));
      } else if (tag === 'em' || tag === 'i') {
        runs.push(...inlineRuns(child, { ...fmt, italics: true }));
      } else if (tag === 'a') {
        const href = child.getAttribute('href');
        const inner = inlineRuns(child, fmt);
        if (href && inner.length) {
          runs.push(new ExternalHyperlink({ children: inner, link: href }));
        } else {
          runs.push(...inner);
        }
      } else if (tag === 'code') {
        runs.push(...inlineRuns(child, { ...fmt, font: { name: 'Courier New' } }));
      } else if (tag === 'br') {
        runs.push(new TextRun({ text: '', break: 1 }));
      } else {
        runs.push(...inlineRuns(child, fmt));
      }
    }
  }
  return runs;
}

function htmlToDocxParagraphs(html) {
  const root = parseHtml(html);
  const paras = [];

  function walk(node) {
    if (node.nodeType !== 1) return;
    const tag = node.tagName?.toLowerCase();
    if (!tag) { node.childNodes.forEach(walk); return; }

    const hm = tag.match(/^h([1-6])$/);
    if (hm) {
      const text = decodeHtmlEntities(node.text.replace(/\s+/g, ' ').trim());
      if (text) paras.push(new Paragraph({ text, heading: HeadingLevel[`HEADING_${hm[1]}`] }));
      return;
    }

    switch (tag) {
      case 'p': {
        const runs = inlineRuns(node);
        if (runs.length) paras.push(new Paragraph({ children: runs }));
        break;
      }
      case 'li': {
        const runs = inlineRuns(node);
        if (runs.length) paras.push(new Paragraph({ children: [new TextRun('• '), ...runs] }));
        break;
      }
      case 'pre': {
        for (const line of node.text.split('\n'))
          paras.push(new Paragraph({ children: [new TextRun({ text: line, font: { name: 'Courier New' }, size: 18 })] }));
        break;
      }
      case 'table': {
        for (const row of node.querySelectorAll('tr')) {
          const cells = row.querySelectorAll('td, th');
          const runs = [];
          cells.forEach((cell, i) => {
            if (i > 0) runs.push(new TextRun(' | '));
            runs.push(...inlineRuns(cell));
          });
          if (runs.length) paras.push(new Paragraph({ children: runs }));
        }
        break;
      }
      case 'figcaption': {
        const text = decodeHtmlEntities(node.text.trim());
        if (text) paras.push(new Paragraph({ children: [new TextRun({ text, size: 18, color: '666666' })] }));
        break;
      }
      case 'hr':
        paras.push(new Paragraph({ text: '' }));
        break;
      case 'script': case 'style': case 'noscript': case 'img': case 'figure':
        break;
      default:
        node.childNodes.forEach(walk);
    }
  }

  root.childNodes.forEach(walk);
  return paras;
}

async function buildDocx(paragraphs) {
  const doc = new Document({
    styles: {
      paragraphStyles: [{
        id: 'ContentPullMeta',
        name: 'ContentPull Meta',
        basedOn: 'Normal',
        run: { size: 16, color: '888888', font: { name: 'Courier New' } },
        paragraph: { spacing: { after: 0 } },
      }],
    },
    sections: [{ children: paragraphs }],
  });
  return Packer.toBuffer(doc);
}

function metaParagraph(item, typeSlug, pageBreakBefore = false) {
  const meta = JSON.stringify({
    slug: item.slug,
    type: typeSlug,
    link: item.link,
    date: item.date,
    modified: item.modified,
  });
  return new Paragraph({
    style: 'ContentPullMeta',
    children: [new TextRun(meta)],
    pageBreakBefore,
  });
}

// --- Serialisers ---

function writeItemMarkdown(item, td, dir) {
  const title = plainText(item.title?.rendered) || item.slug;
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

async function writeItemDocx(item, dir, typeSlug) {
  const title = plainText(item.title?.rendered) || item.slug;
  const paragraphs = [
    metaParagraph(item, typeSlug),
    new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }),
    ...htmlToDocxParagraphs(item.content?.rendered ?? ''),
  ];
  const buf = await buildDocx(paragraphs);
  writeFileSync(join(dir, `${item.slug}.docx`), buf);
}

function writeItemHtml(item, dir, typeSlug) {
  const title = plainText(item.title?.rendered) || item.slug;
  const meta = JSON.stringify({ slug: item.slug, type: typeSlug, link: item.link, date: item.date, modified: item.modified });
  const out = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="UTF-8">',
    `  <title>${title}</title>`,
    `  <meta name="date" content="${item.date}">`,
    `  <meta name="modified" content="${item.modified}">`,
    `  <link rel="canonical" href="${item.link}">`,
    '</head>',
    '<body>',
    `<article data-content-pull-meta='${meta}'>`,
    `<h1>${item.title?.rendered ?? title}</h1>`,
    item.content?.rendered ?? '',
    '</article>',
    '</body>',
    '</html>',
  ].join('\n');
  const filePath = join(dir, `${item.slug}.html`);
  writeFileSync(filePath, out);
  const mtime = new Date(item.modified);
  utimesSync(filePath, mtime, mtime);
}

async function writeAggregate(allCollected, outputDir, format, td, hostname) {
  const baseName = (hostname ?? 'content').replace(/[^a-zA-Z0-9._-]/g, '-');
  if (format === 'docx') {
    const paragraphs = [];
    let firstPost = true;
    for (const { typeSlug, items } of allCollected) {
      for (const item of items) {
        const title = plainText(item.title?.rendered) || item.slug;
        paragraphs.push(metaParagraph(item, typeSlug, !firstPost));
        paragraphs.push(new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }));
        paragraphs.push(...htmlToDocxParagraphs(item.content?.rendered ?? ''));
        firstPost = false;
      }
    }
    const buf = await buildDocx(paragraphs);
    writeFileSync(join(outputDir, `${baseName}.docx`), buf);
    console.log(`Aggregate saved → ./${baseName}.docx`);
  } else if (format === 'html') {
    const parts = ['<!DOCTYPE html>', '<html lang="en">', '<head><meta charset="UTF-8"><title>Content Export</title></head>', '<body>'];
    for (const { typeSlug, items } of allCollected) {
      for (const item of items) {
        const title = plainText(item.title?.rendered) || item.slug;
        const meta = JSON.stringify({ slug: item.slug, type: typeSlug, link: item.link, date: item.date, modified: item.modified });
        parts.push(`<article data-content-pull-meta='${meta}'>`);
        parts.push(`<h1>${item.title?.rendered ?? title}</h1>`);
        parts.push(item.content?.rendered ?? '');
        parts.push('</article>');
      }
    }
    parts.push('</body>', '</html>');
    writeFileSync(join(outputDir, `${baseName}.html`), parts.join('\n'));
    console.log(`Aggregate saved → ./${baseName}.html`);
  } else {
    const sections = [];
    for (const { typeName, items } of allCollected) {
      sections.push(`# ${typeName}\n`);
      for (const item of items) {
        const title = plainText(item.title?.rendered) || item.slug;
        const md = td.turndown(item.content?.rendered ?? '');
        sections.push([
          `## ${title}`,
          `date: ${item.date} | modified: ${item.modified} | link: ${item.link}`,
          '',
          md,
        ].join('\n'));
      }
    }
    writeFileSync(join(outputDir, `${baseName}.md`), sections.join('\n\n---\n\n') + '\n');
    console.log(`Aggregate saved → ./${baseName}.md`);
  }
}

// --- Reimport subcommand ---

async function doReimport(siteUrl, origPath, editedPath, opts) {
  const dryRun = opts.dryRun ?? false;
  const baseUrl = siteUrl.replace(/\/$/, '');
  const apiBase = `${baseUrl}/wp-json/wp/v2`;

  let authHeader = null;
  if (opts.user && opts.pass) {
    authHeader = basicAuth(opts.user, opts.pass);
  } else {
    const stored = loadCredentials(siteUrl);
    if (stored) authHeader = basicAuth(stored.user, stored.pass);
  }
  if (!authHeader) {
    console.error('Authentication required for reimport.\nStore credentials first: content-pull auth ' + baseUrl);
    process.exit(1);
  }

  const llmClient = initLlmClient();
  if (!llmClient) console.log('Note: no LLM configured — unmatched changes will be written to review file only.\n  Set ANTHROPIC_API_KEY, or OPENAI_API_KEY / OPENAI_BASE_URL for any OpenAI-compatible endpoint.\n');

  process.stdout.write('Parsing original DOCX... ');
  const origPosts = await loadDocxPosts(origPath);
  console.log(`${origPosts.length} post(s)`);

  process.stdout.write('Parsing edited DOCX...   ');
  const editPosts = await loadDocxPosts(editedPath);
  console.log(`${editPosts.length} post(s)`);

  if (!origPosts.length || !editPosts.length) {
    console.error('No ContentPullMeta markers found — was this DOCX generated by content-pull?');
    process.exit(1);
  }

  const origMap = new Map(origPosts.map(p => [p.meta.slug, p]));
  const editMap = new Map(editPosts.map(p => [p.meta.slug, p]));
  const toProcess = [...editMap.keys()].filter(s => origMap.has(s));
  const newSlugs = [...editMap.keys()].filter(s => !origMap.has(s));
  const goneSlugs = [...origMap.keys()].filter(s => !editMap.has(s));
  if (newSlugs.length) console.log(`Note: ${newSlugs.length} post(s) not in original, skipped: ${newSlugs.join(', ')}`);
  if (goneSlugs.length) console.log(`Note: ${goneSlugs.length} post(s) removed from edited, skipped: ${goneSlugs.join(', ')}`);

  // Fetch WP post types once to resolve rest_base
  let typeRestBases = {};
  try {
    const { body: types } = await apiFetch(`${apiBase}/types`, authHeader);
    typeRestBases = Object.fromEntries(Object.values(types).map(t => [t.slug, t.rest_base]));
  } catch { /* fallback to slug+s below */ }

  let changedCount = 0;
  const allReviewItems = {}; // slug → [{...}]

  for (const slug of toProcess) {
    const orig = origMap.get(slug);
    const edit = editMap.get(slug);
    const diff = diffParagraphs(orig.paragraphs, edit.paragraphs);
    const changes = diff.filter(d => d.type !== 'equal');
    if (!changes.length) continue;

    changedCount++;
    const typeSlug = orig.meta.type;
    console.log(`\n${slug} (${typeSlug}): ${changes.length} change(s)`);
    changes.forEach(c => {
      if (c.type === 'changed') console.log(`  ~ "${c.orig.slice(0, 72)}" → "${c.edit.slice(0, 72)}"`);
      else if (c.type === 'added') console.log(`  + "${c.edit.slice(0, 72)}"`);
      else console.log(`  - "${c.orig.slice(0, 72)}"`);
    });

    if (dryRun) continue;

    // Fetch raw block content from WordPress
    const restBase = typeRestBases[typeSlug] ?? `${typeSlug}s`;
    let postData;
    try {
      const { body } = await apiFetch(`${apiBase}/${restBase}?slug=${slug}&context=edit&_fields=id,content`, authHeader);
      postData = Array.isArray(body) ? body[0] : null;
    } catch (e) { console.log(`  ERROR fetching: ${e.message}`); continue; }
    if (!postData?.id) { console.log('  ERROR: post not found or insufficient permissions'); continue; }
    const rawContent = postData.content?.raw;
    if (!rawContent) { console.log('  ERROR: no raw content (check auth and context=edit support)'); continue; }

    const blocks = parseWpBlocks(rawContent);
    const reviewItems = [];

    // Collect replacements; apply back-to-front to preserve offsets
    const replacements = []; // [{start, end, newBlockRaw}]

    for (const change of changes) {
      // --- Programmatic path for 'changed' ---
      if (change.type === 'changed') {
        const matchBlock = blocks.find(b => normText(b.innerText) === normText(change.orig));
        if (matchBlock) {
          const hasInlineHtml = /<\w/.test(matchBlock.innerHTML.replace(/<[\w]+[^>]*>|<\/[\w]+>/g, ''));
          const spliced = spliceBlockText(matchBlock, change.edit);
          if (spliced && !hasInlineHtml) {
            replacements.push({ start: matchBlock.start, end: matchBlock.end, newBlockRaw: spliced });
            continue;
          }
          // Block found but has rich inline HTML — let LLM preserve formatting
          if (llmClient) {
            const result = await llmMerge(llmClient, change, matchBlock.raw, null);
            if (result.confidence >= 90) {
              replacements.push({ start: matchBlock.start, end: matchBlock.end, newBlockRaw: result.updated });
              console.log(`  ✓ LLM merged inline-rich block (${result.confidence}%)`);
            } else {
              reviewItems.push({ change_type: 'changed', reason: 'low_confidence', ...change, block_raw: matchBlock.raw, llm_suggestion: result.updated, confidence: result.confidence, reasoning: result.reasoning });
              console.log(`  ⚠ LLM confidence ${result.confidence}% — flagged for review`);
            }
            continue;
          }
          // No LLM — use simple splice anyway, note formatting loss
          if (spliced) {
            replacements.push({ start: matchBlock.start, end: matchBlock.end, newBlockRaw: spliced });
            console.log(`  ~ Applied (inline formatting may be lost)`);
          } else {
            reviewItems.push({ change_type: 'changed', reason: 'no_llm_complex_block', ...change, block_raw: matchBlock.raw });
          }
          continue;
        }
      }

      // --- LLM path: no block match, addition, or deletion ---
      if (llmClient) {
        const result = await llmMerge(llmClient, change, null, rawContent);
        if (result.confidence >= 90) {
          // LLM returned updated full content; we'll apply it as a whole-content replace
          replacements.push({ fullReplace: result.updated });
          console.log(`  ✓ LLM applied ${change.type} (${result.confidence}%)`);
        } else {
          reviewItems.push({ change_type: change.type, reason: 'low_confidence', ...change, llm_suggestion: result.updated, confidence: result.confidence, reasoning: result.reasoning });
          console.log(`  ⚠ LLM confidence ${result.confidence}% — flagged for review`);
        }
      } else {
        const label = change.type === 'added' ? `+ "${change.edit.slice(0, 60)}"` : `- "${change.orig.slice(0, 60)}"`;
        console.log(`  WARN no match for ${label} — flagged for review (no LLM configured)`);
        reviewItems.push({ change_type: change.type, reason: 'no_match', ...change });
      }
    }

    if (reviewItems.length) {
      allReviewItems[slug] = { meta: orig.meta, items: reviewItems };
    }

    if (!replacements.length) { console.log('  No changes applied.'); continue; }

    // Build updated content — handle full-content replace from LLM
    const fullReplace = replacements.find(r => r.fullReplace);
    let updatedRaw;
    if (fullReplace) {
      updatedRaw = fullReplace.fullReplace;
    } else {
      replacements.sort((a, b) => b.start - a.start);
      updatedRaw = rawContent;
      for (const { start, end, newBlockRaw } of replacements) {
        updatedRaw = updatedRaw.slice(0, start) + newBlockRaw + updatedRaw.slice(end);
      }
    }

    try {
      await apiFetch(`${apiBase}/${restBase}/${postData.id}`, authHeader, 'POST', { content: updatedRaw });
      const skipped = changes.length - replacements.length;
      console.log(`  ✓ Pushed ${replacements.length} change(s)${skipped ? `, ${skipped} flagged` : ''}`);
    } catch (e) {
      console.log(`  ERROR pushing: ${e.message}`);
    }
  }

  // Write review file
  if (Object.keys(allReviewItems).length) {
    const reviewPath = resolve('reimport-review.json');
    writeFileSync(reviewPath, JSON.stringify(allReviewItems, null, 2));
    console.log(`\nReview file written: ${reviewPath}`);
    console.log('Items flagged for human or agent review. Pass this file to an LLM with access to the WordPress REST API to resolve remaining changes.');
  }

  if (!changedCount) {
    console.log('\nNo changes detected.');
  } else if (dryRun) {
    console.log(`\nDry run — ${changedCount} post(s) have changes. Remove --dry-run to apply.`);
  } else {
    console.log('\nDone.');
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
          await writeItemDocx(item, dir, type.slug);
        } else if (format === 'html') {
          writeItemHtml(item, dir, type.slug);
        } else {
          writeItemMarkdown(item, td, dir);
        }
      }
      console.log(`${items.length} saved → ./${type.slug}/`);
    }
  }

  if (aggregate && allCollected.length > 0) {
    await writeAggregate(allCollected, outputDir, format, td, hostname);
  }

  console.log('\nDone.');
}

// --- CLI entry point ---

const USAGE = `
Usage:
  content-pull <url> [options]                              Pull content from a WordPress site
  content-pull auth <url>                                   Authenticate via Application Passwords
  content-pull reimport <url> <original.docx> <edited.docx> Reimport edited DOCX back to WordPress

Pull options:
  --output,    -o <dir>    Output directory (default: current directory)
  --types,     -t <list>   Comma-separated post types (default: all public)
  --format,    -f <fmt>    Output format: md (default), html, or docx
  --aggregate, -a          Combine all posts into a single file
  --user,      -u <name>   WordPress username (overrides stored credentials)
  --pass,      -p <pass>   WordPress application password
  --delay,     -d <ms>     Milliseconds to wait between requests (default: ${DEFAULT_DELAY_MS})

Reimport options:
  --dry-run,   -n          Show what would change without applying
  --user,      -u <name>   WordPress username (required)
  --pass,      -p <pass>   WordPress application password (required)

  LLM configuration (pick one):
    ANTHROPIC_API_KEY              Use Anthropic Claude (claude-sonnet-4-6)
    OPENAI_API_KEY                 Use OpenAI or any OpenAI-compatible endpoint
    OPENAI_BASE_URL                Override endpoint (Ollama: http://localhost:11434/v1)
    OPENAI_MODEL                   Override model name (default: gpt-4o, or llama3 if base URL set)

  Items below 90% LLM confidence are written to reimport-review.json for human review.
`.trim();

const args = process.argv.slice(2);
const opts = { output: '.', types: null, format: 'md', aggregate: false, user: null, pass: null, delay: null, dryRun: false };
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
    case '--dry-run':   case '-n': opts.dryRun = true; break;
    default:
      if (!args[i].startsWith('-')) positional.push(args[i]);
  }
}

const subcommand = positional[0];

if (!positional.length) {
  console.error(USAGE);
  process.exit(1);
}

if (subcommand === 'auth') {
  const urlArg = positional[1];
  if (!urlArg) { console.error(USAGE); process.exit(1); }
  doAuth(urlArg).catch(e => { console.error(e.message); process.exit(1); });
} else if (subcommand === 'reimport') {
  const [, urlArg, origPath, editedPath] = positional;
  if (!urlArg || !origPath || !editedPath) { console.error(USAGE); process.exit(1); }
  doReimport(urlArg, origPath, editedPath, opts).catch(e => { console.error(e.message); process.exit(1); });
} else {
  const urlArg = positional[1] ?? positional[0];
  doPull(urlArg, opts).catch(e => { console.error(e.message); process.exit(1); });
}
