export type BatchSuccess<K, V> = {
  key: K;
  ok: true;
  value: V;
};

export type BatchFailure<K> = {
  key: K;
  ok: false;
  error: string;
};

export type BatchResult<K, V> = {
  requested: K[];
  items: Array<BatchSuccess<K, V> | BatchFailure<K>>;
  succeeded: number;
  failed: number;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown integration error";
}

export async function runPartialBatch<K, V>(
  requested: K[],
  reader: (key: K) => Promise<V>,
): Promise<BatchResult<K, V>> {
  const unique = [...new Set(requested)];
  const settled = await Promise.allSettled(unique.map((key) => reader(key)));
  const items = settled.map((result, index) => {
    const key = unique[index];
    if (result.status === "fulfilled") {
      return { key, ok: true as const, value: result.value };
    }
    return { key, ok: false as const, error: errorMessage(result.reason) };
  });

  const succeeded = items.filter((item) => item.ok).length;
  return {
    requested: unique,
    items,
    succeeded,
    failed: items.length - succeeded,
  };
}
