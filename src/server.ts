type ServerOptions = {
  port: number;
};

export function createServer(options: ServerOptions) {
  return Bun.serve({
    hostname: "0.0.0.0",
    port: options.port,
    fetch: handleRequest,
  });
}

export function handleRequest(request: Request) {
  const { pathname } = new URL(request.url);

  if (pathname === "/healthz") {
    return Response.json({ ok: true });
  }

  if (pathname === "/") {
    return Response.json({
      message: "hello from bun in a devcontainer",
    });
  }

  return new Response("Not Found", { status: 404 });
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? "3000");
  const server = createServer({ port });

  console.log(`Server listening on http://localhost:${server.port}`);
}
