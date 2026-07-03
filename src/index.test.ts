import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	createClient,
	DEFAULT_TIMEOUT_MS,
	fetchx,
	HttpError,
	MaxBytesError,
	tryAsync,
} from "./index";

/** Minimal Response-like shape used by mocks; cast to Response at the boundary. */
const jsonResponse = (
	body: unknown,
	init: { status?: number; statusText?: string; headers?: HeadersInit } = {},
): Response =>
	new Response(body === undefined ? "" : JSON.stringify(body), {
		status: init.status ?? 200,
		statusText: init.statusText ?? "OK",
		headers: { "content-type": "application/json", ...init.headers },
	});

const textResponse = (
	body: string,
	init: { status?: number; statusText?: string; headers?: HeadersInit } = {},
): Response =>
	new Response(body, {
		status: init.status ?? 200,
		statusText: init.statusText ?? "OK",
		headers: { "content-type": "text/plain", ...init.headers },
	});

describe("fetchx", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should make a successful fetch request", async () => {
		const mockResponse = { ok: true };
		globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

		const response = await fetchx("https://api.example.com");

		expect(fetch).toHaveBeenCalledWith("https://api.example.com", {
			signal: expect.any(AbortSignal),
		});
		expect(response).toBe(mockResponse);
	});

	it("should abort request after timeout", async () => {
		globalThis.fetch = vi
			.fn()
			.mockImplementation((_, options: RequestInit) => {
				const signal = options?.signal as AbortSignal;
				return new Promise((_, reject) => {
					signal.addEventListener("abort", () => {
						reject(new Error("AbortError"));
					});
				});
			});

		await expect(
			fetchx("https://api.example.com", { timeout: 50 }),
		).rejects.toThrow("AbortError");
	}, 1000);

	it("should pass through fetch options", async () => {
		const mockResponse = { ok: true };
		globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

		const options = {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ test: true }),
		};

		await fetchx("https://api.example.com", options);

		expect(fetch).toHaveBeenCalledWith("https://api.example.com", {
			...options,
			signal: expect.any(AbortSignal),
		});
	});

	it("should use fetchImpl when provided", async () => {
		const mockResponse = { ok: true };
		const customFetch = vi.fn().mockResolvedValue(mockResponse);
		globalThis.fetch = vi.fn();

		const response = await fetchx("https://api.example.com", {
			fetchImpl: customFetch,
		});

		expect(customFetch).toHaveBeenCalled();
		expect(globalThis.fetch).not.toHaveBeenCalled();
		expect(response).toBe(mockResponse);
	});

	it("should return duration when withDuration is true", async () => {
		const mockResponse = { ok: true } as Response;
		globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

		const out = await fetchx("https://api.example.com", {
			withDuration: true,
		});

		expect(out.response).toBe(mockResponse);
		expect(out.durationMs).toBeGreaterThanOrEqual(0);
		expect(Number.isFinite(out.durationMs)).toBe(true);
		/** Regression: must not silently return plain Response or leak extra keys */
		expect(Object.keys(out as object).sort()).toEqual([
			"durationMs",
			"response",
		]);
	});

	it("aborts with TimeoutError reason when timeout fires", async () => {
		globalThis.fetch = vi
			.fn()
			.mockImplementation((_, options: RequestInit) => {
				const signal = options?.signal as AbortSignal;
				return new Promise((_, reject) => {
					signal.addEventListener("abort", () => {
						reject(signal.reason);
					});
				});
			});

		try {
			await fetchx("https://api.example.com", { timeout: 20 });
			expect.fail("expected to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).name).toBe("TimeoutError");
			expect((err as Error).message).toContain("20ms");
		}
	});

	it("respects caller-provided signal (caller abort cancels fetch)", async () => {
		globalThis.fetch = vi
			.fn()
			.mockImplementation((_, options: RequestInit) => {
				const signal = options?.signal as AbortSignal;
				return new Promise((_, reject) => {
					signal.addEventListener("abort", () => {
						reject(signal.reason);
					});
				});
			});

		const controller = new AbortController();
		const callerReason = new Error("user cancelled");

		const pending = fetchx("https://api.example.com", {
			signal: controller.signal,
			timeout: 5000,
		});

		setTimeout(() => controller.abort(callerReason), 10);

		await expect(pending).rejects.toBe(callerReason);
	});

	it("does not replace caller signal on the fetch options", async () => {
		const mockResponse = { ok: true };
		globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

		const controller = new AbortController();
		await fetchx("https://api.example.com", {
			signal: controller.signal,
		});

		// signal passed to fetch should exist and be aborted when either
		// the caller's signal OR the internal timeout aborts
		const calledWith = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
			.calls[0][1] as RequestInit;
		expect(calledWith.signal).toBeInstanceOf(AbortSignal);
	});

	it("merges caller signal with timeout — fetch signal is not the caller instance", async () => {
		/** Regression: passing only `controller.signal` would drop timeout behavior */
		const mockResponse = { ok: true };
		globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);
		const controller = new AbortController();

		await fetchx("https://api.example.com", {
			signal: controller.signal,
			timeout: 60_000,
		});

		const passed = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
			.calls[0][1] as RequestInit;
		expect(passed.signal).not.toBe(controller.signal);
	});

	describe("combineSignals fallback (no AbortSignal.any)", () => {
		// Simulate older runtimes by removing AbortSignal.any before the test
		// and restoring it after.
		const originalAny = (AbortSignal as unknown as { any?: unknown }).any;

		beforeEach(() => {
			(AbortSignal as unknown as { any?: unknown }).any = undefined;
		});

		afterEach(() => {
			(AbortSignal as unknown as { any?: unknown }).any = originalAny;
		});

		it("caller signal abort propagates via fallback", async () => {
			globalThis.fetch = vi
				.fn()
				.mockImplementation((_, options: RequestInit) => {
					const signal = options?.signal as AbortSignal;
					return new Promise((_, reject) => {
						signal.addEventListener("abort", () => {
							reject(signal.reason);
						});
					});
				});

			const controller = new AbortController();
			const reason = new Error("fallback cancel");

			const pending = fetchx("https://api.example.com", {
				signal: controller.signal,
				timeout: 5000,
			});
			setTimeout(() => controller.abort(reason), 10);

			await expect(pending).rejects.toBe(reason);
		});

		it("timeout abort propagates via fallback", async () => {
			globalThis.fetch = vi
				.fn()
				.mockImplementation((_, options: RequestInit) => {
					const signal = options?.signal as AbortSignal;
					return new Promise((_, reject) => {
						signal.addEventListener("abort", () => {
							reject(signal.reason);
						});
					});
				});

			const controller = new AbortController();
			try {
				await fetchx("https://api.example.com", {
					signal: controller.signal,
					timeout: 20,
				});
				expect.fail("expected to throw");
			} catch (err) {
				expect(err).toBeInstanceOf(Error);
				expect((err as Error).name).toBe("TimeoutError");
			}
		});

		it("already-aborted caller signal aborts immediately via fallback", async () => {
			globalThis.fetch = vi
				.fn()
				.mockImplementation((_, options: RequestInit) => {
					const signal = options?.signal as AbortSignal;
					if (signal.aborted) return Promise.reject(signal.reason);
					return new Promise((_, reject) => {
						signal.addEventListener("abort", () => {
							reject(signal.reason);
						});
					});
				});

			const controller = new AbortController();
			const reason = new Error("pre-aborted");
			controller.abort(reason);

			await expect(
				fetchx("https://api.example.com", {
					signal: controller.signal,
					timeout: 5000,
				}),
			).rejects.toBe(reason);
		});

		it("removes caller-signal listeners after a successful request (no leak)", async () => {
			// Regression (finding #4): on the success path the fallback used to
			// leave its abort listener attached to a reused caller signal.
			globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
			const controller = new AbortController();
			const removeSpy = vi.spyOn(
				controller.signal,
				"removeEventListener",
			);

			await fetchx("https://api.example.com", {
				signal: controller.signal,
				timeout: 5000,
			});

			expect(removeSpy).toHaveBeenCalledWith(
				"abort",
				expect.any(Function),
			);
			removeSpy.mockRestore();
		});
	});

	it("passes through the single signal when only one is provided (no combining)", async () => {
		// Covers the `real.length === 1` short-circuit in combineSignals.
		// The fetch is called with an AbortSignal equal to combineSignals([timeoutSignal])
		// (no caller signal), which returns the timeout signal directly.
		const mockResponse = { ok: true };
		globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

		await fetchx("https://api.example.com");

		const calledWith = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
			.calls[0][1] as RequestInit;
		expect(calledWith.signal).toBeInstanceOf(AbortSignal);
		expect(calledWith.signal?.aborted).toBe(false);
	});

	describe("withDuration + failures (nuance: timing only on success path)", () => {
		it("rejects on fetch error — does not resolve RequestResult", async () => {
			globalThis.fetch = vi
				.fn()
				.mockRejectedValue(new Error("network down"));

			await expect(
				fetchx("https://api.example.com", { withDuration: true }),
			).rejects.toThrow("network down");
		});

		it("fetch error + withDuration: promise status is rejected, not fulfilled", async () => {
			globalThis.fetch = vi
				.fn()
				.mockRejectedValue(new Error("network down"));
			const settled = await Promise.allSettled([
				fetchx("https://api.example.com", { withDuration: true }),
			]);
			expect(settled[0]?.status).toBe("rejected");
			if (settled[0]?.status === "rejected") {
				expect(settled[0].reason).toMatchObject({
					message: "network down",
				});
			}
		});

		it("rejects on timeout — does not resolve with durationMs", async () => {
			globalThis.fetch = vi
				.fn()
				.mockImplementation((_, options: RequestInit) => {
					const signal = options?.signal as AbortSignal;
					return new Promise((_, reject) => {
						signal.addEventListener("abort", () => {
							reject(signal.reason);
						});
					});
				});

			await expect(
				fetchx("https://api.example.com", {
					withDuration: true,
					timeout: 25,
				}),
			).rejects.toMatchObject({ name: "TimeoutError" });
		});

		it("rejects on caller abort — does not resolve with durationMs", async () => {
			globalThis.fetch = vi
				.fn()
				.mockImplementation((_, options: RequestInit) => {
					const signal = options?.signal as AbortSignal;
					return new Promise((_, reject) => {
						signal.addEventListener("abort", () => {
							reject(signal.reason);
						});
					});
				});

			const controller = new AbortController();
			const reason = new Error("user dismissed");
			const pending = fetchx("https://api.example.com", {
				withDuration: true,
				signal: controller.signal,
				timeout: 5000,
			});
			setTimeout(() => controller.abort(reason), 10);

			await expect(pending).rejects.toBe(reason);
		});
	});

	it("strips request-only options from the init passed to fetch", async () => {
		const mockResponse = { ok: true };
		const customFetch = vi.fn().mockResolvedValue(mockResponse);
		globalThis.fetch = vi.fn();

		await fetchx("https://api.example.com", {
			method: "POST",
			withDuration: true,
			timeout: 8888,
			fetchImpl: customFetch,
		});

		const opts = customFetch.mock.calls[0][1] as Record<string, unknown>;
		expect(opts).not.toHaveProperty("withDuration");
		expect(opts).not.toHaveProperty("timeout");
		expect(opts).not.toHaveProperty("fetchImpl");
		expect(opts.method).toBe("POST");
		expect(opts.signal).toBeInstanceOf(AbortSignal);
	});

	describe("regression detectors (impl must fail these if behavior breaks)", () => {
		it("schedules internal timeout at DEFAULT_TIMEOUT_MS when omitted", async () => {
			const spy = vi.spyOn(globalThis, "setTimeout");
			globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
			await fetchx("https://api.example.com");
			expect(
				spy.mock.calls.some((args) => args[1] === DEFAULT_TIMEOUT_MS),
			).toBe(true);
			spy.mockRestore();
		});

		it("nowMs path: resolves when global performance is undefined", async () => {
			vi.stubGlobal("performance", undefined as unknown as Performance);
			try {
				globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
				await expect(
					fetchx("https://api.example.com", {
						withDuration: true,
					}),
				).resolves.toMatchObject({
					response: { ok: true },
					durationMs: expect.any(Number),
				});
			} finally {
				vi.unstubAllGlobals();
			}
		});
	});

	describe("timeout disabling (non-positive / non-finite)", () => {
		it("timeout: 0 disables the timeout (request is not aborted)", async () => {
			const spy = vi.spyOn(globalThis, "setTimeout");
			globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });

			const res = await fetchx("https://api.example.com", { timeout: 0 });

			expect(res).toEqual({ ok: true });
			// No 0 ms abort timer was armed, and the signal is not aborted.
			expect(spy.mock.calls.some((a) => a[1] === 0)).toBe(false);
			const opts = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
				.calls[0][1] as RequestInit;
			expect(opts.signal?.aborted).toBe(false);
			spy.mockRestore();
		});

		it.each([
			0,
			-1,
			Number.POSITIVE_INFINITY,
			Number.NaN,
		])("does not arm a timer for timeout=%s", async (timeout) => {
			const spy = vi.spyOn(globalThis, "setTimeout");
			globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });

			await fetchx("https://api.example.com", { timeout });

			// The only timer fetchx arms is the timeout; disabled, it must
			// not schedule one for this delay value.
			expect(spy.mock.calls.some((a) => Object.is(a[1], timeout))).toBe(
				false,
			);
			spy.mockRestore();
		});

		it("still honors a caller signal when the timeout is disabled", async () => {
			globalThis.fetch = vi
				.fn()
				.mockImplementation((_, options: RequestInit) => {
					const signal = options?.signal as AbortSignal;
					return new Promise((_, reject) => {
						signal.addEventListener("abort", () => {
							reject(signal.reason);
						});
					});
				});

			const controller = new AbortController();
			const reason = new Error("user cancelled");
			const pending = fetchx("https://api.example.com", {
				timeout: 0,
				signal: controller.signal,
			});
			setTimeout(() => controller.abort(reason), 10);

			await expect(pending).rejects.toBe(reason);
		});
	});
});

describe("HttpError", () => {
	it("is an Error and carries status, statusText, response, body", () => {
		const response = new Response("nope", {
			status: 418,
			statusText: "I'm a teapot",
		});
		const err = new HttpError(response, { reason: "no coffee" });

		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("HttpError");
		expect(err.status).toBe(418);
		expect(err.statusText).toBe("I'm a teapot");
		expect(err.message).toBe("HTTP 418 I'm a teapot");
		expect(err.response).toBe(response);
		expect(err.body).toEqual({ reason: "no coffee" });
	});

	it("formats message without trailing space when statusText is empty", () => {
		const response = new Response("", { status: 500, statusText: "" });
		const err = new HttpError(response, undefined);
		expect(err.message).toBe("HTTP 500");
	});
});

describe("fetchx.json", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("parses and returns JSON on 2xx", async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(jsonResponse({ id: 1, name: "ada" }));

		const out = await fetchx.json<{ id: number; name: string }>(
			"https://api.example.com/users/1",
		);

		expect(out).toEqual({ id: 1, name: "ada" });
	});

	it("returns undefined for 204 No Content", async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 204 }));

		const out = await fetchx.json("https://api.example.com/x");
		expect(out).toBeUndefined();
	});

	it("returns undefined for empty body with 200", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response("", {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		const out = await fetchx.json("https://api.example.com/x");
		expect(out).toBeUndefined();
	});

	it("returns raw text when content-type is not JSON", async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(textResponse("hello there"));

		const out = await fetchx.json<string>("https://api.example.com/greet");
		expect(out).toBe("hello there");
	});

	it("returns raw text when the response has no content-type header", async () => {
		// Covers the null content-type branch (headers.get returns null).
		const fake = {
			ok: true,
			status: 200,
			headers: new Headers(),
			text: () => Promise.resolve("plain body"),
		} as unknown as Response;
		globalThis.fetch = vi.fn().mockResolvedValue(fake);

		const out = await fetchx.json<string>("https://api.example.com");
		expect(out).toBe("plain body");
	});

	it("sets Accept: application/json by default", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({}));

		await fetchx.json("https://api.example.com");

		const opts = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
			.calls[0][1] as RequestInit;
		const headers = new Headers(opts.headers);
		expect(headers.get("accept")).toBe("application/json");
	});

	it("preserves caller-provided Accept header", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({}));

		await fetchx.json("https://api.example.com", {
			headers: { accept: "application/vnd.api+json" },
		});

		const opts = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
			.calls[0][1] as RequestInit;
		const headers = new Headers(opts.headers);
		expect(headers.get("accept")).toBe("application/vnd.api+json");
	});

	it("serializes `json` option and sets Content-Type", async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(jsonResponse({ ok: true }));

		await fetchx.json("https://api.example.com", {
			method: "POST",
			json: { name: "ada", age: 36 },
		});

		const opts = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
			.calls[0][1] as RequestInit;
		expect(opts.body).toBe(JSON.stringify({ name: "ada", age: 36 }));
		const headers = new Headers(opts.headers);
		expect(headers.get("content-type")).toBe("application/json");
	});

	it("preserves caller-provided Content-Type when using `json`", async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(jsonResponse({ ok: true }));

		await fetchx.json("https://api.example.com", {
			method: "POST",
			json: { x: 1 },
			headers: { "content-type": "application/vnd.api+json" },
		});

		const opts = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
			.calls[0][1] as RequestInit;
		const headers = new Headers(opts.headers);
		expect(headers.get("content-type")).toBe("application/vnd.api+json");
	});

	it("throws HttpError on non-2xx with parsed JSON body", async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(
				jsonResponse(
					{ message: "not found" },
					{ status: 404, statusText: "Not Found" },
				),
			);

		try {
			await fetchx.json("https://api.example.com/missing");
			expect.fail("expected to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(HttpError);
			const httpErr = err as HttpError;
			expect(httpErr.status).toBe(404);
			expect(httpErr.statusText).toBe("Not Found");
			expect(httpErr.body).toEqual({ message: "not found" });
		}
	});

	it("throws HttpError on non-2xx with text body when not JSON", async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(
				textResponse("server boom", { status: 500, statusText: "ISE" }),
			);

		try {
			await fetchx.json("https://api.example.com/oops");
			expect.fail("expected to throw");
		} catch (err) {
			const httpErr = err as HttpError;
			expect(httpErr.status).toBe(500);
			expect(httpErr.body).toBe("server boom");
		}
	});

	it("HttpError body is undefined when error body fails to parse", async () => {
		// Malformed JSON with content-type: application/json
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response("{not json", {
				status: 400,
				headers: { "content-type": "application/json" },
			}),
		);

		try {
			await fetchx.json("https://api.example.com/bad");
			expect.fail("expected to throw");
		} catch (err) {
			const httpErr = err as HttpError;
			expect(httpErr.status).toBe(400);
			expect(httpErr.body).toBeUndefined();
		}
	});

	it("propagates timeout from underlying request", async () => {
		globalThis.fetch = vi
			.fn()
			.mockImplementation((_, options: RequestInit) => {
				const signal = options?.signal as AbortSignal;
				return new Promise((_, reject) => {
					signal.addEventListener("abort", () => {
						reject(signal.reason);
					});
				});
			});

		await expect(
			fetchx.json("https://api.example.com", { timeout: 20 }),
		).rejects.toMatchObject({ name: "TimeoutError" });
	});

	it("parses JSON when content-type has parameters (charset)", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json; charset=utf-8" },
			}),
		);

		const out = await fetchx.json("https://api.example.com");
		expect(out).toEqual({ ok: true });
	});

	it("parses structured +json subtypes (application/ld+json)", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ "@id": 1 }), {
				status: 200,
				headers: { "content-type": "application/ld+json" },
			}),
		);

		const out = await fetchx.json("https://api.example.com");
		expect(out).toEqual({ "@id": 1 });
	});

	it("does not JSON-parse when 'json' only appears in a content-type parameter", async () => {
		// Regression: /\bjson\b/ used to match this and throw a SyntaxError on 2xx.
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response("<html>not json</html>", {
				status: 200,
				headers: { "content-type": 'text/html; profile="urn:json"' },
			}),
		);

		const out = await fetchx.json<string>("https://api.example.com");
		expect(out).toBe("<html>not json</html>");
	});

	it("does not JSON-parse application/jsonl (not a single JSON document)", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response('{"a":1}\n{"a":2}', {
				status: 200,
				headers: { "content-type": "application/jsonl" },
			}),
		);

		const out = await fetchx.json<string>("https://api.example.com");
		expect(out).toBe('{"a":1}\n{"a":2}');
	});

	it("keeps HttpError.response body re-readable (reads error body from a clone)", async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(
				jsonResponse(
					{ message: "bad" },
					{ status: 400, statusText: "Bad Request" },
				),
			);

		try {
			await fetchx.json("https://api.example.com/x");
			expect.fail("expected to throw");
		} catch (err) {
			const httpErr = err as HttpError;
			expect(httpErr.body).toEqual({ message: "bad" });
			// The stored response was cloned before parsing, so its body survives.
			await expect(httpErr.response.text()).resolves.toContain("bad");
		}
	});

	it("throws TypeError when both `json` and `body` are provided", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({}));

		await expect(
			fetchx.json("https://api.example.com", {
				method: "POST",
				json: { a: 1 },
				body: "raw",
			}),
		).rejects.toBeInstanceOf(TypeError);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("does not swallow a body-read (non-parse) failure on the error path", async () => {
		const readErr = new Error("stream aborted");
		const badResponse = {
			ok: false,
			status: 500,
			statusText: "ISE",
			headers: new Headers({ "content-type": "application/json" }),
			clone() {
				return this;
			},
			text: () => Promise.reject(readErr),
		} as unknown as Response;
		globalThis.fetch = vi.fn().mockResolvedValue(badResponse);

		await expect(fetchx.json("https://api.example.com/x")).rejects.toBe(
			readErr,
		);
	});

	it("maxBytes: resolves when the body is within the cap (streams)", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		const out = await fetchx.json("https://api.example.com", {
			maxBytes: 1000,
		});
		expect(out).toEqual({ ok: true });
	});

	it("maxBytes: rejects early on content-length without reading the body", async () => {
		// The body getter throws if touched, so only the content-length
		// short-circuit can produce the rejection — proving it happens before
		// any stream read (this would fail if that check were removed).
		const fake = {
			ok: true,
			status: 200,
			headers: new Headers({
				"content-type": "application/json",
				"content-length": "5000",
			}),
			get body(): ReadableStream | null {
				throw new Error(
					"body must not be read when content-length exceeds cap",
				);
			},
			text: () => Promise.reject(new Error("text must not be called")),
		} as unknown as Response;
		globalThis.fetch = vi.fn().mockResolvedValue(fake);

		await expect(
			fetchx.json("https://api.example.com", { maxBytes: 100 }),
		).rejects.toBeInstanceOf(MaxBytesError);
	});

	it("maxBytes: rejects while streaming when the body exceeds the cap", async () => {
		// Stream body carries no content-length, so the cap is enforced mid-stream.
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("x".repeat(200)));
				controller.close();
			},
		});
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(stream, {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		await expect(
			fetchx.json("https://api.example.com", { maxBytes: 100 }),
		).rejects.toThrow(/exceeds maxBytes/);
	});

	it("maxBytes: a failing stream cancel is swallowed on overflow", async () => {
		// cancel() is best-effort; if it rejects, the MaxBytesError still surfaces.
		const reader = {
			read: vi
				.fn()
				.mockResolvedValueOnce({
					done: false,
					value: new Uint8Array(200),
				})
				.mockResolvedValue({ done: true }),
			cancel: vi.fn().mockRejectedValue(new Error("cancel failed")),
		};
		const fake = {
			ok: true,
			status: 200,
			headers: new Headers({ "content-type": "application/json" }),
			body: { getReader: () => reader },
			text: () => Promise.resolve(""),
		} as unknown as Response;
		globalThis.fetch = vi.fn().mockResolvedValue(fake);

		await expect(
			fetchx.json("https://api.example.com", { maxBytes: 10 }),
		).rejects.toBeInstanceOf(MaxBytesError);
		expect(reader.cancel).toHaveBeenCalled();
	});

	it("maxBytes: falls back to text() when no stream is exposed", async () => {
		const fake = {
			ok: true,
			status: 200,
			headers: new Headers({ "content-type": "application/json" }),
			body: null,
			text: () => Promise.resolve(JSON.stringify({ ok: true })),
		} as unknown as Response;
		globalThis.fetch = vi.fn().mockResolvedValue(fake);

		const out = await fetchx.json("https://api.example.com", {
			maxBytes: 1000,
		});
		expect(out).toEqual({ ok: true });
	});

	it("maxBytes: an empty streamed body resolves to undefined", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.close();
			},
		});
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(stream, {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		const out = await fetchx.json("https://api.example.com", {
			maxBytes: 100,
		});
		expect(out).toBeUndefined();
	});

	it("maxBytes: an over-cap 2xx body rejects with MaxBytesError", async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(jsonResponse({ big: "x".repeat(200) }));

		await expect(
			fetchx.json("https://api.example.com", { maxBytes: 10 }),
		).rejects.toBeInstanceOf(MaxBytesError);
	});

	it("maxBytes: an over-cap error body still throws HttpError (status preserved)", async () => {
		// Regression: an over-maxBytes error body must not mask the HttpError —
		// the caller still needs the status; the body is best-effort (undefined).
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(
				jsonResponse(
					{ message: "x".repeat(200) },
					{ status: 500, statusText: "ISE" },
				),
			);

		try {
			await fetchx.json("https://api.example.com", { maxBytes: 10 });
			expect.fail("expected to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(HttpError);
			expect((err as HttpError).status).toBe(500);
			expect((err as HttpError).body).toBeUndefined();
		}
	});
});

describe("createClient", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("prepends baseUrl for relative paths", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({}));
		const api = createClient({ baseUrl: "https://api.example.com/v1/" });

		await api.get("/users");

		const calledUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
			.calls[0][0] as string;
		expect(calledUrl).toBe("https://api.example.com/users");
	});

	it("respects baseUrl trailing slash for relative path resolution", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({}));
		const api = createClient({ baseUrl: "https://api.example.com/v1/" });

		await api.get("users");

		const calledUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
			.calls[0][0] as string;
		expect(calledUrl).toBe("https://api.example.com/v1/users");
	});

	it("passes URL instances through unchanged", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({}));
		const api = createClient({ baseUrl: "https://api.example.com" });
		const url = new URL("https://other.example.com/abs");

		await api.get(url);

		const calledUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
			.calls[0][0];
		expect(calledUrl).toBe(url);
	});

	it("works without baseUrl (passes absolute URLs through)", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({}));
		const api = createClient();

		await api.get("https://api.example.com/x");

		const calledUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
			.calls[0][0];
		expect(calledUrl).toBe("https://api.example.com/x");
	});

	it("merges default headers with per-request headers (per-request wins)", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({}));
		const api = createClient({
			baseUrl: "https://api.example.com",
			headers: {
				authorization: "Bearer default",
				"x-app": "myapp",
			},
		});

		await api.get("/x", {
			headers: { authorization: "Bearer override" },
		});

		const opts = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
			.calls[0][1] as RequestInit;
		const headers = new Headers(opts.headers);
		expect(headers.get("authorization")).toBe("Bearer override");
		expect(headers.get("x-app")).toBe("myapp");
	});

	it("uses default timeout, overridable per-request", async () => {
		const spy = vi.spyOn(globalThis, "setTimeout");
		globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({}));
		const api = createClient({
			baseUrl: "https://api.example.com",
			timeout: 1234,
		});

		await api.get("/a");
		await api.get("/b", { timeout: 5678 });

		const scheduledTimeouts = spy.mock.calls.map((args) => args[1]);
		expect(scheduledTimeouts).toContain(1234);
		expect(scheduledTimeouts).toContain(5678);
		spy.mockRestore();
	});

	it("uses default fetchImpl, overridable per-request", async () => {
		const defaultFetch = vi.fn().mockResolvedValue(jsonResponse({}));
		const overrideFetch = vi.fn().mockResolvedValue(jsonResponse({}));
		globalThis.fetch = vi.fn();
		const api = createClient({
			baseUrl: "https://api.example.com",
			fetchImpl: defaultFetch,
		});

		await api.get("/a");
		await api.get("/b", { fetchImpl: overrideFetch });

		expect(defaultFetch).toHaveBeenCalledTimes(1);
		expect(overrideFetch).toHaveBeenCalledTimes(1);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("sets HTTP method for each verb", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({}));
		const api = createClient({ baseUrl: "https://api.example.com" });

		await api.get("/a");
		await api.post("/a", "body");
		await api.put("/a", "body");
		await api.patch("/a", "body");
		await api.delete("/a");

		const methods = (
			globalThis.fetch as ReturnType<typeof vi.fn>
		).mock.calls.map((call) => (call[1] as RequestInit).method);
		expect(methods).toEqual(["GET", "POST", "PUT", "PATCH", "DELETE"]);
	});

	it("passes body verbatim for post/put/patch", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({}));
		const api = createClient({ baseUrl: "https://api.example.com" });

		await api.post("/x", "raw-body");

		const opts = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
			.calls[0][1] as RequestInit;
		expect(opts.body).toBe("raw-body");
	});

	it("json client returns parsed JSON typed as T", async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(jsonResponse({ id: 7, name: "grace" }));
		const api = createClient({ baseUrl: "https://api.example.com" });

		const user = await api.json.get<{ id: number; name: string }>("/me");
		expect(user).toEqual({ id: 7, name: "grace" });
	});

	it("json.post serializes body and sets Content-Type", async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(jsonResponse({ ok: true }));
		const api = createClient({ baseUrl: "https://api.example.com" });

		await api.json.post("/orders", { sku: "abc", qty: 1 });

		const opts = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
			.calls[0][1] as RequestInit;
		expect(opts.method).toBe("POST");
		expect(opts.body).toBe(JSON.stringify({ sku: "abc", qty: 1 }));
		const headers = new Headers(opts.headers);
		expect(headers.get("content-type")).toBe("application/json");
	});

	it("json.delete sends DELETE and parses any response body", async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 204 }));
		const api = createClient({ baseUrl: "https://api.example.com" });

		const out = await api.json.delete("/items/1");

		const opts = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
			.calls[0][1] as RequestInit;
		expect(opts.method).toBe("DELETE");
		expect(out).toBeUndefined();
	});

	it("json client throws HttpError on non-2xx", async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(
				jsonResponse(
					{ message: "forbidden" },
					{ status: 403, statusText: "Forbidden" },
				),
			);
		const api = createClient({ baseUrl: "https://api.example.com" });

		await expect(api.json.get("/admin")).rejects.toBeInstanceOf(HttpError);
	});

	it("json.put and json.patch send their verb and serialize the body", async () => {
		// Fresh response per call: the JSON helper reads the body, so a single
		// shared Response would be "already read" on the second request.
		globalThis.fetch = vi
			.fn()
			.mockImplementation(() => jsonResponse({ ok: true }));
		const api = createClient({ baseUrl: "https://api.example.com" });

		await api.json.put("/items/1", { a: 1 });
		await api.json.patch("/items/1", { b: 2 });

		const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
		expect((calls[0][1] as RequestInit).method).toBe("PUT");
		expect((calls[0][1] as RequestInit).body).toBe(
			JSON.stringify({ a: 1 }),
		);
		expect((calls[1][1] as RequestInit).method).toBe("PATCH");
		expect((calls[1][1] as RequestInit).body).toBe(
			JSON.stringify({ b: 2 }),
		);
	});

	describe("restrictToBaseOrigin", () => {
		it("allows same-origin relative paths", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({}));
			const api = createClient({
				baseUrl: "https://api.example.com/v1/",
				restrictToBaseOrigin: true,
			});

			await api.get("/users");

			expect(
				(globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0],
			).toBe("https://api.example.com/users");
		});

		it("throws when an absolute path escapes the base origin", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({}));
			const api = createClient({
				baseUrl: "https://api.example.com",
				restrictToBaseOrigin: true,
			});

			await expect(
				api.get("https://evil.example.com/steal"),
			).rejects.toThrow(/escapes baseUrl origin/);
			expect(globalThis.fetch).not.toHaveBeenCalled();
		});

		it("throws when a protocol-relative path escapes the base origin", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({}));
			const api = createClient({
				baseUrl: "https://api.example.com",
				restrictToBaseOrigin: true,
			});

			await expect(api.get("//evil.example.com/x")).rejects.toThrow(
				/escapes baseUrl origin/,
			);
			expect(globalThis.fetch).not.toHaveBeenCalled();
		});

		it("throws when a URL instance escapes the base origin", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({}));
			const api = createClient({
				baseUrl: "https://api.example.com",
				restrictToBaseOrigin: true,
			});

			await expect(
				api.json.get(new URL("https://evil.example.com/x")),
			).rejects.toThrow(/escapes baseUrl origin/);
			expect(globalThis.fetch).not.toHaveBeenCalled();
		});

		it("allows a same-origin URL instance through unchanged", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({}));
			const api = createClient({
				baseUrl: "https://api.example.com",
				restrictToBaseOrigin: true,
			});
			const url = new URL("https://api.example.com/ok");

			await api.get(url);

			expect(
				(globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0],
			).toBe(url);
		});

		it("does not restrict when the option is off (default)", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({}));
			const api = createClient({ baseUrl: "https://api.example.com" });

			await api.get("https://other.example.com/x");

			expect(
				(globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0],
			).toBe("https://other.example.com/x");
		});

		it("fails closed: throws at construction without a baseUrl", async () => {
			// The guard must not silently no-op when baseUrl is omitted or empty.
			expect(() => createClient({ restrictToBaseOrigin: true })).toThrow(
				/requires `baseUrl`/,
			);
			expect(() =>
				createClient({ baseUrl: "", restrictToBaseOrigin: true }),
			).toThrow(/requires `baseUrl`/);
		});
	});
});

describe("tryAsync", () => {
	it("wraps a fulfilled promise into { ok: true, data }", async () => {
		const res = await tryAsync(Promise.resolve(42));
		expect(res).toEqual({ ok: true, data: 42 });
		if (res.ok) {
			// Type narrowing: data must be accessible, error must not.
			expect(res.data).toBe(42);
		}
	});

	it("wraps a rejected promise (with Error) into { ok: false, error }", async () => {
		const boom = new Error("boom");
		const res = await tryAsync(Promise.reject(boom));
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.error).toBe(boom);
		}
	});

	it("coerces non-Error rejections to Error", async () => {
		const res = await tryAsync(Promise.reject("plain string"));
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.error).toBeInstanceOf(Error);
			expect(res.error.message).toBe("plain string");
		}
	});

	it("coerces undefined rejection to Error", async () => {
		const res = await tryAsync(Promise.reject(undefined));
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.error).toBeInstanceOf(Error);
		}
	});
});

describe("fetchx.try", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns { ok: true, data: Response } on success", async () => {
		const mockResponse = { ok: true } as Response;
		globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

		const res = await fetchx.try("https://api.example.com");

		expect(res.ok).toBe(true);
		if (res.ok) expect(res.data).toBe(mockResponse);
	});

	it("returns { ok: false, error } on network error", async () => {
		const boom = new Error("network down");
		globalThis.fetch = vi.fn().mockRejectedValue(boom);

		const res = await fetchx.try("https://api.example.com");

		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toBe(boom);
	});

	it("returns { ok: false, error: TimeoutError } on timeout", async () => {
		globalThis.fetch = vi
			.fn()
			.mockImplementation((_, options: RequestInit) => {
				const signal = options?.signal as AbortSignal;
				return new Promise((_, reject) => {
					signal.addEventListener("abort", () => {
						reject(signal.reason);
					});
				});
			});

		const res = await fetchx.try("https://api.example.com", {
			timeout: 20,
		});

		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.error).toBeInstanceOf(Error);
			expect(res.error.name).toBe("TimeoutError");
		}
	});

	it("returns { ok: true, data: { response, durationMs } } when withDuration is true", async () => {
		const mockResponse = { ok: true } as Response;
		globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

		const res = await fetchx.try("https://api.example.com", {
			withDuration: true,
		});

		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.data.response).toBe(mockResponse);
			expect(typeof res.data.durationMs).toBe("number");
		}
	});

	it("respects caller signal abort and surfaces as error", async () => {
		globalThis.fetch = vi
			.fn()
			.mockImplementation((_, options: RequestInit) => {
				const signal = options?.signal as AbortSignal;
				return new Promise((_, reject) => {
					signal.addEventListener("abort", () => {
						reject(signal.reason);
					});
				});
			});

		const controller = new AbortController();
		const reason = new Error("user cancelled");
		const pending = fetchx.try("https://api.example.com", {
			signal: controller.signal,
			timeout: 5000,
		});
		setTimeout(() => controller.abort(reason), 10);

		const res = await pending;
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toBe(reason);
	});
});

describe("fetchx.json.try", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns { ok: true, data } with parsed JSON on success", async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(jsonResponse({ id: 1, name: "ada" }));

		const res = await fetchx.json.try<{ id: number; name: string }>(
			"https://api.example.com/users/1",
		);

		expect(res.ok).toBe(true);
		if (res.ok) expect(res.data).toEqual({ id: 1, name: "ada" });
	});

	it("returns { ok: false, error: HttpError } on non-2xx", async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(
				jsonResponse(
					{ message: "not found" },
					{ status: 404, statusText: "Not Found" },
				),
			);

		const res = await fetchx.json.try("https://api.example.com/missing");

		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.error).toBeInstanceOf(HttpError);
			expect((res.error as HttpError).status).toBe(404);
			expect((res.error as HttpError).body).toEqual({
				message: "not found",
			});
		}
	});

	it("returns { ok: false, error } on network error", async () => {
		const boom = new Error("offline");
		globalThis.fetch = vi.fn().mockRejectedValue(boom);

		const res = await fetchx.json.try("https://api.example.com");

		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toBe(boom);
	});

	it("returns { ok: true, data: undefined } for 204", async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 204 }));

		const res = await fetchx.json.try("https://api.example.com/ping");

		expect(res.ok).toBe(true);
		if (res.ok) expect(res.data).toBeUndefined();
	});

	it("composes with createClient via tryAsync (no client-level .try needed)", async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(jsonResponse({ ok: true }));
		const api = createClient({ baseUrl: "https://api.example.com" });

		const res = await tryAsync(api.json.get<{ ok: boolean }>("/health"));

		expect(res.ok).toBe(true);
		if (res.ok) expect(res.data).toEqual({ ok: true });
	});
});
