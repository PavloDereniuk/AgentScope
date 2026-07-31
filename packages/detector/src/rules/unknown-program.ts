/**
 * Unknown program interaction rule (A.9).
 *
 * Fires the first time an agent signs a transaction touching a program that is
 * both (a) absent from the parser's curated known-program whitelist and (b)
 * absent from the agent's own history for the lookback window (default 30d).
 * Severity escalates from warning to critical when SOL or SPL tokens leave the
 * wallet in that same transaction — the fingerprint of a wallet drain.
 *
 * Every other rule in the detector answers "did something break?". This one
 * answers "is something new touching the money?", which is how agent wallets
 * actually die: one approval or transfer to a program the owner never wired up.
 *
 * Three deliberate design choices:
 *
 *  1. **All instructions, not just the primary one.** `pickPrimaryInstruction`
 *     (ingestion) prefers *decoded* instructions, so a drainer CPI'd next to a
 *     real Jupiter swap would never become the tx's `programId`. The rule reads
 *     the compact `_all` outline (E.5) from `parsedArgs` and falls back to the
 *     snapshot's `programId` when the outline is missing.
 *  2. **Cold-start abstain.** An agent with no history inside the window has no
 *     baseline — every program it touches would look like first contact, so the
 *     rule stays silent rather than greeting new users with a wall of alerts.
 *     Same abstain-without-baseline stance as `priority_fee_spike`.
 *  3. **Dedupe keyed on program AND severity.** Keying on the program alone
 *     would let a harmless first contact permanently swallow the critical alert
 *     for the later transaction that actually moves funds.
 */

import { agentTransactions } from '@agentscope/db';
import { isKnownProgram } from '@agentscope/parser/known-programs';
import { and, eq, gte, inArray, ne } from 'drizzle-orm';
import { lamportsToSol, solStringToLamports } from '../lamports';
import type { RuleResult, TxRuleContext, TxRuleDef } from '../types';

const MS_PER_DAY = 86_400_000;

/**
 * Program ids touched by this transaction, most interesting first.
 *
 * Reads the `_all` instruction outline when present (defensively — `parsedArgs`
 * is untyped jsonb that may predate E.5 or be hand-written by a test), and
 * always includes the snapshot's primary `programId`.
 */
function collectProgramIds(transaction: TxRuleContext['transaction']): string[] {
  const ids: string[] = [];
  const outline = transaction.parsedArgs?._all;
  if (Array.isArray(outline)) {
    for (const entry of outline) {
      if (typeof entry !== 'object' || entry === null) continue;
      const programId = (entry as { programId?: unknown }).programId;
      if (typeof programId === 'string' && programId.length > 0) ids.push(programId);
    }
  }
  if (transaction.programId) ids.push(transaction.programId);
  return [...new Set(ids)];
}

export const unknownProgramRule: TxRuleDef = {
  name: 'unknown_program_interaction',

  async evaluate(ctx): Promise<RuleResult | null> {
    const { transaction, agent, defaults, db, now } = ctx;

    const lookbackDays =
      agent.alertRules.unknownProgramLookbackDaysThreshold ?? defaults.unknownProgramLookbackDays;
    if (lookbackDays <= 0) return null;

    const candidates = collectProgramIds(transaction).filter((id) => !isKnownProgram(id));
    if (candidates.length === 0) return null;

    const since = new Date(now.getTime() - lookbackDays * MS_PER_DAY).toISOString();
    // The current tx is already persisted when tx rules run (persist.ts inserts
    // first, then calls the detector) — excluding its signature is what keeps
    // the rule from treating every program as already familiar.
    const notThisTx = ne(agentTransactions.signature, transaction.signature);

    const seenRows = await db
      .selectDistinct({ programId: agentTransactions.programId })
      .from(agentTransactions)
      .where(
        and(
          eq(agentTransactions.agentId, agent.id),
          inArray(agentTransactions.programId, candidates),
          gte(agentTransactions.blockTime, since),
          notThisTx,
        ),
      );

    const seen = new Set(seenRows.map((row) => row.programId));
    const newProgramIds = candidates.filter((id) => !seen.has(id));
    if (newProgramIds.length === 0) return null;

    // Cold start: no baseline inside the window means "new to AgentScope", not
    // "new program". Checked only once we have something to report, so the
    // common all-familiar case costs a single query.
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
    if (!anyHistory) return null;

    // Funds-out detection. SOL: anything beyond the fee the wallet paid to
    // send the tx. Tokens: any negative net delta. A failed tx moves nothing
    // but the fee, so it lands on `warning` without a special case.
    const netLamports = solStringToLamports(transaction.solDelta) + BigInt(transaction.feeLamports);
    const solOutflowLamports = netLamports < 0n ? -netLamports : 0n;
    const solOutflow = lamportsToSol(solOutflowLamports);
    const tokenOutflowCount = transaction.tokenDeltas.filter((d) => d.delta.startsWith('-')).length;
    const fundsMoved = solOutflowLamports > 0n || tokenOutflowCount > 0;
    const severity = fundsMoved ? 'critical' : 'warning';

    const programId = newProgramIds[0] as string;

    return {
      ruleName: 'unknown_program_interaction',
      severity,
      payload: {
        programId,
        newProgramIds,
        instructionName: transaction.instructionName,
        lookbackDays,
        solOutflow,
        tokenOutflowCount,
        fundsMoved,
        signature: transaction.signature,
      },
      dedupeKey: `unknown_program:${programId}:${severity}`,
    };
  },
};
