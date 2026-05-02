/**
 * @agentscope/parser — Solana instruction parsers.
 *
 * Public surface:
 *   parseTransaction(input)  — dispatcher with auto-registered parsers
 *   registerParser(parser)   — extension point for per-program parsers
 *   jupiterParser            — Jupiter v6 swap parser (auto-registered)
 *   ParsedTx, ParsedInstruction, ParseInput, ProgramParser  — types
 */

// Import for side-effect: parser modules call registerParser at load time
import './jupiter/parser';
import './kamino/parser';
import './system/parser';

export { parseTransaction, registerParser } from './dispatcher';
export { jupiterParser } from './jupiter/parser';
export { kaminoParser, getKaminoLoadWarnings } from './kamino/parser';
export { systemParser } from './system/parser';
export type {
  ParseInput,
  ParsedInstruction,
  ParsedTx,
  ProgramParser,
} from './types';
