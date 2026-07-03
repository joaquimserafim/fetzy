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
 * Result of {@link netzap} when `withDuration: true`.
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
 * Discriminated Result type returned by {@link netzap.try} and
 * {@link netzap.json.try} (and the client `.try` methods). Narrow on `ok` to
 * access `data` or `error`.
 *
 * @example
 * ```ts
 * const res = await netzap.try("/x");
 * if (res.ok) res.data;   // Response
 * else        res.error;  // Error
 * ```
 */
export type Result<T, E = Error> =
	| { readonly ok: true; readonly data: T }
	| { readonly ok: false; readonly error: E };

/**
 * Internal: wrap a promise so rejections become `{ ok: false, error }` and
 * fulfillment becomes `{ ok: true, data }`. Non-Error rejections (e.g.
 * `throw "boom"`) are coerced into `new Error(String(reason))` so `error` is
 * always an `Error` instance. Powers the `.try` variants.
 */
async function tryAsync<T>(promise: Promise<T>): Promise<Result<T>> {
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

/** A combined abort signal plus a `dispose` that detaches any fallback listeners. */
type CombinedSignal = { signal: AbortSignal; dispose: () => void };

/**
 * Combine caller-provided signal(s) with the timeout signal so both can abort
 * the underlying fetch. Uses native `AbortSignal.any` when available
 * (Node 20.3+, modern browsers) and falls back to event-based merging.
 *
 * The returned `dispose` detaches any listeners the fallback attached; callers
 * must invoke it once the request settles so they don't accumulate on
 * long-lived caller signals reused across requests.
 */
const combineSignals = (
	signals: (AbortSignal | undefined)[],
): CombinedSignal => {
	const noop = () => {};
	const real = signals.filter((s): s is AbortSignal => s != null);
	if (real.length === 1) return { signal: real[0], dispose: noop };
	const Any = (
		AbortSignal as unknown as {
			any?: (s: AbortSignal[]) => AbortSignal;
		}
	).any;
	if (typeof Any === "function") return { signal: Any(real), dispose: noop };

	const controller = new AbortController();
	// Track listeners so we can detach them once the request settles (via
	// `dispose`) or on abort — otherwise they accumulate on long-lived caller
	// signals reused across requests.
	const listeners: Array<{ signal: AbortSignal; handler: () => void }> = [];
	const dispose = () => {
		for (const { signal, handler } of listeners) {
			signal.removeEventListener("abort", handler);
		}
		listeners.length = 0;
	};

	for (const s of real) {
		if (s.aborted) {
			dispose();
			controller.abort(s.reason);
			return { signal: controller.signal, dispose };
		}
		const handler = () => {
			dispose();
			controller.abort(s.reason);
		};
		listeners.push({ signal: s, handler });
		s.addEventListener("abort", handler, { once: true });
	}
	return { signal: controller.signal, dispose };
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
async function netzapImpl(
	url: string | URL | Request,
	options: RequestOptions & { withDuration: true },
): Promise<RequestResult>;
async function netzapImpl(
	url: string | URL | Request,
	options?: RequestOptions,
): Promise<Response>;
async function netzapImpl(
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
				const err = new Error(`netzap timeout after ${timeout}ms`);
				err.name = "TimeoutError";
				timeoutController.abort(err);
			}, timeout)
		: undefined;
	const startTime = nowMs();
	const combined = combineSignals([
		callerSignal ?? undefined,
		timeoutActive ? timeoutController.signal : undefined,
	]);

	let response: Response;
	try {
		response = await doFetch(url, {
			...fetchOptions,
			signal: combined.signal,
		});
	} finally {
		if (timeoutId !== undefined) clearTimeout(timeoutId);
		combined.dispose();
	}

	const durationMs = nowMs() - startTime;
	return withDuration
		? { response, durationMs: Number(durationMs.toFixed(2)) }
		: response;
}

function netzapTryImpl(
	url: string | URL | Request,
	options: RequestOptions & { withDuration: true },
): Promise<Result<RequestResult>>;
function netzapTryImpl(
	url: string | URL | Request,
	options?: RequestOptions,
): Promise<Result<Response>>;
function netzapTryImpl(
	url: string | URL | Request,
	options: RequestOptions = {},
): Promise<Result<Response | RequestResult>> {
	return tryAsync(netzapImpl(url, options));
}

/**
 * Thrown by {@link netzap.json} and {@link Client} json helpers when the response
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
	/**
	 * Cap the response body at this many bytes. Rejects early when `content-length`
	 * exceeds it, and otherwise while streaming, guarding the JSON parse against
	 * oversized or hostile responses. Omit for no cap.
	 */
	maxBytes?: number;
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

/**
 * Thrown by the JSON helpers when a response body exceeds the `maxBytes` cap,
 * either via its declared `content-length` or the streamed byte count.
 */
export class MaxBytesError extends Error {
	readonly maxBytes: number;
	constructor(maxBytes: number) {
		super(`netzap: response body exceeds maxBytes (${maxBytes})`);
		this.name = "MaxBytesError";
		this.maxBytes = maxBytes;
	}
}

/**
 * Read a response body as text, rejecting if it exceeds `maxBytes`. Checks the
 * declared `content-length` first, then enforces the budget while streaming (so
 * responses that omit or understate `content-length` are still capped). Falls
 * back to `response.text()` when no stream is exposed (some runtimes/mocks).
 */
const readBodyText = async (
	response: Response,
	maxBytes?: number,
): Promise<string> => {
	if (maxBytes === undefined) return response.text();
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes)
		throw new MaxBytesError(maxBytes);
	const body = response.body;
	if (!body) return response.text();
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			// Best-effort, don't await: cancelling a cloned/tee'd body stream (the
			// error-body path) never resolves in undici, which would hang the call.
			reader.cancel().catch(() => {});
			throw new MaxBytesError(maxBytes);
		}
		chunks.push(value);
	}
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(merged);
};

const parseResponseBody = async (
	response: Response,
	maxBytes?: number,
): Promise<unknown> => {
	if (response.status === 204 || response.status === 205) return undefined;
	const text = await readBodyText(response, maxBytes);
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
 * Wraps {@link netzap}, so `timeout`, `signal`, and `fetchImpl` work the same way.
 */
async function netzapJsonImpl<T = unknown>(
	url: string | URL | Request,
	options: FetchJsonOptions = {},
): Promise<T> {
	const { json, headers, body, maxBytes, ...rest } = options;
	if (json !== undefined && body != null) {
		throw new TypeError(
			"netzap.json: provide either `json` or `body`, not both",
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
	const response = await netzapImpl(url, {
		...rest,
		headers: finalHeaders,
		body: finalBody,
	});
	if (!response.ok) {
		// Read the error body from a clone so `err.response` stays re-readable.
		// Best-effort: swallow a JSON parse failure or an over-`maxBytes` body so
		// the caller still gets an HttpError with the status; a genuine body-read
		// failure (aborted/dropped stream) surfaces instead of being masked.
		const errBody = await parseResponseBody(
			response.clone(),
			maxBytes,
		).catch((e) => {
			if (e instanceof SyntaxError || e instanceof MaxBytesError)
				return undefined;
			throw e;
		});
		throw new HttpError(response, errBody);
	}
	return (await parseResponseBody(response, maxBytes)) as T;
}

function netzapJsonTryImpl<T = unknown>(
	url: string | URL | Request,
	options: FetchJsonOptions = {},
): Promise<Result<T>> {
	return tryAsync(netzapJsonImpl<T>(url, options));
}

/**
 * JSON sub-API attached at {@link netzap.json}: callable with a `.try` method
 * that returns a {@link Result} instead of throwing.
 */
export interface NetzapJson {
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
 * Public type of the {@link netzap} export: a callable `fetch` wrapper with a
 * `.json` helper attached. Use it to type values that should accept the
 * library's main entry point.
 */
export interface Netzap {
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
	 * Use `netzap.json.try<T>(...)` to receive a {@link Result} instead.
	 */
	json: NetzapJson;
}

/**
 * `fetch` wrapper with timeout, signal merging, and an optional duration metric.
 *
 * - Caller-provided `signal` is preserved: either it **or** the timeout can abort the request.
 * - On timeout, the abort reason is an `Error` with `name === "TimeoutError"`.
 * - `netzap.json<T>(url, opts?)` parses and types JSON responses.
 * - `netzap.try(...)` and `netzap.json.try<T>(...)` resolve to a {@link Result}
 *   instead of rejecting, so callers can branch on `res.ok` without try/catch.
 */
const netzapJson: NetzapJson = Object.assign(netzapJsonImpl, {
	try: netzapJsonTryImpl,
}) as NetzapJson;

export const netzap: Netzap = Object.assign(netzapImpl, {
	try: netzapTryImpl,
	json: netzapJson,
}) as Netzap;

export type ClientDefaults = {
	/** Prepended to relative paths via `new URL(path, baseUrl)`. */
	baseUrl?: string | URL;
	/** Default headers merged with per-request headers; per-request wins. */
	headers?: HeadersInit;
	/** Default timeout (ms). Per-request `timeout` overrides. */
	timeout?: number;
	/** Default `fetch` implementation. Per-request `fetchImpl` overrides. */
	fetchImpl?: typeof fetch;
	/**
	 * When true, throw if a request resolves to an origin other than `baseUrl`'s
	 * (including absolute-URL, protocol-relative, or `URL`-instance paths).
	 * Guards default headers (e.g. auth tokens) from riding to an unintended
	 * host when a path may be untrusted. Requires `baseUrl`. Default false.
	 */
	restrictToBaseOrigin?: boolean;
};

type RequestOptionsNoMethodBody = Omit<RequestOptions, "method" | "body">;
type JsonOptionsNoMethodBody = Omit<
	FetchJsonOptions,
	"method" | "json" | "body"
>;

export type Client = {
	netzap(path: string | URL, options?: RequestOptions): Promise<Response>;
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
		/**
		 * Result-returning variants of the json methods: resolve to a
		 * {@link Result} instead of rejecting, so callers can branch on
		 * `res.ok` without a try/catch.
		 */
		try: {
			get<T = unknown>(
				path: string | URL,
				options?: JsonOptionsNoMethodBody,
			): Promise<Result<T>>;
			post<T = unknown>(
				path: string | URL,
				body?: unknown,
				options?: JsonOptionsNoMethodBody,
			): Promise<Result<T>>;
			put<T = unknown>(
				path: string | URL,
				body?: unknown,
				options?: JsonOptionsNoMethodBody,
			): Promise<Result<T>>;
			patch<T = unknown>(
				path: string | URL,
				body?: unknown,
				options?: JsonOptionsNoMethodBody,
			): Promise<Result<T>>;
			delete<T = unknown>(
				path: string | URL,
				options?: JsonOptionsNoMethodBody,
			): Promise<Result<T>>;
		};
	};
	/**
	 * Result-returning variants of the plain (non-json) methods: resolve to a
	 * {@link Result}`<Response>` instead of rejecting on network error, timeout,
	 * or caller abort. Mirrors {@link netzap.try}.
	 */
	try: {
		netzap(
			path: string | URL,
			options?: RequestOptions,
		): Promise<Result<Response>>;
		get(
			path: string | URL,
			options?: RequestOptionsNoMethodBody,
		): Promise<Result<Response>>;
		post(
			path: string | URL,
			body?: BodyInit | null,
			options?: RequestOptionsNoMethodBody,
		): Promise<Result<Response>>;
		put(
			path: string | URL,
			body?: BodyInit | null,
			options?: RequestOptionsNoMethodBody,
		): Promise<Result<Response>>;
		patch(
			path: string | URL,
			body?: BodyInit | null,
			options?: RequestOptionsNoMethodBody,
		): Promise<Result<Response>>;
		delete(
			path: string | URL,
			options?: RequestOptionsNoMethodBody,
		): Promise<Result<Response>>;
	};
};

const originOf = (u: string | URL): string => new URL(u.toString()).origin;

const resolveUrl = (
	base: string | URL | undefined,
	path: string | URL,
	restrictToBaseOrigin: boolean,
): string | URL => {
	if (!base) return path;
	const resolved =
		path instanceof URL ? path : new URL(path, base.toString());
	if (restrictToBaseOrigin && resolved.origin !== originOf(base)) {
		throw new Error(
			`netzap: request to ${resolved.origin} escapes baseUrl origin ${originOf(base)}`,
		);
	}
	return path instanceof URL ? path : resolved.toString();
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
 * const api = client({ baseUrl: "https://api.example.com", timeout: 5000 });
 * const user = await api.json.get<User>("/me");
 * await api.json.post("/orders", { sku: "abc", qty: 1 });
 * ```
 */
export function client(defaults: ClientDefaults = {}): Client {
	const {
		baseUrl,
		headers: defaultHeaders,
		timeout: defaultTimeout,
		fetchImpl: defaultFetchImpl,
		restrictToBaseOrigin = false,
	} = defaults;

	// Fail closed: the origin guard is meaningless without a base to compare against.
	if (restrictToBaseOrigin && !baseUrl) {
		throw new Error(
			"netzap: client requires `baseUrl` when `restrictToBaseOrigin` is true",
		);
	}

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

	const doNetzap = async (
		path: string | URL,
		options: RequestOptions = {},
	): Promise<Response> =>
		netzapImpl(
			resolveUrl(baseUrl, path, restrictToBaseOrigin),
			applyDefaults(options),
		);

	const doJson = async <T>(
		path: string | URL,
		options: FetchJsonOptions = {},
	): Promise<T> =>
		netzapJsonImpl<T>(
			resolveUrl(baseUrl, path, restrictToBaseOrigin),
			applyDefaults(options),
		);

	return {
		netzap: doNetzap,
		get: (path, options) => doNetzap(path, { ...options, method: "GET" }),
		post: (path, body, options) =>
			doNetzap(path, { ...options, method: "POST", body }),
		put: (path, body, options) =>
			doNetzap(path, { ...options, method: "PUT", body }),
		patch: (path, body, options) =>
			doNetzap(path, { ...options, method: "PATCH", body }),
		delete: (path, options) =>
			doNetzap(path, { ...options, method: "DELETE" }),
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
			try: {
				get: (path, options) =>
					tryAsync(doJson(path, { ...options, method: "GET" })),
				post: (path, body, options) =>
					tryAsync(
						doJson(path, {
							...options,
							method: "POST",
							json: body,
						}),
					),
				put: (path, body, options) =>
					tryAsync(
						doJson(path, { ...options, method: "PUT", json: body }),
					),
				patch: (path, body, options) =>
					tryAsync(
						doJson(path, {
							...options,
							method: "PATCH",
							json: body,
						}),
					),
				delete: (path, options) =>
					tryAsync(doJson(path, { ...options, method: "DELETE" })),
			},
		},
		try: {
			netzap: (path, options) => tryAsync(doNetzap(path, options)),
			get: (path, options) =>
				tryAsync(doNetzap(path, { ...options, method: "GET" })),
			post: (path, body, options) =>
				tryAsync(doNetzap(path, { ...options, method: "POST", body })),
			put: (path, body, options) =>
				tryAsync(doNetzap(path, { ...options, method: "PUT", body })),
			patch: (path, body, options) =>
				tryAsync(doNetzap(path, { ...options, method: "PATCH", body })),
			delete: (path, options) =>
				tryAsync(doNetzap(path, { ...options, method: "DELETE" })),
		},
	};
}
