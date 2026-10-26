export interface Product {
  id: number;
  title: string;
  price: number;
}

export interface ProductPage {
  products: Product[];
  total: number;
  skip: number;
  limit: number;
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal },
) => Promise<FetchResponseLike>;

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ClientOptions {
  baseUrl?: string;
  fetchFn?: FetchLike;
  maxRetries?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

// 429 (rate limit) and 5xx are worth retrying; other 4xx are not.
const isRetryable = (status: number) => status === 429 || status >= 500;

function parsePage(body: unknown): ProductPage {
  if (!body || typeof body !== "object") {
    throw new Error("Unexpected response shape: body is not an object");
  }
  const raw = body as Record<string, unknown>;
  if (!Array.isArray(raw.products) || typeof raw.total !== "number") {
    throw new Error("Unexpected response shape: missing products or total");
  }

  const products = raw.products.map((item): Product => {
    const p = item as Record<string, unknown>;
    if (
      typeof p.id !== "number" ||
      typeof p.title !== "string" ||
      typeof p.price !== "number"
    ) {
      throw new Error("Unexpected response shape: invalid product");
    }
    return { id: p.id, title: p.title, price: p.price };
  });

  return {
    products,
    total: raw.total,
    skip: typeof raw.skip === "number" ? raw.skip : 0,
    limit: typeof raw.limit === "number" ? raw.limit : products.length,
  };
}

export class ProductsClient {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? "https://dummyjson.com";
    this.fetchFn =
      options.fetchFn ?? (globalThis.fetch as unknown as FetchLike);
    this.maxRetries = options.maxRetries ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 200;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async getPage(skip: number, limit: number): Promise<ProductPage> {
    const url = `${this.baseUrl}/products?limit=${limit}&skip=${skip}`;
    const body = await this.getWithRetry(url);
    return parsePage(body);
  }

  /** Fetches every product, following offset-based pagination until `total` is reached. */
  async getAll(pageSize = 30): Promise<Product[]> {
    const all: Product[] = [];
    let skip = 0;
    let total = Number.POSITIVE_INFINITY;

    while (skip < total) {
      const page = await this.getPage(skip, pageSize);
      total = page.total;
      if (page.products.length === 0) break; // avoids looping forever on a bad server
      all.push(...page.products);
      skip += page.products.length;
    }

    return all;
  }

  private async getWithRetry(url: string): Promise<unknown> {
    let attempt = 0;

    for (;;) {
      try {
        const res = await this.fetchFn(url, {
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.ok) return await res.json();

        const error = new ApiError(
          `Request failed with status ${res.status}`,
          res.status,
        );
        if (!isRetryable(res.status) || attempt >= this.maxRetries) throw error;
        // retryable status: fall through to the backoff below
      } catch (err) {
        // non-retryable HTTP errors are final
        if (err instanceof ApiError && !isRetryable(err.status)) throw err;
        // network errors and timeouts are retried until the budget is spent
        if (attempt >= this.maxRetries) throw err;
      }

      attempt++;
      // exponential backoff with jitter: base * 2^n + random(0..base)
      const jitter = Math.floor(Math.random() * this.baseDelayMs);
      await this.sleep(this.baseDelayMs * 2 ** (attempt - 1) + jitter);
    }
  }
}
