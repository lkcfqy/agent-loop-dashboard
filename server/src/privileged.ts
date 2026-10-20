// Privileged host work: download a GitHub repo tarball, gunzip + untar it,
// and return the code files under a subpath. Actions cannot import
// node:zlib, so this lives here behind a typed contract.

import { gunzipSync } from "node:zlib";
import {
definePrivilegedContracts,
definePrivilegedHandlers,
z,
} from "@hatch/space-sdk";

export const privileged = definePrivilegedContracts({
  fetchRepoCode: {
    request: z.object({
      repo: z.string(),
      branch: z.string(),
      subpath: z.string(),
    }),
    response: z.object({
      files: z.array(
        z.object({
          path: z.string(),
          size: z.number(),
          content: z.string().nullable(),
        }),
      ),
      totalCodeFiles: z.number(),
    }),
    capabilities: ["network.fetch"],
    timeoutMs: 120000,
  },
});

const CODE_EXTS = new Set([
  ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".go", ".rs", ".java",
  ".rb", ".php", ".swift", ".kt", ".c", ".h", ".cpp", ".cs", ".vue",
]);
const MAX_FILES = 500;
const MAX_FILE_BYTES = 200_000;

function extOf(p: string): string {
  const i = p.lastIndexOf(".");
  return i >= 0 ? p.slice(i).toLowerCase() : "";
}

type TarEntry = { path: string; size: number; text: string | null };

function parseTar(tar: Uint8Array): TarEntry[] {
  const dec = new TextDecoder();
  const entries: TarEntry[] = [];
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    let allZero = true;
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) { allZero = false; break; }
    }
    if (allZero) break;
    const rawName = dec.decode(header.subarray(0, 100)).replace(/\0.*$/s, "");
    const prefix = dec.decode(header.subarray(345, 500)).replace(/\0.*$/s, "");
    const sizeStr = dec.decode(header.subarray(124, 136)).replace(/\0.*$/s, "").trim();
    const size = parseInt(sizeStr, 8) || 0;
    const typeFlag = String.fromCharCode(header[156] ?? 48);
    const full = prefix ? `${prefix}/${rawName}` : rawName;
    const slash = full.indexOf("/");
    const path = slash >= 0 ? full.slice(slash + 1) : full;
    if ((typeFlag === "0" || typeFlag === "\0") && path && !path.endsWith("/")) {
      let text: string | null = null;
      if (size <= MAX_FILE_BYTES && CODE_EXTS.has(extOf(path))) {
        text = dec.decode(tar.subarray(off + 512, off + 512 + size));
      }
      entries.push({ path, size, text });
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

export const privilegedHandlers = definePrivilegedHandlers(privileged, {
  async fetchRepoCode(args) {
    const { repo, branch, subpath } = args;
    const res = await fetch(
      `https://codeload.github.com/${repo}/tar.gz/refs/heads/${branch}`,
      { headers: { "User-Agent": "agent-loop-dashboard" } },
    );
    if (!res.ok) {
      throw new Error(
        `GitHub returned ${res.status} for ${repo}@${branch} — check the repo name and branch.`,
      );
    }
    const gz = new Uint8Array(await res.arrayBuffer());
    const tar = gunzipSync(gz);
    const entries = parseTar(tar);
    const code = entries.filter((e) => {
      if (!CODE_EXTS.has(extOf(e.path))) return false;
      if (subpath) return e.path === subpath || e.path.startsWith(`${subpath}/`);
      return true;
    });
    const capped = code.slice(0, MAX_FILES);
    return {
      files: capped.map((f) => ({ path: f.path, size: f.size, content: f.text })),
      totalCodeFiles: code.length,
    };
  },
});
