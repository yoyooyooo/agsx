import type { Target } from "../domain/model.js";

/** Human-facing URLs are presentation only. They never select an HTTP target,
 * credential, provider repository, PR coordinate or merge authority. */
export function presentUrls(value: unknown, target: Target): unknown {
  const nativeOrigins = new Set([target.context.endpoint, ...(target.context.aliases ?? [])]);
  const publicOrigins = target.context.publicUrls ?? {};
  const urlKeys = new Set([
    "url",
    "html_url",
    "clone_url",
    "external_url",
    "externalUrl",
    "display_url",
    "link",
  ]);
  const visit = (input: unknown, provider?: string): unknown => {
    if (Array.isArray(input)) return input.map((item) => visit(item, provider));
    if (input === null || typeof input !== "object") return input;
    const row = input as Record<string, unknown>;
    const selected =
      typeof row.provider === "string"
        ? row.provider
        : row.provider &&
            typeof row.provider === "object" &&
            typeof (row.provider as Record<string, unknown>).provider === "string"
          ? String((row.provider as Record<string, unknown>).provider)
          : row.provider &&
              typeof row.provider === "object" &&
              typeof (row.provider as Record<string, unknown>).kind === "string"
            ? String((row.provider as Record<string, unknown>).kind)
            : provider;
    return Object.fromEntries(
      Object.entries(row).map(([key, data]) => {
        if (urlKeys.has(key) && typeof data === "string") {
          try {
            const url = new URL(data);
            if (!["https:", "http:"].includes(url.protocol)) return [key, null];
            if (
              url.username ||
              url.password ||
              [...url.searchParams.keys()].some((k) =>
                /token|secret|password|signature|credential/i.test(k),
              )
            ) {
              return [key, null];
            }
            const origin =
              selected && publicOrigins[selected]
                ? publicOrigins[selected]
                : nativeOrigins.has(url.origin)
                  ? target.context.endpoint
                  : undefined;
            return [key, origin ? `${origin}${url.pathname}${url.search}${url.hash}` : data];
          } catch {
            return [key, null];
          }
        }
        return [key, visit(data, selected)];
      }),
    );
  };
  return visit(value);
}
