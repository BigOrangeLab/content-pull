# Installing content-pull

## Option A — run without installing (recommended for one-off use)

```bash
npx github:bigorangelab/content-pull https://example.com
```

## Option B — clone and run directly

```bash
git clone https://github.com/bigorangelab/content-pull
cd content-pull
npm install
node index.js https://example.com
```

## Option C — install globally

```bash
npm install -g github:bigorangelab/content-pull
content-pull https://example.com
```

## Requirements

- Node.js 18 or later (`node --version` to check)
- Network access to the target WordPress site's REST API
