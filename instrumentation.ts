import type { Instrumentation } from "next";

export function register() {
  // Vercel Runtime Logs are always available; the durable operational-events
  // sink is initialized lazily by the reporting functions below.
}

export const onRequestError: Instrumentation.onRequestError = async (
  error,
  request,
  context,
) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    console.error(JSON.stringify({ event: "unhandled_edge_request_error", route_type: context.routeType }));
    return;
  }
  const { captureOperationalError } = await import("@/lib/observability");
  await captureOperationalError({
    event: "unhandled_server_exception",
    error,
    requestId: typeof request.headers["x-request-id"] === "string"
      ? request.headers["x-request-id"]
      : null,
    errorCategory: "unhandled_exception",
    status: "failed",
    metadata: {
      method: request.method,
      routePath: context.routePath,
      routeType: context.routeType,
      routerKind: context.routerKind,
    },
  });
};

