// What every request must pass before the handler answers it: the host it names (its `Host`, which the request's URL
// is made from) must be this server's own address, a page of another name rebinding to it names its own; only GET and
// POST are answered; and a POST must come from this server's own pages, by its `Origin`. `/api/` is answered in JSON,
// and must be sent JSON.

/** The addresses this server answers as: its `Host` names and the origins of its own pages. */
export interface Own {
  readonly hosts: ReadonlySet<string>;
  readonly origins: ReadonlySet<string>;
}

/** A page of one heading, for a person who opened an address the handler refuses; `title` is the heading's when not given. */
export const pageOf = (
  heading: string,
  status: number,
  { title = heading, body = "" } = {},
) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title} · Cascade</title></head><body><h1>${heading}</h1>${body}</body></html>`,
    { status, headers: { "content-type": "text/html; charset=UTF-8" } },
  );

/** The refusal of `request`, or nothing when it passes. */
export function refusedBy(
  own: Own,
  request: Request,
  url: URL,
): Response | undefined {
  const api = url.pathname.startsWith("/api/");
  const refuse = (status: 403 | 405 | 415, refused: string, heading: string) =>
    api ? Response.json({ refused }, { status }) : pageOf(heading, status);
  if (!own.hosts.has(url.host))
    return refuse(
      403,
      "not this server's address",
      "Refused: not this server's address",
    );
  const post = request.method === "POST";
  if (!post && request.method !== "GET")
    return refuse(405, "not allowed", "Not allowed");
  if (post && !own.origins.has(request.headers.get("origin") ?? ""))
    return refuse(
      403,
      "a request from another site",
      "Refused: a form from another site",
    );
  if (
    api &&
    post &&
    !/^application\/json\s*(;|$)/i.test(
      request.headers.get("content-type") ?? "",
    )
  )
    return refuse(415, "send application/json", "Send JSON");
  return undefined;
}
