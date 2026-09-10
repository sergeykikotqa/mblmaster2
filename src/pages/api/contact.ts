export const prerender = false;

function buildLeadsUrl(request: Request): string {
  const sourceUrl = new URL(request.url);
  const targetUrl = new URL('/api/leads', sourceUrl);
  targetUrl.search = sourceUrl.search;
  return targetUrl.toString();
}

export async function post({ request }: { request: Request }) {
  return new Response(null, {
    status: 307,
    headers: {
      Location: buildLeadsUrl(request),
      'Cache-Control': 'no-store',
    },
  });
}

export const POST = post;
