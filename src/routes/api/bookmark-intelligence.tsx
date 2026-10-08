import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { z } from "zod";
import { analyzeBookmarksEffect } from "#/lib/bookmark-intelligence";
import {
	jsonResponse,
	requestJsonEffect,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";

const requestSchema = z.object({
	ids: z.array(z.string().regex(/^\d+$/)).max(50),
	account: z.string().optional(),
	query: z.string().max(500).optional(),
	cachedOnly: z.boolean().optional(),
});
export const Route = createFileRoute("/api/bookmark-intelligence")({
	server: {
		handlers: {
			POST: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;
						const body = yield* requestJsonEffect(request, {});
						const parsed = requestSchema.safeParse(body);
						if (!parsed.success)
							return jsonResponse(
								{
									message:
										"Expected up to 50 bookmark ids and a query of at most 500 characters",
								},
								{ status: 400 },
							);
						return yield* analyzeBookmarksEffect({
							...parsed.data,
							signal: request.signal,
						}).pipe(
							Effect.map(jsonResponse),
							Effect.catchAll((error) =>
								Effect.succeed(
									jsonResponse(
										{
											message:
												error instanceof Error
													? error.message
													: "Bookmark analysis failed",
										},
										{ status: 503 },
									),
								),
							),
						);
					}),
				),
		},
	},
});
