// Cloudflare Worker for Flappy Animal World Ranking
// Deploy to: https://flappy-ranking.bose-no-ikkyu.workers.dev
// Requires KV namespace binding: RANKINGS

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const MAX_RANKINGS = 50;

// Anti-cheat validation
function validateScore(score, verification) {
  if (!verification) return false;

  const { seed, duration, jumpCount, pipeCount, jumpIntervals, pipeTimes, frameSamples, hash } = verification;

  // Basic sanity checks
  if (!seed || typeof seed !== 'string') return false;
  if (typeof duration !== 'number' || duration < 1000) return false; // minimum 1 second game
  if (typeof jumpCount !== 'number' || jumpCount < 1) return false;
  if (typeof pipeCount !== 'number') return false;

  // Score should roughly match pipe count (considering multipliers up to 2x)
  if (score > pipeCount * 2.5 + 1) return false;

  // Duration check: minimum ~2 seconds per pipe passed at base speed
  const minDurationPerPipe = 800; // ms, generous minimum
  if (pipeCount > 0 && duration < pipeCount * minDurationPerPipe) return false;

  // Jump frequency check: no humanly impossible rapid jumps
  if (jumpIntervals && jumpIntervals.length > 1) {
    for (let i = 1; i < jumpIntervals.length; i++) {
      const gap = jumpIntervals[i] - jumpIntervals[i - 1];
      if (gap < 80) return false; // faster than 80ms between jumps is suspicious
    }
  }

  // Frame sample check: should have some variance (not perfectly constant)
  if (frameSamples && frameSamples.length > 5) {
    const allSame = frameSamples.every(f => f === frameSamples[0]);
    if (allSame) return false; // perfectly constant frame times are suspicious
  }

  // Verify hash matches
  const raw = seed + '|' + score + '|' + duration + '|' + jumpCount + '|' + pipeCount + '|' + (frameSamples ? frameSamples.length : 0);
  let expectedHash = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    expectedHash = ((expectedHash << 5) - expectedHash) + c;
    expectedHash |= 0;
  }
  if (Math.abs(expectedHash).toString(36) !== hash) return false;

  // Score limit sanity: no score above 200 (practically impossible)
  if (score > 200) return false;

  return true;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // GET /api/rankings - Fetch world rankings
    if (url.pathname === '/api/rankings' && request.method === 'GET') {
      try {
        const data = await env.RANKINGS.get('world_rankings', 'json');
        const rankings = (data || []).map(({ name, score, date }) => ({ name, score, date }));
        return new Response(JSON.stringify({ rankings }), {
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ rankings: [], error: 'Failed to fetch' }), {
          status: 500,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
    }

    // POST /api/scores - Submit a score
    if (url.pathname === '/api/scores' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { name, score, verification } = body;

        // Validate input
        if (!name || typeof name !== 'string' || name.length > 10) {
          return new Response(JSON.stringify({ error: 'Invalid name' }), {
            status: 400,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          });
        }
        if (typeof score !== 'number' || score < 0 || !Number.isFinite(score)) {
          return new Response(JSON.stringify({ error: 'Invalid score' }), {
            status: 400,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          });
        }

        // Anti-cheat validation
        if (!validateScore(score, verification)) {
          return new Response(JSON.stringify({ error: 'Verification failed' }), {
            status: 403,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          });
        }

        // Rate limiting by IP
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const rateLimitKey = 'ratelimit:' + ip;
        const lastSubmit = await env.RANKINGS.get(rateLimitKey);
        if (lastSubmit) {
          const elapsed = Date.now() - parseInt(lastSubmit);
          if (elapsed < 5000) { // 5 second cooldown
            return new Response(JSON.stringify({ error: 'Too fast, try again' }), {
              status: 429,
              headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
            });
          }
        }
        await env.RANKINGS.put(rateLimitKey, Date.now().toString(), { expirationTtl: 60 });

        // Save score
        const data = await env.RANKINGS.get('world_rankings', 'json');
        const rankings = data || [];
        const sanitizedName = name.replace(/[<>&"']/g, '').slice(0, 10);
        const newEntry = {
          name: sanitizedName,
          score: Math.floor(score),
          date: new Date().toISOString().split('T')[0],
          ip: ip
        };

        // Limit to top 3 scores per IP
        const sameIpScores = rankings.filter(r => r.ip === ip);
        if (sameIpScores.length >= 3) {
          // Check if new score beats the worst of this IP's top 3
          sameIpScores.sort((a, b) => b.score - a.score);
          const worst = sameIpScores[2];
          if (newEntry.score <= worst.score) {
            return new Response(JSON.stringify({ error: 'You already have 3 higher scores' }), {
              status: 200,
              headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
            });
          }
          // Remove the worst score from this IP to make room
          const worstIdx = rankings.findIndex(r => r.ip === ip && r.score === worst.score);
          if (worstIdx !== -1) rankings.splice(worstIdx, 1);
        }

        rankings.push(newEntry);
        rankings.sort((a, b) => b.score - a.score);
        const trimmed = rankings.slice(0, MAX_RANKINGS);
        await env.RANKINGS.put('world_rankings', JSON.stringify(trimmed));

        const rank = trimmed.findIndex(r => r.name === sanitizedName && r.score === Math.floor(score)) + 1;
        return new Response(JSON.stringify({ success: true, rank }), {
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: 'Server error' }), {
          status: 500,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
    }

    return new Response('Flappy Animal Ranking API', {
      status: 404,
      headers: CORS_HEADERS,
    });
  },
};
