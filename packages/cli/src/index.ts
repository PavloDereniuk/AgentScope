#!/usr/bin/env node
/**
 * `agentscope` CLI entry point.
 *
 * Dispatches to subcommand handlers based on argv[2]. Currently the only
 * subcommand is `watch`; `help` and `version` are handled inline since
 * they don't justify their own files.
 */

import { pathToFileURL } from 'node:url';
import { ArgError, parseArgs } from './args.js';
import { runWatch } from './watch.js';

const VERSION = '0.1.0-alpha.1';

const HELP_TOP = `agentscope ${VERSION} — observability CLI for Solana AI agents

Usage:
  agentscope watch <agent-id> [--api <url>] [--token <token>] [--no-color]
  agentscope help [command]
  agentscope version

Environment:
  AGENTSCOPE_API_URL      Base URL of the AgentScope API (e.g. https://api.agentscopehq.dev)
  AGENTSCOPE_AGENT_TOKEN  Per-agent ingest token (the one your SDK exporter uses)
  NO_COLOR                Disable ANSI colors when set to any value

See https://github.com/PavloDereniuk/AgentScope for full docs.
`;

const HELP_WATCH = `agentscope watch <agent-id>

Tail an agent's transactions and alerts in real time. Subscribes to the
per-agent SSE stream on /v1/agents/<id>/stream and prints one line per
event in the form:

  <HH:MM:SS> ● tx.new       <signature-prefix>…<suffix>
  <HH:MM:SS> ▲ alert.<sev>  <alert-id>

Auth uses the same per-agent ingest token as the OTLP/HTTP exporter
(\`agent.token\` resource attribute). Set AGENTSCOPE_AGENT_TOKEN once and
the CLI picks it up automatically.

Options:
  --api, --api-url <url>    Override AGENTSCOPE_API_URL
  --token <token>           Override AGENTSCOPE_AGENT_TOKEN
  --no-color                Disable ANSI colors
  --color                   Force ANSI colors (overrides NO_COLOR)
`;

function printHelp(topic: string, write: (line: string) => void): void {
  if (topic === 'watch') {
    write(HELP_WATCH);
    return;
  }
  write(HELP_TOP);
}

async function main(argv: readonly string[]): Promise<number> {
  const stdout = (line: string) => process.stdout.write(line);
  const stderr = (line: string) => process.stderr.write(line);

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(argv, {
      AGENTSCOPE_API_URL: process.env.AGENTSCOPE_API_URL,
      AGENTSCOPE_AGENT_TOKEN: process.env.AGENTSCOPE_AGENT_TOKEN,
      NO_COLOR: process.env.NO_COLOR,
    });
  } catch (err) {
    if (err instanceof ArgError) {
      stderr(`agentscope: ${err.message}\n\n`);
      printHelp('', stderr);
      return 2;
    }
    throw err;
  }

  if (parsed.command === 'help') {
    printHelp(parsed.topic, stdout);
    return 0;
  }
  if (parsed.command === 'version') {
    stdout(`${VERSION}\n`);
    return 0;
  }
  return runWatch(parsed, { out: stdout, err: stderr });
}

// Only run when invoked as a CLI; allow the module to be imported by
// tests without auto-executing. `pathToFileURL` keeps this correct on
// both POSIX and Windows where `process.argv[1]` is a backslashed path
// rather than a `file://` URL.
const invokedAsCli =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsCli) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exit(code);
    },
    (err) => {
      process.stderr.write(`agentscope: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}

export { main };
