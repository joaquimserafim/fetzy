/** Default request timeout (ms) when `timeout` is omitted. */
export const DEFAULT_TIMEOUT_MS = 10_000;

export type RequestOptions = RequestInit & {
	/**
	 * Abort the request after this many ms. Defaults to {@link DEFAULT_TIMEOUT_MS}.
	 * A non-positive or non-finite value (`0`, negative, `Infinity`, `NaN`) disables the timeout.
	 */
	timeout?: number;
	/** Defaults to global `fetch` at call time; pass a snapshot to bypass monkey-patched `fetch`. */
	fetchImpl?: typeof fetch;
	/** When true, return {@link RequestResult} so callers can log or metric the round-trip time. */
	withDuration?: boolean;
};

/**
 * Result of {@link fetchx} when `withDuration: true`.
 *
 * Only returned on **successful** fetches. If the underlying fetch rejects
 * (network error, timeout, caller abort), the promise rejects with that
 * error — no structured `{ durationMs, error }` is produced. For failure
 * metrics, wrap the call and measure in your caller.
 */
export type RequestResult = Readonly<{
	response: Response;
	/** Elapsed ms from call start until the response resolved. */
	durationMs: number;
}>;

/**
 * Discriminated Result type returned by {@link tryAsync}, {@link fetchx.try},
 * and {@link fetchx.json.try}. Narrow on `ok` to access `data` or `error`.
 *
 * @example
 * ```ts
 * const res = await fetchx.try("/x");
 * if (res.ok) res.data;   // Response
 * else        res.error;  // Error
 * ```
 */
export type Result<T, E = Error> =
	| { readonly ok: true; readonly data: T }
	| { readonly ok: false; readonly error: E };

/**
 * Wrap a promise: rejections become `{ ok: false, error }`, fulfillment becomes
 * `{ ok: true, data }`. Non-Error rejections (e.g. `throw "boom"`) are coerced
 * into `new Error(String(reason))` so `error` is always an `Error` instance.
 *
 * Useful for composing with anything that returns a promise — including the
 * methods on a `createClient(...)` client:
 *
 * ```ts
 * const res = await tryAsync(api.json.get<User>("/me"));
 * if (res.ok) console.log(res.data);
 * ```
 */
export async function tryAsync<T>(promise: Promise<T>): Promise<Result<T>> {
	try {
		return { ok: true, data: await promise };
	} catch (e) {
		return {
			ok: false,
			error: e instanceof Error ? e : new Error(String(e)),
		};
	}
}

/** Works in browsers, Node, and restricted runtimes (Shopify Functions, older SSR). */
const nowMs = (): number => globalThis.performance?.now?.() ?? Date.now();

/**
 * Combine caller-provided signal(s) with the timeout signal so both can abort
 * the underlying fetch. Uses native `AbortSignal.any` when available
 * (Node 20.3+, modern browsers) and falls back to event-based merging.
 */
const combineSignals = (signals: (AbortSignal | undefined)[]): AbortSignal => {
	const real = signals.filter((s): s is AbortSignal => s != null);
	if (real.length === 1) return real[0];
	const Any = (
		AbortSignal as unknown as {
			any?: (s: AbortSignal[]) => AbortSignal;
		}
	).any;
	if (typeof Any === "function") return Any(real);

	const controller = new AbortController();
	// Track listeners so we can detach them when the combined signal aborts —
	// prevents accumulation on long-lived caller signals reused across requests.
	const listeners: Array<{ signal: AbortSignal; handler: () => void }> = [];
	const cleanup = () => {
		for (const { signal, handler } of listeners) {
			signal.removeEventListener("abort", handler);
		}
		listeners.length = 0;
	};

	for (const s of real) {
		if (s.aborted) {
			cleanup();
			controller.abort(s.reason);
			return controller.signal;
		}
		const handler = () => {
			cleanup();
			controller.abort(s.reason);
		};
		listeners.push({ signal: s, handler });
		s.addEventListener("abort", handler, { once: true });
	}
	// Also clean up if the controller aborts for any other reason (e.g. timeout).
	controller.signal.addEventListener("abort", cleanup, { once: true });
	return controller.signal;
};

/**
 * Makes a fetch request with a configurable timeout.
 *
 * - Caller-provided `signal` is preserved: either it **or** the timeout can abort the request.
 * - On timeout, the abort reason is an `Error` with `name === "TimeoutError"` so callers
 *   can distinguish timeout from external cancellation.
 *
 * Pass `withDuration: true` to receive timing alongside the {@link Response}.
 */
async function fetchxImpl(
	url: string | URL | Request,
	options: RequestOptions & { withDuration: true },
): Promise<RequestResult>;
async function fetchxImpl(
	url: string | URL | Request,
	options?: RequestOptions,
): Promise<Response>;
async function fetchxImpl(
	url: string | URL | Request,
	options: RequestOptions = {},
): Promise<Response | RequestResult> {
	const {
		timeout = DEFAULT_TIMEOUT_MS,
		fetchImpl,
		withDuration,
		signal: callerSignal,
		...fetchOptions
	} = options;
	const doFetch = fetchImpl ?? fetch;
	// A non-positive or non-finite timeout (0, negative, Infinity, NaN) disables the
	// timeout entirely, instead of arming a 0 ms timer that aborts on the next tick.
	const timeoutActive = Number.isFinite(timeout) && timeout > 0;
	const timeoutController = new AbortController();
	const timeoutId = timeoutActive
		? setTimeout(() => {
				// Plain Error (portable across Node, browsers, edge runtimes, WASM).
				// `DOMException` is not universally available; matching `err.name === "TimeoutError"`
				// works on both Error and DOMException so callers can distinguish timeouts.
				const err = new Error(`fetchx timeout after ${timeout}ms`);
				err.name = "TimeoutError";
				timeoutController.abort(err);
			}, timeout)
		: undefined;
	const startTime = nowMs();

	let response: Response;
	try {
		response = await doFetch(url, {
			...fetchOptions,
			signal: combineSignals([
				callerSignal ?? undefined,
				timeoutActive ? timeoutController.signal : undefined,
			]),
		});
	} finally {
		if (timeoutId !== undefined) clearTimeout(timeoutId);
	}

	const durationMs = nowMs() - startTime;
	return withDuration
		? { response, durationMs: Number(durationMs.toFixed(2)) }
		: response;
}

function fetchxTryImpl(
	url: string | URL | Request,
	options: RequestOptions & { withDuration: true },
): Promise<Result<RequestResult>>;
function fetchxTryImpl(
	url: string | URL | Request,
	options?: RequestOptions,
): Promise<Result<Response>>;
function fetchxTryImpl(
	url: string | URL | Request,
	options: RequestOptions = {},
): Promise<Result<Response | RequestResult>> {
	return tryAsync(fetchxImpl(url, options));
}

/**
 * Thrown by {@link fetchx.json} and {@link Client} json helpers when the response
 * status is not 2xx. Carries the parsed body (best-effort) and the original
 * {@link Response} for callers that need headers or to re-read the stream.
 */
export class HttpError extends Error {
	readonly status: number;
	readonly statusText: string;
	readonly response: Response;
	/** Parsed response body — JSON when content-type allows, otherwise the raw text. `undefined` for empty bodies. */
	readonly body: unknown;

	constructor(response: Response, body: unknown) {
		const message = `HTTP ${response.status}${
			response.statusText ? ` ${response.statusText}` : ""
		}`;
		super(message);
		this.name = "HttpError";
		this.status = response.status;
		this.statusText = response.statusText;
		this.response = response;
		this.body = body;
	}
}

export type FetchJsonOptions = Omit<RequestOptions, "withDuration"> & {
	/** Plain value to send as a JSON body. Stringified with `JSON.stringify`; sets `content-type: application/json` if unset. Mutually exclusive with `body`. */
	json?: unknown;
};

const JSON_MIME = "application/json";

const isJsonContentType = (contentType: string | null): boolean => {
	if (!contentType) return false;
	// Compare only the media type, ignoring parameters (e.g. "; charset=utf-8"),
	// and match "json" subtypes plus the structured "+json" suffix — e.g.
	// application/json, text/json, application/ld+json, application/vnd.api+json.
	const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
	return /\/([\w.-]+\+)?json$/.test(mediaType);
};

const parseResponseBody = async (response: Response): Promise<unknown> => {
	if (response.status === 204 || response.status === 205) return undefined;
	const text = await response.text();
	if (!text) return undefined;
	if (isJsonContentType(response.headers.get("content-type"))) {
		return JSON.parse(text);
	}
	return text;
};

/**
 * Convenience helper for JSON APIs.
 *
 * - Sets `accept: application/json` unless the caller already did.
 * - When `json` is provided, serializes it and sets `content-type: application/json`.
 * - Resolves to the parsed JSON body typed as `T`. Empty `204`/`205` resolves to `undefined`.
 * - Rejects with {@link HttpError} on non-2xx, carrying the parsed body when available.
 *
 * Wraps {@link fetchx}, so `timeout`, `signal`, and `fetchImpl` work the same way.
 */
async function fetchxJsonImpl<T = unknown>(
	url: string | URL | Request,
	options: FetchJsonOptions = {},
): Promise<T> {
	const { json, headers, body, ...rest } = options;
	if (json !== undefined && body != null) {
		throw new TypeError(
			"fetchx.json: provide either `json` or `body`, not both",
		);
	}
	const finalHeaders = new Headers(headers);
	if (!finalHeaders.has("accept")) finalHeaders.set("accept", JSON_MIME);
	let finalBody = body;
	if (json !== undefined) {
		finalBody = JSON.stringify(json);
		if (!finalHeaders.has("content-type")) {
			finalHeaders.set("content-type", JSON_MIME);
		}
	}
	const response = await fetchxImpl(url, {
		...rest,
		headers: finalHeaders,
		body: finalBody,
	});
	if (!response.ok) {
		// Read the error body from a clone so `err.response` stays re-readable.
		// Only swallow JSON parse failures (best-effort body); a genuine body-read
		// failure (aborted/dropped stream) surfaces instead of being masked.
		const errBody = await parseResponseBody(response.clone()).catch((e) => {
			if (e instanceof SyntaxError) return undefined;
			throw e;
		});
		throw new HttpError(response, errBody);
	}
	return (await parseResponseBody(response)) as T;
}

function fetchxJsonTryImpl<T = unknown>(
	url: string | URL | Request,
	options: FetchJsonOptions = {},
): Promise<Result<T>> {
	return tryAsync(fetchxJsonImpl<T>(url, options));
}

/**
 * JSON sub-API attached at {@link fetchx.json}: callable with a `.try` method
 * that returns a {@link Result} instead of throwing.
 */
export interface FetchxJson {
	<T = unknown>(
		url: string | URL | Request,
		options?: FetchJsonOptions,
	): Promise<T>;
	/** Like the call signature, but resolves to a {@link Result} instead of rejecting. */
	try<T = unknown>(
		url: string | URL | Request,
		options?: FetchJsonOptions,
	): Promise<Result<T>>;
}

/**
 * Public type of the {@link fetchx} export: a callable `fetch` wrapper with a
 * `.json` helper attached. Use it to type values that should accept the
 * library's main entry point.
 */
export interface Fetchx {
	(
		url: string | URL | Request,
		options: RequestOptions & { withDuration: true },
	): Promise<RequestResult>;
	(url: string | URL | Request, options?: RequestOptions): Promise<Response>;
	/**
	 * Like the call signature, but resolves to a {@link Result} instead of
	 * rejecting. Network errors, timeouts, and caller aborts become
	 * `{ ok: false, error }`.
	 */
	try(
		url: string | URL | Request,
		options: RequestOptions & { withDuration: true },
	): Promise<Result<RequestResult>>;
	try(
		url: string | URL | Request,
		options?: RequestOptions,
	): Promise<Result<Response>>;
	/**
	 * JSON convenience: sets `accept: application/json`, serializes the optional
	 * `json` body, parses the response, and throws {@link HttpError} on non-2xx.
	 * Resolves to `undefined` for empty (204/205) responses.
	 *
	 * Use `fetchx.json.try<T>(...)` to receive a {@link Result} instead.
	 */
	json: FetchxJson;
}

/**
 * `fetch` wrapper with timeout, signal merging, and an optional duration metric.
 *
 * - Caller-provided `signal` is preserved: either it **or** the timeout can abort the request.
 * - On timeout, the abort reason is an `Error` with `name === "TimeoutError"`.
 * - `fetchx.json<T>(url, opts?)` parses and types JSON responses.
 * - `fetchx.try(...)` and `fetchx.json.try<T>(...)` resolve to a {@link Result}
 *   instead of rejecting, so callers can branch on `res.ok` without try/catch.
 */
const fetchxJson: FetchxJson = Object.assign(fetchxJsonImpl, {
	try: fetchxJsonTryImpl,
}) as FetchxJson;

export const fetchx: Fetchx = Object.assign(fetchxImpl, {
	try: fetchxTryImpl,
	json: fetchxJson,
}) as Fetchx;

export type ClientDefaults = {
	/** Prepended to relative paths via `new URL(path, baseUrl)`. */
	baseUrl?: string | URL;
	/** Default headers merged with per-request headers; per-request wins. */
	headers?: HeadersInit;
	/** Default timeout (ms). Per-request `timeout` overrides. */
	timeout?: number;
	/** Default `fetch` implementation. Per-request `fetchImpl` overrides. */
	fetchImpl?: typeof fetch;
};

type RequestOptionsNoMethodBody = Omit<RequestOptions, "method" | "body">;
type JsonOptionsNoMethodBody = Omit<
	FetchJsonOptions,
	"method" | "json" | "body"
>;

export type Client = {
	fetchx(path: string | URL, options?: RequestOptions): Promise<Response>;
	get(
		path: string | URL,
		options?: RequestOptionsNoMethodBody,
	): Promise<Response>;
	post(
		path: string | URL,
		body?: BodyInit | null,
		options?: RequestOptionsNoMethodBody,
	): Promise<Response>;
	put(
		path: string | URL,
		body?: BodyInit | null,
		options?: RequestOptionsNoMethodBody,
	): Promise<Response>;
	patch(
		path: string | URL,
		body?: BodyInit | null,
		options?: RequestOptionsNoMethodBody,
	): Promise<Response>;
	delete(
		path: string | URL,
		options?: RequestOptionsNoMethodBody,
	): Promise<Response>;
	json: {
		get<T = unknown>(
			path: string | URL,
			options?: JsonOptionsNoMethodBody,
		): Promise<T>;
		post<T = unknown>(
			path: string | URL,
			body?: unknown,
			options?: JsonOptionsNoMethodBody,
		): Promise<T>;
		put<T = unknown>(
			path: string | URL,
			body?: unknown,
			options?: JsonOptionsNoMethodBody,
		): Promise<T>;
		patch<T = unknown>(
			path: string | URL,
			body?: unknown,
			options?: JsonOptionsNoMethodBody,
		): Promise<T>;
		delete<T = unknown>(
			path: string | URL,
			options?: JsonOptionsNoMethodBody,
		): Promise<T>;
	};
};

const resolveUrl = (
	base: string | URL | undefined,
	path: string | URL | Request,
): string | URL | Request => {
	if (!base) return path;
	if (path instanceof URL || path instanceof Request) return path;
	return new URL(path, base.toString()).toString();
};

const mergeHeaders = (
	defaults: HeadersInit | undefined,
	overrides: HeadersInit | undefined,
): Headers => {
	const merged = new Headers(defaults);
	if (overrides) {
		new Headers(overrides).forEach((value, key) => {
			merged.set(key, value);
		});
	}
	return merged;
};

/**
 * Build a `fetch` client with shared defaults (`baseUrl`, headers, timeout, `fetchImpl`).
 *
 * Per-request options override the defaults. Headers are merged: the request's
 * header value wins when both define the same name.
 *
 * @example
 * ```ts
 * const api = createClient({ baseUrl: "https://api.example.com", timeout: 5000 });
 * const user = await api.json.get<User>("/me");
 * await api.json.post("/orders", { sku: "abc", qty: 1 });
 * ```
 */
export function createClient(defaults: ClientDefaults = {}): Client {
	const {
		baseUrl,
		headers: defaultHeaders,
		timeout: defaultTimeout,
		fetchImpl: defaultFetchImpl,
	} = defaults;

	const applyDefaults = <
		T extends {
			headers?: HeadersInit;
			timeout?: number;
			fetchImpl?: typeof fetch;
		},
	>(
		options: T,
	): T => ({
		...options,
		headers: mergeHeaders(defaultHeaders, options.headers),
		timeout: options.timeout ?? defaultTimeout,
		fetchImpl: options.fetchImpl ?? defaultFetchImpl,
	});

	const doFetchx = (
		path: string | URL,
		options: RequestOptions = {},
	): Promise<Response> =>
		fetchxImpl(
			resolveUrl(baseUrl, path) as string | URL,
			applyDefaults(options),
		);

	const doJson = <T>(
		path: string | URL,
		options: FetchJsonOptions = {},
	): Promise<T> =>
		fetchxJsonImpl<T>(
			resolveUrl(baseUrl, path) as string | URL,
			applyDefaults(options),
		);

	return {
		fetchx: doFetchx,
		get: (path, options) => doFetchx(path, { ...options, method: "GET" }),
		post: (path, body, options) =>
			doFetchx(path, { ...options, method: "POST", body }),
		put: (path, body, options) =>
			doFetchx(path, { ...options, method: "PUT", body }),
		patch: (path, body, options) =>
			doFetchx(path, { ...options, method: "PATCH", body }),
		delete: (path, options) =>
			doFetchx(path, { ...options, method: "DELETE" }),
		json: {
			get: (path, options) => doJson(path, { ...options, method: "GET" }),
			post: (path, body, options) =>
				doJson(path, { ...options, method: "POST", json: body }),
			put: (path, body, options) =>
				doJson(path, { ...options, method: "PUT", json: body }),
			patch: (path, body, options) =>
				doJson(path, { ...options, method: "PATCH", json: body }),
			delete: (path, options) =>
				doJson(path, { ...options, method: "DELETE" }),
		},
	};
}
