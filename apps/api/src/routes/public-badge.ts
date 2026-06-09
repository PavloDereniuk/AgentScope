/**
 * Public badge endpoint — no auth required.
 *
 * GET /public/badge/:agentId
 *
 * Returns a shields.io-style flat SVG badge showing the agent's current
 * status (live / stale / failed). Intended for embedding in GitHub READMEs:
 *
 *   ![status](https://api.agentscopehq.dev/public/badge/<agentId>)
 *
 * Only exposes the agent name (badge label) and status (badge message).
 * No auth token — the agent UUID is the access key the owner chooses to share.
 * Unknown / invalid IDs return 404 with no existence oracle for other data.
 */

import type { Database } from '@agentscope/db';
import { agents } from '@agentscope/db';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

type AgentStatus = 'live' | 'stale' | 'failed';

const STATUS_COLOR: Record<AgentStatus, string> = {
  live: '#4c1',
  stale: '#9f9f9f',
  failed: '#e05d44',
};

const agentIdParamSchema = z.object({ agentId: z.string().uuid() });

function escXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Renders a shields.io-compatible flat SVG badge.
 *
 * Text widths are approximated at 7px/char (Verdana 11px average), then
 * the SVG `textLength` attribute stretches or compresses the glyphs to
 * fit exactly — so the badge is always the right size even if the
 * approximation is off by a few pixels.
 */
function badgeSvg(label: string, message: string, color: string): string {
  const PAD = 10;
  const lw = label.length * 7 + PAD * 2;
  const mw = message.length * 7 + PAD * 2;
  const tw = lw + mw;

  // Centers for text, in un-scaled coordinates
  const lCx = Math.round(lw / 2);
  const mCx = lw + Math.round(mw / 2);

  // textLength in the 10× scaled coordinate system used by scale(.1)
  const lTl = (lw - PAD * 2) * 10;
  const mTl = (mw - PAD * 2) * 10;

  const sl = escXml(label);
  const sm = escXml(message);
  const al = `${sl}: ${sm}`;

  // Single template literal — Biome lint/style/useTemplate requires this.
  // The SVG uses the scale(.1) trick: all coordinates are 10× larger than
  // the rendered px, then shrunk back. This avoids sub-pixel rounding while
  // keeping integer arithmetic throughout.
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${tw}" height="20" role="img" aria-label="${al}"><title>${al}</title><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="r"><rect width="${tw}" height="20" rx="3" fill="#fff"/></clipPath><g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${mw}" height="20" fill="${color}"/><rect width="${tw}" height="20" fill="url(#s)"/></g><g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="110"><text aria-hidden="true" x="${lCx * 10}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${lTl}" lengthAdjust="spacing">${sl}</text><text x="${lCx * 10}" y="140" transform="scale(.1)" textLength="${lTl}" lengthAdjust="spacing">${sl}</text><text aria-hidden="true" x="${mCx * 10}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${mTl}" lengthAdjust="spacing">${sm}</text><text x="${mCx * 10}" y="140" transform="scale(.1)" textLength="${mTl}" lengthAdjust="spacing">${sm}</text></g></svg>`;
}

export function createPublicBadgeRouter(db: Database) {
  const router = new Hono();

  router.get('/badge/:agentId', async (c) => {
    const parsed = agentIdParamSchema.safeParse(c.req.param());
    if (!parsed.success) {
      throw new HTTPException(404, { message: 'not found' });
    }

    const [row] = await db
      .select({ name: agents.name, status: agents.status })
      .from(agents)
      .where(eq(agents.id, parsed.data.agentId))
      .limit(1);

    if (!row) {
      throw new HTTPException(404, { message: 'not found' });
    }

    const status = row.status as AgentStatus;
    const color = STATUS_COLOR[status] ?? STATUS_COLOR.stale;
    const svg = badgeSvg(row.name, status, color);

    c.header('Content-Type', 'image/svg+xml');
    // 60s public cache — fresh enough for live status, kind to CDN edges
    c.header('Cache-Control', 'public, max-age=60, s-maxage=60');
    c.header('X-Content-Type-Options', 'nosniff');
    return c.body(svg);
  });

  return router;
}
