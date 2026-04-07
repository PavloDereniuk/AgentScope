/**
 * @agentscope/parser — Solana instruction parsers.
 *
 * Public surface:
 *   parseTransaction(input)  — single dispatcher (lands in task 2.2)
 *   ParsedTx, ParsedInstruction, ParseInput, ProgramParser  — types (2.1)
 *   jupiterParser, kaminoParser  — per-program implementations (2.7, 2.10)
 */

export type {
  ParseInput,
  ParsedInstruction,
  ParsedTx,
  ProgramParser,
} from './types';
