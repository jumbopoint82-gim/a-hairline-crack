import { runPartialBatch, type BatchResult } from "./batch-read";
import { SingleFlight } from "./single-flight";

export type WorkerEnv = {
  MCP_SHARED_SECRET?: string;
  SUPABASE_SECRET_KEY?: string;
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
  GITHUB_TOKEN?: string;
};

export type RuleRow = {
  meta_key: string;
  meta_value: unknown;
  updated_at: string;
};

type EpisodeConfig = {
  episode: number;
  documentId: string;
  githubPath: string;
};

type GoogleServiceAccount = {
  client_email: string;
  private_key: string;
};

type GoogleTokenCache = {
  email: string;
  accessToken: string;
  expiresAt: number;
};

export type DriveManuscript = {
  episode: number;
  documentId: string;
  revisionId: string;
  text: string;
};

export const SUPABASE_URL = "https://agmwevkhgkggkgmfyeyj.supabase.co";
export const SUPABASE_SCHEMA = "growth_boundary_proofing_data";
export const ACTIVE_RULE_KEYS = [
  "governance_instruction_active_v3",
  "governance_execution_prompt_active_v3",
  "governance_workflow_active_v3",
] as const;

const GITHUB_OWNER = "jumbopoint82-gim";
const GITHUB_REPO = "hairline_crack";
const GITHUB_BRANCH = "main";

const EPISODES: Record<number, EpisodeConfig> = {
  1: {
    episode: 1,
    documentId: "1dLZxMslacZVXaAS18bN_PjTkP0LN-dUiSVJz-CuTo6M",
    githubPath: "novel/01_원고/1부_잘잘못의 경계/1장_5학년/01회_5학년이 된 중희.txt",
  },
  2: {
    episode: 2,
    documentId: "1jyNJz-OFtk-po04uZ_XJKlCbDyxPHSYxBAzknWL6EXs",
    githubPath: "novel/01_원고/1부_잘잘못의 경계/1장_5학년/02회_5학년 되어서도 영일이와 같은 반이 된 민성.txt",
  },
  3: {
    episode: 3,
    documentId: "1cbJTHjDlHkHfO6ul3H2DhGDHNK7tt0wu0Byn0USnd1Q",
    githubPath: "novel/01_원고/1부_잘잘못의 경계/1장_5학년/03회_5학년 담임을 맡게 된 현주.txt",
  },
};

let googleTokenCache: GoogleTokenCache | null = null;
const googleTokenSingleFlight = new SingleFlight<string, string>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown integration error";
}

export function getEpisodeConfig(episode: number): EpisodeConfig {
  const config = EPISODES[episode];
  if (!config) throw new Error(`Unsupported episode: ${episode}`);
  return config;
}

export async function loadActiveRules(env: WorkerEnv): Promise<RuleRow[]> {
  if (!env.SUPABASE_SECRET_KEY) {
    throw new Error("SUPABASE_SECRET_KEY is not configured");
  }

  const endpoint = new URL(`${SUPABASE_URL}/rest/v1/correction_meta`);
  endpoint.searchParams.set("select", "meta_key,meta_value,updated_at");
  endpoint.searchParams.set("meta_key", `in.(${ACTIVE_RULE_KEYS.join(",")})`);
  endpoint.searchParams.set("order", "meta_key.asc");

  const response = await fetch(endpoint, {
    headers: {
      apikey: env.SUPABASE_SECRET_KEY,
      "Accept-Profile": SUPABASE_SCHEMA,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Supabase read failed (${response.status}): ${detail}`);
  }

  const rows = (await response.json()) as RuleRow[];
  if (rows.length !== ACTIVE_RULE_KEYS.length) {
    throw new Error(`Expected ${ACTIVE_RULE_KEYS.length} ACTIVE rule rows, received ${rows.length}`);
  }
  return rows;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function encodeStringBase64Url(value: string): string {
  return encodeBase64Url(new TextEncoder().encode(value));
}

function decodePemPrivateKey(pem: string): ArrayBuffer {
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

export function parseGoogleServiceAccount(env: WorkerEnv): GoogleServiceAccount {
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not configured");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("client_email" in parsed) ||
    !("private_key" in parsed) ||
    typeof (parsed as Record<string, unknown>).client_email !== "string" ||
    typeof (parsed as Record<string, unknown>).private_key !== "string"
  ) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key");
  }

  return {
    client_email: (parsed as Record<string, string>).client_email,
    private_key: (parsed as Record<string, string>).private_key,
  };
}

async function mintGoogleAccessToken(
  credentials: GoogleServiceAccount,
  now: number,
): Promise<string> {
  const issuedAt = Math.floor(now / 1000);
  const header = encodeStringBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = encodeStringBase64Url(
    JSON.stringify({
      iss: credentials.client_email,
      scope: "https://www.googleapis.com/auth/documents",
      aud: "https://oauth2.googleapis.com/token",
      iat: issuedAt,
      exp: issuedAt + 3600,
    }),
  );
  const unsignedToken = `${header}.${claim}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    decodePemPrivateKey(credentials.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsignedToken),
  );
  const assertion = `${unsignedToken}.${encodeBase64Url(new Uint8Array(signature))}`;

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!tokenResponse.ok) {
    const detail = await tokenResponse.text();
    throw new Error(`Google token exchange failed (${tokenResponse.status}): ${detail}`);
  }

  const tokenData = (await tokenResponse.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!tokenData.access_token) {
    throw new Error("Google token exchange returned no access_token");
  }

  googleTokenCache = {
    email: credentials.client_email,
    accessToken: tokenData.access_token,
    expiresAt: now + (tokenData.expires_in ?? 3600) * 1000,
  };
  return tokenData.access_token;
}

export async function getGoogleAccessToken(env: WorkerEnv): Promise<string> {
  const credentials = parseGoogleServiceAccount(env);
  const now = Date.now();

  if (
    googleTokenCache &&
    googleTokenCache.email === credentials.client_email &&
    googleTokenCache.expiresAt - now > 5 * 60 * 1000
  ) {
    return googleTokenCache.accessToken;
  }

  return googleTokenSingleFlight.run(credentials.client_email, () =>
    mintGoogleAccessToken(credentials, now),
  );
}

async function getGoogleDocument(env: WorkerEnv, config: EpisodeConfig): Promise<any> {
  const accessToken = await getGoogleAccessToken(env);
  const endpoint = new URL(`https://docs.googleapis.com/v1/documents/${config.documentId}`);
  endpoint.searchParams.set("includeTabsContent", "true");

  const response = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Google Docs read failed (${response.status}): ${detail}`);
  }
  return response.json();
}

function flattenDocumentTabs(tabs: any[] | undefined): any[] {
  if (!tabs) return [];
  const flattened: any[] = [];
  const visit = (tab: any) => {
    if (tab?.documentTab) flattened.push(tab);
    for (const child of tab?.childTabs ?? []) visit(child);
  };
  for (const tab of tabs) visit(tab);
  return flattened;
}

function getSingleTabState(document: any): { tabId?: string; body: any; endIndex: number } {
  const tabs = flattenDocumentTabs(document?.tabs);
  let tabId: string | undefined;
  let body: any;

  if (tabs.length > 0) {
    if (tabs.length !== 1) {
      throw new Error(`Canonical manuscript must contain exactly one text tab; found ${tabs.length}`);
    }
    tabId = tabs[0]?.tabProperties?.tabId;
    body = tabs[0]?.documentTab?.body;
  } else {
    body = document?.body;
  }

  if (!body || !Array.isArray(body.content)) {
    throw new Error("Google Docs body content is unavailable");
  }

  const endIndex = body.content.reduce(
    (maximum: number, element: any) => Math.max(maximum, element?.endIndex ?? 1),
    1,
  );
  return { tabId, body, endIndex };
}

function extractPlainDocumentText(body: any): string {
  let text = "";
  for (const structuralElement of body.content ?? []) {
    if (structuralElement?.paragraph) {
      for (const element of structuralElement.paragraph.elements ?? []) {
        if (typeof element?.textRun?.content === "string") {
          text += element.textRun.content;
        } else if (element?.inlineObjectElement || element?.horizontalRule) {
          throw new Error("Canonical manuscript contains a non-text inline object");
        }
      }
      continue;
    }
    if (structuralElement?.sectionBreak) continue;
    if (structuralElement?.table || structuralElement?.tableOfContents) {
      throw new Error("Canonical manuscript contains unsupported table or table-of-contents content");
    }
  }
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

export function cleanInvisibleFormatting(text: string): {
  text: string;
  changed: boolean;
  invisibleRemoved: number;
  lineSeparatorsNormalized: number;
} {
  const invisibleMatches = text.match(/[\u200B\uFEFF]/g);
  const lineSeparatorMatches = text.match(/\r\n|\r|\u2028|\u2029/g);
  const cleaned = text
    .replace(/\r\n|\r|\u2028|\u2029/g, "\n")
    .replace(/[\u200B\uFEFF]/g, "");
  return {
    text: cleaned,
    changed: cleaned !== text,
    invisibleRemoved: invisibleMatches?.length ?? 0,
    lineSeparatorsNormalized: lineSeparatorMatches?.length ?? 0,
  };
}

export async function readDriveManuscript(env: WorkerEnv, episode: number): Promise<DriveManuscript> {
  const config = getEpisodeConfig(episode);
  const document = await getGoogleDocument(env, config);
  const state = getSingleTabState(document);
  const text = extractPlainDocumentText(state.body);

  if (typeof document?.revisionId !== "string" || document.revisionId.length === 0) {
    throw new Error("Google Docs revisionId is unavailable; the service account needs edit access");
  }

  return {
    episode,
    documentId: config.documentId,
    revisionId: document.revisionId as string,
    text,
  };
}

export async function readDriveManuscriptBatch(
  env: WorkerEnv,
  episodes: number[],
): Promise<BatchResult<number, DriveManuscript>> {
  return runPartialBatch(episodes, (episode) => readDriveManuscript(env, episode));
}

export async function saveDriveManuscript(
  env: WorkerEnv,
  episode: number,
  text: string,
  expectedRevisionId: string,
) {
  const config = getEpisodeConfig(episode);
  const document = await getGoogleDocument(env, config);
  const state = getSingleTabState(document);

  if (document?.revisionId !== expectedRevisionId) {
    throw new Error("Drive canonical changed after prepare_cycle; refusing stale write");
  }

  const cleanup = cleanInvisibleFormatting(text);
  const insertionText = cleanup.text.endsWith("\n") ? cleanup.text.slice(0, -1) : cleanup.text;
  const requests: any[] = [];

  if (state.endIndex > 1) {
    const range: Record<string, unknown> = { startIndex: 1, endIndex: state.endIndex - 1 };
    if (state.tabId) range.tabId = state.tabId;
    requests.push({ deleteContentRange: { range } });
  }
  if (insertionText.length > 0) {
    const location: Record<string, unknown> = { index: 1 };
    if (state.tabId) location.tabId = state.tabId;
    requests.push({ insertText: { location, text: insertionText } });
  }

  const accessToken = await getGoogleAccessToken(env);
  const response = await fetch(`https://docs.googleapis.com/v1/documents/${config.documentId}:batchUpdate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ requests, writeControl: { requiredRevisionId: expectedRevisionId } }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Google Docs write failed (${response.status}): ${detail}`);
  }

  const result = (await response.json()) as any;
  return {
    episode,
    documentId: config.documentId,
    text: cleanup.text,
    cleanupChanged: cleanup.changed,
    invisibleRemoved: cleanup.invisibleRemoved,
    lineSeparatorsNormalized: cleanup.lineSeparatorsNormalized,
    revisionId: result?.writeControl?.requiredRevisionId ?? null,
  };
}

export function requireGithubToken(env: WorkerEnv): string {
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not configured");
  return env.GITHUB_TOKEN;
}

function githubContentsUrl(config: EpisodeConfig): string {
  const encodedPath = config.githubPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodedPath}`;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "a-hairline-crack-mcp",
  };
}

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64ToUtf8(base64: string): string {
  const normalized = base64.replace(/\s+/g, "");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}

export async function getGithubBackupFile(env: WorkerEnv, episode: number) {
  const config = getEpisodeConfig(episode);
  const token = requireGithubToken(env);
  const response = await fetch(githubContentsUrl(config), { headers: githubHeaders(token) });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GitHub backup read failed (${response.status}): ${detail}`);
  }

  const data = (await response.json()) as { sha?: string; content?: string; encoding?: string };
  if (!data.sha) throw new Error("GitHub backup file returned no SHA");
  return { config, token, data };
}

export async function backupGithub(env: WorkerEnv, episode: number, text: string) {
  const { config, token, data } = await getGithubBackupFile(env, episode);
  const currentText =
    data.encoding === "base64" && typeof data.content === "string" ? base64ToUtf8(data.content) : null;

  if (currentText === text) {
    return {
      episode,
      repository: `${GITHUB_OWNER}/${GITHUB_REPO}`,
      path: config.githubPath,
      skipped: true,
      reason: "backup already matches Drive canonical",
    };
  }

  const response = await fetch(githubContentsUrl(config), {
    method: "PUT",
    headers: { ...githubHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `Backup episode ${String(episode).padStart(2, "0")} from Drive canonical`,
      content: utf8ToBase64(text),
      sha: data.sha,
      branch: GITHUB_BRANCH,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GitHub backup write failed (${response.status}): ${detail}`);
  }

  const result = (await response.json()) as any;
  return {
    episode,
    repository: `${GITHUB_OWNER}/${GITHUB_REPO}`,
    path: config.githubPath,
    skipped: false,
    commitSha: result?.commit?.sha ?? null,
  };
}

export async function integrationHealth(env: WorkerEnv) {
  const checks = [
    ["supabase", () => loadActiveRules(env)],
    ["google_drive", () => readDriveManuscript(env, 1)],
    ["github", () => getGithubBackupFile(env, 1)],
  ] as const;

  const results = await Promise.all(
    checks.map(async ([name, operation]) => {
      const startedAt = Date.now();
      try {
        await operation();
        return [name, { ok: true, latencyMs: Date.now() - startedAt }] as const;
      } catch (error) {
        return [
          name,
          { ok: false, latencyMs: Date.now() - startedAt, error: errorMessage(error) },
        ] as const;
      }
    }),
  );

  const integrations = Object.fromEntries(results);
  return {
    ok: results.every(([, value]) => value.ok),
    integrations,
  };
}
