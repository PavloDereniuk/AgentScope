/**
 * Token approval / delegate anomaly rule (A.10).
 *
 * Fires when an agent signs an SPL Token `approve` / `approve_checked` that
 * either hands the allowance to a delegate it has not approved in the last 30
 * days, or grants an unlimited (u64::MAX) allowance to anyone at all.
 *
 * This is the one drain vector no balance-derived rule can see. An approval
 * moves nothing: `sol_delta` is zero, no token balance changes, the transaction
 * looks like housekeeping. The theft happens later, in a transaction the agent
 * never signs and AgentScope never sees, because the delegate now has standing
 * permission to move the balance. By the time `outbound_transfer_drain` (A.11)
 * or `low_balance` notices, the money is gone — the only moment worth alerting
 * on is the grant itself.
 *
 * Four design choices:
 *
 *  1. **Unlimited fires without a baseline.** Familiarity is a judgement about
 *     history, but `u64::MAX` is an intrinsic property of the grant: it is a
 *     blank cheque whether or not the delegate is a stranger. So the unlimited
 *     branch alerts even on a brand-new agent, where the unfamiliar-delegate
 *     branch abstains (same cold-start stance as A.9 / A.11 — with no history,
 *     every delegate is "new" by construction and the signal is noise).
 *  2. **Familiar = previously approved,** over the same fixed 30-day window the
 *     other two security rules use. Deliberately not a knob: the tunable an
 *     owner can reason about does not exist here (there is no threshold to
 *     move), and a second lookback setting would only generate support
 *     questions. Prior *transfers* to an address do not make it a familiar
 *     delegate — paying someone and authorising them to help themselves are
 *     different acts.
 *  3. **Reads `_approvals`, not the primary args.** `pickPrimaryInstruction`
 *     demotes `spl_token.*` so a real protocol op stays the tx's headline,
 *     which means an approval bundled behind a swap would be invisible at the
 *     top level of `parsed_args`. Persistence keeps every approval in the
 *     compact `_approvals` list precisely so this rule can see the second one.
 *  4. **Dedupe on delegate + mint + severity.** A delegate approved on two
 *     mints is two separate exposures, and keying without severity would let a
 *     tame first approval swallow the critical alert for the unlimited grant
 *     that follows (the A.9 lesson).
 */

import { agentTransactions } from '@agentscope/db';
import { type SQL, and, eq, gte, ne, or, sql } from 'drizzle-orm';
import type { RuleResult, TxRuleContext, TxRuleDef } from '../types';

const MS_PER_DAY = 86_400_000;

/** Matches `unknown_program_interaction`'s default so "familiar" means one thing. */
const APPROVAL_LOOKBACK_DAYS = 30;

/** u64::MAX — the unlimited-allowance sentinel every drainer kit uses. */
const UNLIMITED_AMOUNT = 18_446_744_073_709_551_615n;

/**
 * Cap on delegates judged per transaction. A tx approving more delegates than
 * this is already pathological; the cap keeps the history query's OR-list
 * bounded no matter what lands on chain.
 */
const MAX_CANDIDATES = 5;

/** How many historical rows the familiarity probe reads. */
const HISTORY_ROW_LIMIT = 100;

interface Approval {
  delegate: string;
  amount: bigint;
  source: string | undefined;
  owner: string | undefined;
  mint: string | undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Parse one `_approvals` entry (or a top-level primary-args object) into an
 * Approval. `parsed_args` is untyped jsonb — hand-written rows and rows written
 * before A.10 both flow through here — so anything without a delegate and a
 * plain unsigned-integer amount is dropped rather than guessed at.
 */
function toApproval(entry: unknown): Approval | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const record = entry as Record<string, unknown>;
  const delegate = optionalString(record.delegate);
  const rawAmount = record.amount;
  if (!delegate || typeof rawAmount !== 'string' || !/^\d+$/.test(rawAmount)) return null;
  return {
    delegate,
    amount: BigInt(rawAmount),
    source: optionalString(record.source),
    owner: optionalString(record.owner),
    mint: optionalString(record.mint),
  };
}

/**
 * Every approval this transaction granted. Prefers the `_approvals` list;
 * falls back to the top-level args when the tx's primary instruction is itself
 * an approval, which covers rows written before persistence learned to build
 * the list.
 */
function collectApprovals(transaction: TxRuleContext['transaction']): Approval[] {
  const list = transaction.parsedArgs?._approvals;
  if (Array.isArray(list)) {
    return list.map(toApproval).filter((a): a is Approval => a !== null);
  }
  if (transaction.instructionName?.startsWith('spl_token.approve')) {
    const single = toApproval(transaction.parsedArgs);
    return single ? [single] : [];
  }
  return [];
}

/** Delegates named in a persisted `_approvals` array. */
function delegatesIn(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const delegate = (entry as { delegate?: unknown }).delegate;
    if (typeof delegate === 'string' && delegate.length > 0) out.push(delegate);
  }
  return out;
}

/** `parsed_args -> '_approvals'` — the persisted approval list (A.10). */
const approvalsJson = sql`${agentTransactions.parsedArgs} -> '_approvals'`;

/** Containment predicate: this row's approvals include `delegate`. */
function approvedBefore(delegate: string): SQL {
  return sql`${approvalsJson} @> ${JSON.stringify([{ delegate }])}::jsonb`;
}

export const tokenApprovalRule: TxRuleDef = {
  name: 'token_approval_anomaly',

  async evaluate(ctx): Promise<RuleResult | null> {
    const { transaction, agent, db, now } = ctx;

    // A failed transaction granted nothing — the instruction never executed.
    if (!transaction.success) return null;

    const approvals = collectApprovals(transaction)
      // Amount 0 is how a wallet UI clears an allowance; it is a revoke wearing
      // an approve's discriminator, and alerting on it would punish hygiene.
      .filter((a) => a.amount > 0n)
      // Delegating to the account that signed is a no-op, not an exposure.
      .filter((a) => a.delegate !== a.owner && a.delegate !== agent.walletPubkey)
      .slice(0, MAX_CANDIDATES);
    if (approvals.length === 0) return null;

    const since = new Date(now.getTime() - APPROVAL_LOOKBACK_DAYS * MS_PER_DAY).toISOString();
    // Tx rules run after persist.ts has already inserted this row, so without
    // excluding it every delegate would look like one the agent already knew.
    const notThisTx = ne(agentTransactions.signature, transaction.signature);
    const candidates = [...new Set(approvals.map((a) => a.delegate))];

    const priorRows = await db
      .select({ approvals: sql<unknown>`${approvalsJson}` })
      .from(agentTransactions)
      .where(
        and(
          eq(agentTransactions.agentId, agent.id),
          gte(agentTransactions.blockTime, since),
          notThisTx,
          or(...candidates.map(approvedBefore)),
        ),
      )
      .limit(HISTORY_ROW_LIMIT);

    const familiar = new Set(priorRows.flatMap((row) => delegatesIn(row.approvals)));

    // Worst first: an unlimited grant to a stranger is the drainer signature,
    // an unlimited grant to a known delegate is worth one alert, and a bounded
    // grant only matters when the delegate is new.
    const scored = approvals
      .map((approval) => ({
        approval,
        unlimited: approval.amount >= UNLIMITED_AMOUNT,
        known: familiar.has(approval.delegate),
      }))
      .filter((c) => c.unlimited || !c.known)
      .sort(
        (a, b) => Number(b.unlimited) - Number(a.unlimited) || Number(a.known) - Number(b.known),
      );

    const worst = scored[0];
    if (!worst) return null;

    // Cold start: with no history in the window there is no baseline, so
    // "unfamiliar" carries no information. An unlimited allowance is judged on
    // its own terms and still fires — it needs no history to be reckless.
    const [anyHistory] = await db
      .select({ id: agentTransactions.id })
      .from(agentTransactions)
      .where(
        and(
          eq(agentTransactions.agentId, agent.id),
          gte(agentTransactions.blockTime, since),
          notThisTx,
        ),
      )
      .limit(1);
    const hasBaseline = anyHistory !== undefined;
    if (!hasBaseline && !worst.unlimited) return null;

    const { approval, unlimited, known } = worst;
    const unfamiliar = hasBaseline && !known;
    const severity = unlimited && unfamiliar ? 'critical' : 'warning';
    const mint = approval.mint;

    return {
      ruleName: 'token_approval_anomaly',
      severity,
      payload: {
        delegate: approval.delegate,
        ...(mint ? { mint } : {}),
        ...(approval.source ? { tokenAccount: approval.source } : {}),
        amount: approval.amount.toString(),
        unlimited,
        unfamiliarDelegate: unfamiliar,
        coldStart: !hasBaseline,
        lookbackDays: APPROVAL_LOOKBACK_DAYS,
        approvalCount: approvals.length,
        instructionName: transaction.instructionName,
        signature: transaction.signature,
      },
      dedupeKey: `token_approval:${approval.delegate}:${mint ?? 'unknown'}:${severity}`,
    };
  },
};
