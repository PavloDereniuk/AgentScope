import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { apiClient } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Loader2 } from 'lucide-react';
import type { FormEvent } from 'react';
import { useState } from 'react';
import { toast } from 'sonner';

type PaidPlan = 'pro' | 'team';

interface UpgradeRequest {
  plan: PaidPlan;
  contact: string;
  agentCount: number;
  useCase: string;
}

interface PlanInfo {
  id: 'free' | PaidPlan;
  name: string;
  price: string;
  agents: string;
  extra: string;
}

// Planned tiers. Nothing is billed yet: paid plans collect requests (roadmap
// H.1) so pricing is settled against real demand before billing ships (H.2).
const PLANS: PlanInfo[] = [
  { id: 'free', name: 'Free', price: '$0', agents: '2 agents', extra: 'Every detector rule' },
  { id: 'pro', name: 'Pro', price: '$29/mo', agents: 'Up to 10 agents', extra: 'Longer history' },
  {
    id: 'team',
    name: 'Team',
    price: '$99/mo',
    agents: 'Up to 50 agents',
    extra: 'Longest history · priority support',
  },
];

const labelCls = 'font-mono text-[10.5px] uppercase tracking-wider text-fg-3';

/**
 * Shown on the Agents page once the user hits the free agent cap. Replaces a
 * dead-end "limit reached" line with the planned tiers and a request form.
 */
export function UpgradeCard({ maxAgents }: { maxAgents: number }) {
  const [dialogPlan, setDialogPlan] = useState<PaidPlan | null>(null);

  const { data } = useQuery({
    queryKey: ['upgrade-request'],
    queryFn: () => apiClient.get<{ request: UpgradeRequest | null }>('/api/upgrade-request'),
  });
  const existing = data?.request ?? null;

  return (
    <div className="mb-5 rounded-md border border-[color:color-mix(in_oklch,var(--accent)_30%,var(--line))] bg-[color:color-mix(in_oklch,var(--accent)_5%,var(--bg-2))] px-4 py-3.5">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-fg-2">
          Need more than {maxAgents} agents?
        </span>
        <span className="font-mono text-[10.5px] text-fg-3">
          Paid plans are coming — request early access
        </span>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        {PLANS.map((p) => {
          const paid = p.id === 'free' ? null : p.id;
          const requested = existing?.plan === p.id;
          return (
            <div
              key={p.id}
              className={cn(
                'flex flex-col gap-1 rounded-[5px] border bg-surface px-3 py-2.5',
                requested ? 'border-accent' : 'border-line',
              )}
            >
              <div className="flex items-baseline justify-between">
                <span className="text-sm font-semibold">{p.name}</span>
                <span className="font-mono text-xs text-fg-2">{p.price}</span>
              </div>
              <span className="font-mono text-[11px] text-fg-2">{p.agents}</span>
              <span className="font-mono text-[11px] text-fg-3">{p.extra}</span>
              <div className="mt-1.5">
                {paid === null ? (
                  <span className="font-mono text-[10.5px] text-fg-3">Current plan</span>
                ) : requested ? (
                  <button
                    type="button"
                    onClick={() => setDialogPlan(paid)}
                    className="inline-flex items-center gap-1 font-mono text-[10.5px] text-accent hover:underline"
                  >
                    <Check className="h-3 w-3" aria-hidden />
                    On the list · edit
                  </button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2.5 font-mono text-[11px]"
                    onClick={() => setDialogPlan(paid)}
                  >
                    Request {p.name}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {dialogPlan ? (
        <UpgradeRequestDialog
          plan={dialogPlan}
          existing={existing}
          onClose={() => setDialogPlan(null)}
        />
      ) : null}
    </div>
  );
}

function UpgradeRequestDialog({
  plan,
  existing,
  onClose,
}: {
  plan: PaidPlan;
  existing: UpgradeRequest | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (body: UpgradeRequest) =>
      apiClient.put<{ request: UpgradeRequest }>('/api/upgrade-request', body),
    onSuccess: (res) => {
      queryClient.setQueryData(['upgrade-request'], res);
      toast.success("You're on the list — we'll reach out");
      onClose();
    },
  });

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    mutation.mutate({
      plan: fd.get('plan') as PaidPlan,
      contact: (fd.get('contact') as string).trim(),
      agentCount: Number(fd.get('agentCount')),
      useCase: (fd.get('useCase') as string).trim(),
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Request early access</DialogTitle>
          <DialogDescription>
            No payment now. Tell us what you run and we'll get back to you before paid plans launch.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label htmlFor="upgrade-plan" className={labelCls}>
                Plan
              </label>
              <select
                id="upgrade-plan"
                name="plan"
                defaultValue={plan}
                className="flex h-10 w-full rounded-md border border-line bg-surface-2 px-3 py-2 font-mono text-xs"
              >
                <option value="pro">Pro — $29/mo</option>
                <option value="team">Team — $99/mo</option>
              </select>
            </div>
            <div className="space-y-2">
              <label htmlFor="upgrade-agents" className={labelCls}>
                Agents you need
              </label>
              <Input
                id="upgrade-agents"
                name="agentCount"
                type="number"
                min={1}
                max={10000}
                required
                defaultValue={existing?.agentCount ?? (plan === 'team' ? 20 : 5)}
              />
            </div>
          </div>
          <div className="space-y-2">
            <label htmlFor="upgrade-contact" className={labelCls}>
              Email or Telegram
            </label>
            <Input
              id="upgrade-contact"
              name="contact"
              placeholder="you@example.com or @handle"
              required
              minLength={3}
              maxLength={200}
              defaultValue={existing?.contact ?? ''}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="upgrade-usecase" className={labelCls}>
              What are your agents doing?
            </label>
            <textarea
              id="upgrade-usecase"
              name="useCase"
              required
              maxLength={1000}
              rows={3}
              placeholder="e.g. 12 Jupiter DCA bots for a fund, need alerts in Telegram"
              defaultValue={existing?.useCase ?? ''}
              className="flex w-full rounded-md border border-line bg-surface-2 px-3 py-2 text-sm"
            />
          </div>
          {mutation.error ? (
            <p className="font-mono text-xs text-crit">{(mutation.error as Error).message}</p>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {existing ? 'Update request' : 'Request access'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
