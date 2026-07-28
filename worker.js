export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // CORSプリフライト対応
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }
    // Groqプロキシ
    if (url.pathname === '/groq-proxy' && request.method === 'POST') {
      try {
        const body = await request.json();
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + env.GROQ_API_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });
        const data = await response.json();
        return new Response(JSON.stringify(data), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
          status: response.status,
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          headers: { 'Content-Type': 'application/json' },
          status: 500,
        });
      }
    }
    // ワールドカップ情報プロキシ（football-data.org）
    if (url.pathname === '/wc-proxy' && request.method === 'GET') {
      try {
        const path = url.searchParams.get('path');
        if (!path || !path.startsWith('/')) {
          return new Response(JSON.stringify({ error: 'invalid path' }), {
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            },
            status: 400,
          });
        }
        const response = await fetch('https://api.football-data.org/v4' + path, {
          headers: {
            'X-Auth-Token': env.FOOTBALL_DATA_API_KEY,
          },
        });
        const data = await response.text();
        return new Response(data, {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
          status: response.status,
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
          status: 500,
        });
      }
    }
    // 暗号資産プロキシ（CoinGecko）— 429/CORS対策・60秒キャッシュ
    // 例: /cg-proxy/coins/bitcoin/market_chart?vs_currency=usd&days=120
    if (url.pathname.startsWith('/cg-proxy/') && request.method === 'GET') {
      try {
        const upstream = 'https://api.coingecko.com/api/v3' + url.pathname.replace(/^\/cg-proxy/, '') + url.search;
        const cache = caches.default;
        const cacheKey = new Request(upstream, { method: 'GET' });
        const cached = await cache.match(cacheKey);
        if (cached) {
          const hit = new Response(cached.body, cached);
          hit.headers.set('Access-Control-Allow-Origin', '*');
          return hit;
        }
        const response = await fetch(upstream, {
          headers: {
            'accept': 'application/json',
            'User-Agent': 'SicoX/1.0 (+https://sicox.eekunmaras.workers.dev)',
            // Demoキーがあれば上限UP（任意）:
            // 'x-cg-demo-api-key': env.COINGECKO_DEMO_KEY,
          },
        });
        const data = await response.text();
        const res = new Response(data, {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': response.ok ? 'public, max-age=60' : 'no-store',
          },
          status: response.status,
        });
        if (response.ok) ctx.waitUntil(cache.put(cacheKey, res.clone()));
        return res;
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
          status: 500,
        });
      }
    }
    // それ以外はHTMLなどの静的ファイルを返す
    return env.ASSETS.fetch(request);
  }
}
