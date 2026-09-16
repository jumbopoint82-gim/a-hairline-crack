export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type ReadReliabilityOptions = {
  maxAttempts?: number;
  timeoutMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_BASE_DELAY_MS = 150;
const DEFAULT_MAX_DELAY_MS = 2_000;

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (input instanceof Request) return input.method.toUpperCase();
  return "GET";
}

function requestUrl(input: RequestInfo | URL): string {
  if (input instanceof Request) return input.url;
  return input instanceof URL ? input.href : String(input);
}

function isGoogleTokenExchange(url: string, method: string): boolean {
  if (method !== "POST") return false;
  try {
    const parsed = new URL(url);
    return parsed.origin === "https://oauth2.googleapis.com" && parsed.pathname === "/token";
  } catch {
    return false;
  }
}

function isSafeToRetry(input: RequestInfo | URL, init?: RequestInit): boolean {
  const method = requestMethod(input, init);
  return method === "GET" || method === "HEAD" || isGoogleTokenExchange(requestUrl(input), method);
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function parseRetryAfterMilliseconds(value: string | null, now: number): number | null {
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

function calculateDelayMilliseconds(
  response: Response | null,
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  const retryAfter = parseRetryAfterMilliseconds(
    response?.headers.get("Retry-After") ?? null,
    Date.now(),
  );
  if (retryAfter !== null) return Math.min(retryAfter, maxDelayMs);

  return Math.min(baseDelayMs * 2 ** Math.max(0, attempt - 1), maxDelayMs);
}

function createAttemptSignal(
  externalSignal: AbortSignal | null | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();

  const forwardAbort = () => {
    controller.abort(externalSignal?.reason ?? new Error("Read request aborted"));
  };

  if (externalSignal?.aborted) {
    forwardAbort();
  } else {
    externalSignal?.addEventListener("abort", forwardAbort, { once: true });
  }

  const timeout = setTimeout(() => {
    controller.abort(new Error(`Read request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", forwardAbort);
    },
  };
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best effort only. The retry must not fail because body cancellation failed.
  }
}

export function createReadReliableFetch(
  nativeFetch: FetchLike,
  options: ReadReliabilityOptions = {},
): FetchLike {
  const maxAttempts = Math.max(1, Math.trunc(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
  const timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const baseDelayMs = Math.max(0, Math.trunc(options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS));
  const maxDelayMs = Math.max(baseDelayMs, Math.trunc(options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS));
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!isSafeToRetry(input, init)) {
      return nativeFetch(input, init);
    }

    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (init?.signal?.aborted) {
        throw init.signal.reason ?? new Error("Read request aborted");
      }

      const { signal, cleanup } = createAttemptSignal(init?.signal, timeoutMs);
      let response: Response | null = null;

      try {
        const attemptInput = input instanceof Request ? input.clone() : input;
        response = await nativeFetch(attemptInput, { ...init, signal });

        if (!isTransientStatus(response.status) || attempt === maxAttempts) {
          return response;
        }
      } catch (error) {
        if (init?.signal?.aborted) throw error;
        lastError = error;
        if (attempt === maxAttempts) throw error;
      } finally {
        cleanup();
      }

      if (response) await cancelResponseBody(response);
      const delayMs = calculateDelayMilliseconds(
        response,
        attempt,
        baseDelayMs,
        maxDelayMs,
      );
      if (delayMs > 0) await sleep(delayMs);
    }

    throw lastError instanceof Error ? lastError : new Error("Read request failed");
  };
}
