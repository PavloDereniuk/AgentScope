/**
 * @agentscope/parser — Solana instruction parsers.
 *
 * Public surface:
 *   parseTransaction(input)  — dispatcher with empty registry (2.2)
 *   registerParser(parser)   — extension point for per-program parsers
 *   ParsedTx, ParsedInstruction, ParseInput, ProgramParser  — types (2.1)
 *   jupiterParser, kaminoParser  — per-program implementations (2.7, 2.10)
 */

export { parseTransaction, registerParser } from './dispatcher';
export type {
  ParseInput,
  ParsedInstruction,
  ParsedTx,
  ProgramParser,
} from './types';
