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
    // それ以外はHTMLなどの静的ファイルを返す
    return env.ASSETS.fetch(request);
  }
}
