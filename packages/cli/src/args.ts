/**
 * Minimal argv parser for the `agentscope` CLI.
 *
 * Supports a single subcommand-style invocation:
 *
 *   agentscope watch <agent-id> [--api <url>] [--token <token>] [--no-color]
 *
 * Defaults pull from environment variables so devs only need to type the
 * agent id once they've exported the same pair their SDK already uses:
 *   - AGENTSCOPE_API_URL    (e.g. https://api.agentscopehq.dev)
 *   - AGENTSCOPE_AGENT_TOKEN
 *
 * No third-party arg-parser dependency on purpose: bundling commander/yargs
 * for two flags would balloon the published artifact and slow `npx
 * @agentscopehq/cli watch ...` cold starts.
 */

export interface WatchArgs {
  command: 'watch';
  agentId: string;
  apiUrl: string;
  token: string;
  color: boolean;
}

export interface HelpArgs {
  command: 'help';
  /** Optional short topic — e.g. "watch". Empty string for the top-level usage. */
  topic: string;
}

export interface VersionArgs {
  command: 'version';
}

export type ParsedArgs = WatchArgs | HelpArgs | VersionArgs;

export interface ParseEnv {
  AGENTSCOPE_API_URL?: string | undefined;
  AGENTSCOPE_AGENT_TOKEN?: string | undefined;
  NO_COLOR?: string | undefined;
}

export class ArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgError';
  }
}

/** Strip leading `--`. */
function isFlag(token: string): boolean {
  return token.startsWith('--');
}

/**
 * Parse process.argv-style array (already sliced past `[node, script]`).
 * Throws `ArgError` on anything malformed; the caller maps that to a
 * "usage:" message + nonzero exit.
 */
export function parseArgs(argv: readonly string[], env: ParseEnv): ParsedArgs {
  const head = argv[0];
  if (!head || head === '-h' || head === '--help' || head === 'help') {
    const topic = argv[1] && !isFlag(argv[1]) ? argv[1] : '';
    return { command: 'help', topic };
  }
  if (head === '-v' || head === '--version' || head === 'version') {
    return { command: 'version' };
  }
  if (head !== 'watch') {
    throw new ArgError(`unknown command: ${head}`);
  }

  // First non-flag positional after `watch` is the agent id.
  let agentId = '';
  let apiUrl = env.AGENTSCOPE_API_URL ?? '';
  let token = env.AGENTSCOPE_AGENT_TOKEN ?? '';
  // Honour the conventional NO_COLOR env (https://no-color.org) — devs
  // who set it once for their whole shell expect every CLI to obey.
  let color = !env.NO_COLOR;

  for (let i = 1; i < argv.length; i++) {
    const token_ = argv[i];
    if (token_ === undefined) continue;
    if (token_ === '--api' || token_ === '--api-url') {
      const next = argv[++i];
      if (!next) throw new ArgError(`${token_} requires a value`);
      apiUrl = next;
    } else if (token_ === '--token') {
      const next = argv[++i];
      if (!next) throw new ArgError(`${token_} requires a value`);
      token = next;
    } else if (token_ === '--no-color') {
      color = false;
    } else if (token_ === '--color') {
      color = true;
    } else if (isFlag(token_)) {
      throw new ArgError(`unknown flag: ${token_}`);
    } else if (!agentId) {
      agentId = token_;
    } else {
      throw new ArgError(`unexpected argument: ${token_}`);
    }
  }

  if (!agentId) {
    throw new ArgError('agent id is required (e.g. `agentscope watch <uuid>`)');
  }
  if (!apiUrl) {
    throw new ArgError('api url is required (set --api or AGENTSCOPE_API_URL)');
  }
  if (!token) {
    throw new ArgError('agent token is required (set --token or AGENTSCOPE_AGENT_TOKEN)');
  }

  return { command: 'watch', agentId, apiUrl, token, color };
}
