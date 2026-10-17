// codex-worker: generate or edit images straight from Codex's image backend,
// reusing the ChatGPT login in $CODEX_HOME/auth.json. No Codex turn and no
// OPENAI_API_KEY. This is the same unofficial endpoint the Codex CLI uses (as
// in jdmnk/codex-imagegen-cli and crazygit/pi-codex-image-gen), so it may
// change without notice.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { CodexAppServerClient } from "./app-server.mjs";

const GENERATIONS_URL = "https://chatgpt.com/backend-api/codex/images/generations";
const EDITS_URL = "https://chatgpt.com/backend-api/codex/images/edits";
const IMAGE_MODEL = "gpt-image-2";
const SIZES = new Set(["auto", "1024x1024", "1536x1024", "1024x1536"]);
const QUALITIES = new Set(["auto", "low", "medium", "high"]);
const BACKGROUNDS = new Set(["auto", "transparent", "opaque"]);
const MIME_BY_EXT = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const MAX_REF_BYTES = 20 * 1024 * 1024;
const RETRYABLE = new Set([429, 502, 503, 504, 520, 522, 523, 524]);

function codexHome() {
  return process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), ".codex");
}

function decodeJwt(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function readAuth() {
  const file = path.join(codexHome(), "auth.json");
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`No Codex login found at ${file}. Run \`codex login\` and choose ChatGPT.`);
  }
  const token = data?.tokens?.access_token;
  if (!token) {
    throw new Error("Codex is not logged in with ChatGPT (no access token in auth.json). Run `codex login`.");
  }
  const claims = decodeJwt(token);
  const accountId =
    data.tokens.account_id ?? claims?.["https://api.openai.com/auth"]?.chatgpt_account_id ?? null;
  return { token, accountId, expiresAt: (claims?.exp ?? 0) * 1000 };
}

// Let Codex refresh its own tokens (it rewrites auth.json), instead of
// duplicating the OAuth refresh flow here.
async function refreshViaCodex(cwd) {
  const client = await CodexAppServerClient.connect(cwd, { disableBroker: true });
  try {
    await client.request("account/read", { refreshToken: true });
  } finally {
    await client.close().catch(() => {});
  }
}

async function getAuth(cwd, { force = false } = {}) {
  let auth = readAuth();
  if (force || auth.expiresAt - Date.now() < 5 * 60 * 1000) {
    await refreshViaCodex(cwd);
    auth = readAuth();
  }
  return auth;
}

function codexVersion() {
  const out = spawnSync("codex", ["--version"], { encoding: "utf8", windowsHide: true, shell: process.platform === "win32" });
  return out.stdout?.match(/(\d+\.\d+\.\d+)/)?.[1] ?? "0.0.0";
}

function headersFor(auth) {
  const version = codexVersion();
  const headers = {
    Authorization: `Bearer ${auth.token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    originator: "codex_cli_rs",
    version,
    "User-Agent": `codex_cli_rs/${version} (${os.platform()} ${os.release()}; ${os.arch()}) codex-worker`
  };
  if (auth.accountId) headers["ChatGPT-Account-ID"] = auth.accountId;
  return headers;
}

function refToDataUrl(file) {
  const ext = path.extname(file).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) throw new Error(`Reference image ${file} must be PNG, JPEG or WebP.`);
  const bytes = fs.readFileSync(file);
  if (bytes.length > MAX_REF_BYTES) throw new Error(`Reference image ${file} is larger than 20 MB.`);
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

function describeError(status, bodyText) {
  let detail = bodyText.slice(0, 400);
  try {
    const parsed = JSON.parse(bodyText);
    const err = parsed.error ?? parsed.detail ?? parsed;
    detail = typeof err === "string" ? err : [err.code, err.type, err.message].filter(Boolean).join(" ") || detail;
  } catch {}
  if (/usage[_ ]limit|usage[_ ]not[_ ]included|insufficient[_ ]quota/i.test(detail)) {
    return `The ChatGPT plan's image usage limit was reached (${status}). Try again later.`;
  }
  if (/moderation|content_policy|safety/i.test(detail)) {
    return `The image request was blocked by the provider's safety checks (${status}): ${detail}`;
  }
  return `Codex image service returned ${status}: ${detail}`;
}

/**
 * @param {{prompt: string, refs?: string[], size?: string, quality?: string, background?: string, cwd: string}} req
 * @returns {Promise<{buffer: Buffer, size: string|null, quality: string|null, revisedPrompt: string|null, mode: string}>}
 */
export async function generateImage(req) {
  const size = req.size ?? "auto";
  const quality = req.quality ?? "auto";
  const background = req.background ?? "auto";
  if (!SIZES.has(size)) throw new Error(`--size must be one of: ${[...SIZES].join(", ")}.`);
  if (!QUALITIES.has(quality)) throw new Error(`--quality must be one of: ${[...QUALITIES].join(", ")}.`);
  if (!BACKGROUNDS.has(background)) throw new Error(`--background must be one of: ${[...BACKGROUNDS].join(", ")}.`);
  if (!req.prompt?.trim()) throw new Error("Provide a prompt (positional text or --prompt-file).");

  const refs = req.refs ?? [];
  if (refs.length > 5) throw new Error("Use at most 5 reference images.");
  const mode = refs.length ? "edit" : "generate";
  const body = { model: IMAGE_MODEL, prompt: req.prompt, background, quality, size };
  if (refs.length) body.images = refs.map((file) => ({ image_url: refToDataUrl(file) }));
  const url = refs.length ? EDITS_URL : GENERATIONS_URL;

  let auth = await getAuth(req.cwd);
  let refreshedAfter401 = false;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let response;
    try {
      response = await fetch(url, { method: "POST", headers: headersFor(auth), body: JSON.stringify(body), redirect: "error" });
    } catch (error) {
      // Not retried: the request may have gone through, and a retry could bill a second image.
      throw new Error(`Could not reach the Codex image service: ${error.message}${error.cause ? ` (${error.cause.code ?? ""} ${error.cause.message ?? error.cause})` : ""}`);
    }
    const text = await response.text();
    if (response.ok) {
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error("The Codex image service returned an unreadable response.");
      }
      const item = payload?.data?.[0];
      if (!item?.b64_json) throw new Error("The Codex image service returned no image.");
      return {
        buffer: Buffer.from(item.b64_json, "base64"),
        size: payload.size ?? null,
        quality: payload.quality ?? null,
        revisedPrompt: item.revised_prompt ?? null,
        mode
      };
    }
    if (response.status === 401 && !refreshedAfter401) {
      refreshedAfter401 = true;
      auth = await getAuth(req.cwd, { force: true });
      attempt -= 1;
      continue;
    }
    if (RETRYABLE.has(response.status) && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
      continue;
    }
    throw new Error(describeError(response.status, text));
  }
  throw new Error("The Codex image service did not return an image after retries.");
}
