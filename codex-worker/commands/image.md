---
description: Generate or edit an image with Codex's image model (gpt-image-2), using your ChatGPT login and no Codex worker
argument-hint: "[--out file.png] [--ref img.png,...] [--size auto|1024x1024|1536x1024|1024x1536] [--quality auto|low|medium|high] [--background auto|transparent|opaque] <prompt>"
allowed-tools: Bash(node:*), Read
---

Generate the image the user asked for with one direct call:

```bash
node "$HOME/.codex-worker/cw.mjs" image --json [flags] "<prompt>"
```

Raw user request:
$ARGUMENTS

- Flags in the request are options. The rest is the prompt. Keep the user's wording and any text that must appear in the image exactly as written.
- If the user gave no destination, save into the current project folder with a short descriptive file name. Never overwrite an existing file unless the user asked for it (`--force`).
- Use `--ref` for reference images the user names (up to 5; PNG, JPEG or WebP).
- After it finishes, Read the saved image to check it, then report the path. If the call fails, report the error as-is.
