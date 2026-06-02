import { apiClient } from '@/lib/api-client';
import { useQuery } from '@tanstack/react-query';

/**
 * Whether the signed-in user is the platform owner (Cluster F admin panel).
 *
 * Resolves via `GET /api/me`, so the owner DID list never ships to the
 * client bundle — the server is the single source of truth. The boolean
 * gates both the `/admin` nav item and a client-side redirect guard on the
 * page itself (the API enforces the real boundary with a 403 regardless).
 *
 * Long `staleTime`: ownership doesn't change within a session, so there's no
 * reason to refetch on every mount.
 */
export function useIsOwner(): { isOwner: boolean; isLoading: boolean } {
  const query = useQuery({
    queryKey: ['me'],
    queryFn: () => apiClient.get<{ isOwner: boolean }>('/api/me'),
    staleTime: 5 * 60_000,
  });
  return { isOwner: query.data?.isOwner ?? false, isLoading: query.isLoading };
}
