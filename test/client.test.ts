import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, ProductsClient, type FetchLike } from "../src/client.js";

const catalog = Array.from({ length: 5 }, (_, i) => ({
  id: i + 1,
  title: `Product ${i + 1}`,
  price: (i + 1) * 10,
}));

// Fake API that serves slices of the catalog, honouring limit and skip.
function fakeCatalogApi() {
  const calls: string[] = [];
  const fetchFn: FetchLike = async (url) => {
    calls.push(url);
    const params = new URL(url).searchParams;
    const limit = Number(params.get("limit"));
    const skip = Number(params.get("skip"));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        products: catalog.slice(skip, skip + limit),
        total: catalog.length,
        skip,
        limit,
      }),
    };
  };
  return { fetchFn, calls };
}

test("getAll follows pagination until every product is fetched", async () => {
  const { fetchFn, calls } = fakeCatalogApi();
  const client = new ProductsClient({ fetchFn, sleep: async () => {} });

  const products = await client.getAll(2);

  assert.equal(products.length, 5);
  assert.equal(calls.length, 3); // pages of 2, 2 and 1
});

test("retries on 503 with backoff and then succeeds", async () => {
  let attempts = 0;
  const delays: number[] = [];
  const fetchFn: FetchLike = async () => {
    attempts++;
    if (attempts < 3) return { ok: false, status: 503, json: async () => ({}) };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        products: [{ id: 1, title: "A", price: 1 }],
        total: 1,
        skip: 0,
        limit: 30,
      }),
    };
  };
  const client = new ProductsClient({
    fetchFn,
    baseDelayMs: 100,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });

  const products = await client.getAll(30);

  assert.equal(products.length, 1);
  assert.equal(attempts, 3);
  assert.equal(delays.length, 2);
  assert.ok(delays[1] > delays[0], "backoff should grow between attempts");
});

test("does not retry on 404", async () => {
  let attempts = 0;
  const fetchFn: FetchLike = async () => {
    attempts++;
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const client = new ProductsClient({ fetchFn, sleep: async () => {} });

  await assert.rejects(client.getAll(30), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 404);
    return true;
  });
  assert.equal(attempts, 1);
});

test("gives up after maxRetries on persistent 500", async () => {
  let attempts = 0;
  const fetchFn: FetchLike = async () => {
    attempts++;
    return { ok: false, status: 500, json: async () => ({}) };
  };
  const client = new ProductsClient({
    fetchFn,
    maxRetries: 2,
    sleep: async () => {},
  });

  await assert.rejects(client.getAll(30), ApiError);
  assert.equal(attempts, 3); // first try + 2 retries
});

test("rejects responses with an unexpected shape", async () => {
  const fetchFn: FetchLike = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ unexpected: true }),
  });
  const client = new ProductsClient({ fetchFn, sleep: async () => {} });

  await assert.rejects(client.getAll(30), /Unexpected response shape/);
});

test("retries on network errors and then succeeds", async () => {
  let attempts = 0;
  const fetchFn: FetchLike = async () => {
    attempts++;
    if (attempts < 2) throw new TypeError("fetch failed");
    return {
      ok: true,
      status: 200,
      json: async () => ({
        products: [{ id: 1, title: "A", price: 1 }],
        total: 1,
        skip: 0,
        limit: 30,
      }),
    };
  };
  const client = new ProductsClient({ fetchFn, sleep: async () => {} });

  const products = await client.getAll(30);

  assert.equal(products.length, 1);
  assert.equal(attempts, 2);
});
