import { describe, expect, it, vi } from 'vitest';
import { drainBody } from '../src/drain-body';

describe('drainBody', () => {
  it('consumes an unread body so undici can release it', async () => {
    const res = new Response(JSON.stringify({ ok: true }), { status: 200 });
    expect(res.bodyUsed).toBe(false);

    await drainBody(res);

    expect(res.bodyUsed).toBe(true);
  });

  it('is a no-op when the body was already read', async () => {
    const res = new Response('already read', { status: 200 });
    await res.text();

    const spy = vi.spyOn(res, 'arrayBuffer');
    await drainBody(res);

    // Calling arrayBuffer() on a used body throws — the guard must skip it
    // rather than rely on the catch, so a second drain stays free.
    expect(spy).not.toHaveBeenCalled();
  });

  it('tolerates a test double that does not model a stream', async () => {
    await expect(drainBody({ ok: true, status: 200 } as never)).resolves.toBeUndefined();
  });

  it('swallows a throwing arrayBuffer instead of failing the caller', async () => {
    const res = {
      bodyUsed: false,
      arrayBuffer: () => Promise.reject(new Error('socket reset')),
    };

    await expect(drainBody(res)).resolves.toBeUndefined();
  });

  it('does not reject when the body stream errors mid-read', async () => {
    const res = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('upstream died'));
        },
      }),
      { status: 200 },
    );

    await expect(drainBody(res)).resolves.toBeUndefined();
  });
});
