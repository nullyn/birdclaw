import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import {
	jsonResponse,
	requestJsonEffect,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import { getWebSyncJob, parseWebSyncKind, startWebSync } from "#/lib/web-sync";

function parseAccountId(value: unknown) {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export const Route = createFileRoute("/api/sync")({
	server: {
		handlers: {
			GET: ({ request }) => {
				const denied = sensitiveRequestErrorResponse(request);
				if (denied) return denied;

				const url = new URL(request.url);
				const id = url.searchParams.get("id");
				if (!id) {
					return jsonResponse(
						{ ok: false, message: "Missing sync job id" },
						{ status: 400 },
					);
				}

				const job = getWebSyncJob(id);
				if (!job) {
					return jsonResponse(
						{ ok: false, message: "Sync job not found" },
						{ status: 404 },
					);
				}

				return jsonResponse(job);
			},
			POST: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						const body = yield* requestJsonEffect<Record<string, unknown>>(
							request,
							{},
						);
						const kind = parseWebSyncKind(body.kind);
						if (!kind) {
							return jsonResponse(
								{ ok: false, message: "Unknown sync kind" },
								{ status: 400 },
							);
						}

						const job = startWebSync(kind, parseAccountId(body.accountId));
						return jsonResponse(job, { status: job.inProgress ? 202 : 200 });
					}),
				),
		},
	},
});
