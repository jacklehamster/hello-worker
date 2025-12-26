export default {
  async fetch(request: Request, env: any): Promise<Response> {
    return new Response("<a href='https://github.com/jacklehamster/cloudflare-worker'>Hello, World!</a>", {
      headers: { "Content-Type": "text/html" },
    });
  },
};
