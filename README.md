# netzap

[![npm version](https://img.shields.io/npm/v/netzap.svg)](https://www.npmjs.com/package/netzap)
[![license](https://img.shields.io/npm/l/netzap.svg)](./LICENSE)

Tiny, dependency-free `fetch` wrapper for **Node** and **browsers**. Adds the
things the platform `fetch` makes you write by hand: timeouts, signal merging,
a typed JSON helper, and a client factory with shared defaults.

- **Zero runtime dependencies.** **1.87 kB gzipped** (ESM) — see [Size](#size).
- **Isomorphic.** Works wherever `globalThis.fetch` exists (Node 18+, modern browsers, edge runtimes, workers).
- **Type-safe.** First-class TypeScript types, dual ESM/CJS build.
- **Composable.** `netzap` is a thin shell over `fetch`; `netzap.json` and `client` build on top.

## Install

```sh
pnpm add netzap
# or: npm i netzap
# or: yarn add netzap
```

## Quick start

```ts
import { netzap, client, HttpError } from "netzap";

// 1. Plain request with a timeout (default 10s).
const res = await netzap("https://api.example.com/health", { timeout: 2000 });
// → Response

// 2. Typed JSON, errors include the parsed response body.
type User = { id: number; name: string };
const user = await netzap.json<User>("https://api.example.com/users/1");
// → User                          e.g. { id: 1, name: "Ada" }

// 3. A reusable client with a baseUrl and shared headers.
const api = client({
    baseUrl: "https://api.example.com",
    headers: { authorization: `Bearer ${token}` },
    timeout: 5000,
});

const me = await api.json.get<User>("/me");
// → User
await api.json.post("/orders", { sku: "abc", qty: 1 });
// → unknown                       (pass a generic to type the body)
```

## API

### `netzap(url, options?)`

Drop-in replacement for `fetch` with a timeout. Returns a `Response` (or a
`{ response, durationMs }` object when `withDuration: true`).

```ts
const res = await netzap(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    timeout: 3000,             // ms; defaults to DEFAULT_TIMEOUT_MS (10_000)
    signal: controller.signal, // optional — merged with the internal timeout signal
    fetchImpl: myFetch,        // optional — snapshot of `fetch` to bypass monkey-patches
    withDuration: true,        // optional — resolve to { response, durationMs } instead
});
// → { response: Response, durationMs: number }   (because withDuration: true)
// → Response                                     (when withDuration is omitted)
```

- **Caller `signal` is preserved.** It's merged with the timeout signal via
  `AbortSignal.any` (Node 20.3+, modern browsers) or an event-based fallback.
  Either signal can abort the request.
- **Timeout reason is distinguishable.** When the timeout fires, the abort
  reason is an `Error` with `name === "TimeoutError"` — match on that to tell
  apart "we timed out" from "the caller cancelled".
- **`fetchImpl`** is read at call time, so dependency injection or test mocks
  work without retaining a stale reference.
- **Disabling the timeout.** A non-positive or non-finite `timeout` (`0`,
  negative, `Infinity`, `NaN`) arms no timer — the request runs until it settles
  or the caller's `signal` aborts.

### `netzap.json<T>(url, options?)`

Convenience for JSON APIs. Attached to `netzap`; wraps the same underlying call.

- Sets `accept: application/json` unless the caller already did.
- When `json` is provided, serializes it and sets `content-type: application/json`.
- Resolves to the parsed body typed as `T`. Empty responses (status 204/205,
  or empty body) resolve to `undefined`.
- Rejects with [`HttpError`](#httperror) on non-2xx, carrying the parsed body
  when available.
- Pass `maxBytes` to cap the response body — a larger body (by `content-length`
  or while streaming) rejects with [`MaxBytesError`](#maxbyteserror) instead of
  buffering an oversized or hostile response into memory.

```ts
const user = await netzap.json<User>("https://api.example.com/users/1");
// → User                          e.g. { id: 1, name: "Ada" }

const created = await netzap.json<{ id: string }>("https://api.example.com/users", {
    method: "POST",
    json: { name: "Ada", age: 36 }, // serialized + content-type set
});
// → { id: string }                e.g. { id: "usr_42" }

// 204 No Content (or any empty body):
const ack = await netzap.json("https://api.example.com/ping");
// → undefined
```

### `client(defaults?)`

Build a client with shared defaults. Per-request options override the defaults;
headers are merged (request wins on conflicts).

```ts
const api = client({
    baseUrl: "https://api.example.com",
    headers: { authorization: "Bearer …" },
    timeout: 5000,
    fetchImpl: customFetch, // optional
});

// Untyped — returns Response, same as `netzap`.
await api.get("/health");                                  // → Response
await api.post("/events", JSON.stringify({ kind: "ping" }), {
    headers: { "content-type": "application/json" },
});                                                        // → Response

// Typed JSON — returns the parsed body, throws HttpError on non-2xx.
const me = await api.json.get<User>("/me");                // → User
const order = await api.json.post<{ id: string }>("/orders", { sku: "abc", qty: 1 });
// → { id: string }
await api.json.put("/orders/123", { qty: 2 });             // → unknown
await api.json.patch("/orders/123", { qty: 3 });           // → unknown
await api.json.delete("/orders/123");                      // → unknown  (undefined for 204)
```

**URL resolution** uses `new URL(path, baseUrl)`. Watch the trailing slash on
`baseUrl` — it follows standard `URL` semantics:

```ts
client({ baseUrl: "https://api.example.com/v1/" }).get("users");
// → https://api.example.com/v1/users

client({ baseUrl: "https://api.example.com/v1/" }).get("/users");
// → https://api.example.com/users   (leading slash resets the path)
```

Absolute URLs and `URL` instances are passed through unchanged.

**Confining requests to `baseUrl`.** By default a path that resolves to another
origin — an absolute URL, a protocol-relative `//host`, or a `URL` instance —
is sent as-is. If a path may be untrusted and you don't want default headers
(e.g. an auth token) riding to another host, set `restrictToBaseOrigin: true`;
any off-origin request then rejects:

```ts
const api = client({
    baseUrl: "https://api.example.com",
    headers: { authorization: "Bearer …" },
    restrictToBaseOrigin: true,
});

await api.get("/users");                    // → Response  (same origin)
await api.get("https://evil.example.com");  // rejects: "escapes baseUrl origin"
```

It requires a `baseUrl` — `client` throws at construction if
`restrictToBaseOrigin` is set without one.

### `HttpError`

Thrown by `netzap.json` and `client` json helpers when the response status
is not 2xx.

```ts
try {
    await api.json.get("/admin");
} catch (err) {
    if (err instanceof HttpError) {
        err.status;     // number, e.g. 403
        err.statusText; // string, e.g. "Forbidden"
        err.body;       // parsed JSON body, or raw text, or undefined
        err.response;   // the original Response (headers, etc.)
    }
}
```

### `MaxBytesError`

Thrown by `netzap.json` and `client` json helpers when a response body
exceeds the `maxBytes` cap — either its declared `content-length` or the
streamed byte count. Carries the limit that was exceeded:

```ts
try {
    await api.json.get("/big", { maxBytes: 1_000_000 });
} catch (err) {
    if (err instanceof MaxBytesError) {
        err.maxBytes; // number — the cap that was exceeded, e.g. 1000000
    }
}
```

On a non-2xx response the oversized body is dropped (best-effort) and an
[`HttpError`](#httperror) is thrown instead, so you still get the status.

### `Result<T, E>`, `netzap.try`, `netzap.json.try`

Skip the `try`/`catch` ceremony for failures you already know how to handle.
Each `.try` variant resolves to a discriminated `Result` instead of rejecting:

```ts
export type Result<T, E = Error> =
  | { readonly ok: true;  readonly data: T }
  | { readonly ok: false; readonly error: E };
```

#### What errors can I see?

The library defines **two error types — [`HttpError`](#httperror) and [`MaxBytesError`](#maxbyteserror)** — both thrown only by the JSON paths (`netzap.json`, `client.json.*`): `HttpError` on non-2xx responses, and `MaxBytesError` when a `maxBytes` cap is exceeded. Every other failure comes straight from the platform `fetch`:

- **Network error** — what `fetch` itself rejects with (typically a `TypeError` like `"fetch failed"`).
- **Timeout** — an `Error` with `name === "TimeoutError"` (set by this library when the internal timeout fires).
- **Caller abort** — whatever you passed to `controller.abort(reason)`, or a `DOMException` `AbortError` if no reason was given.

**Non-2xx is handled differently per path:**

| Path                                        | Behavior on non-2xx                                       |
| ------------------------------------------- | --------------------------------------------------------- |
| `netzap`, `client.get/post/put/patch/delete` | Resolves to a `Response`; you check `response.ok` yourself. **Never throws / returns `HttpError`.** |
| `netzap.json`, `client.json.*`              | **Throws `HttpError`** (or `{ ok: false, error: HttpError }` from `.try`). |

Both failure-handling styles — `try/catch` and `.try` returning a `Result` — see the **same** set of errors. They differ only in how you read them. Note that the static type of `error` is always `Error` (or `HttpError extends Error` at runtime — narrow with `instanceof HttpError` when you need the status/body).

```ts
import { netzap, HttpError } from "netzap";

type User = { id: number; name: string };

const res = await netzap.try("https://api.example.com/health", { timeout: 2000 });
if (res.ok) {
    res.data;     // Response
} else {
    res.error;    // Error  (network error | TimeoutError | caller abort)
}
// → { ok: true, data: Response } | { ok: false, error: Error }

const u = await netzap.json.try<User>("https://api.example.com/users/1");
if (u.ok) {
    u.data;       // User
} else {
    u.error;      // Error  (runtime: HttpError on non-2xx | TimeoutError | network error)
    if (u.error instanceof HttpError) {
        u.error.status;  // narrow to read .status / .body / .response
    }
}
// → { ok: true, data: User } | { ok: false, error: Error }
```

The client mirrors this with **`.try` namespaces** — `api.try.*` for plain
responses (`Result<Response>`) and `api.json.try.*` for parsed bodies
(`Result<T>`) — so client calls branch on `res.ok` without a `try`/`catch`:

```ts
const api = client({ baseUrl: "https://api.example.com" });

const health = await api.try.get("/health");    // → Result<Response>
if (!health.ok) return; // network error / timeout / abort

const me = await api.json.try.get<User>("/me");  // → Result<User>
if (me.ok) console.log(me.data);
else       console.error(me.error); // HttpError on non-2xx, else a network/timeout Error
```

Non-`Error` rejections (`throw "boom"`, `Promise.reject(undefined)`) are
coerced into `new Error(String(reason))` so `res.error` is always an `Error`
instance — no defensive `instanceof` checks on the failure branch.

### `DEFAULT_TIMEOUT_MS`

The default timeout used when `timeout` is omitted (`10_000` ms). Exported
mainly for tests and for callers that want to align their own defaults.

## Recipes

### Distinguishing timeout from caller cancellation

```ts
try {
    await netzap(url, { timeout: 2000, signal });
} catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
        // we timed out
    } else {
        // caller aborted, or network error
    }
}
```

### Measuring round-trip time

```ts
const { response, durationMs } = await netzap(url, { withDuration: true });
// response  → Response
// durationMs → number  (ms, rounded to 0.01)
metrics.histogram("api.latency", durationMs);
```

Only the success path returns `{ response, durationMs }`. Failures still
reject — wrap and measure in your caller if you need failure timings.

### Replacing `fetch` for testing

```ts
const stub = vi.fn().mockResolvedValue(new Response("{}"));
await netzap(url, { fetchImpl: stub });
```

## Size

| What                                | Raw     | Gzipped     |
| ----------------------------------- | ------- | ----------- |
| **ESM runtime** (`index.mjs`)       | 4.50 kB | **1.87 kB** |
| CJS runtime (`index.cjs`)           | 4.58 kB | 1.90 kB     |
| Types (`.d.mts` / `.d.cts`)         | 8.68 kB | 2.67 kB     |
| Sourcemaps (debug-only, not loaded) | 30.8 kB | 8.75 kB     |

The number a modern bundler counts toward your app is **1.87 kB gzipped**.
Zero runtime dependencies, so nothing else ships with it.

For context: ofetch ~1.6 kB, ky ~3.7 kB, axios ~13 kB (all gzipped).

## License

MIT © [@joaquimserafim](https://github.com/joaquimserafim)
