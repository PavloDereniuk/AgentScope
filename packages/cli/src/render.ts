/**
 * Terminal renderer for events streamed from `GET /v1/agents/:id/stream`.
 *
 * Output is single-line per event, designed to be `grep`-friendly:
 *   <iso-time> <symbol> <event-type> <key=value> …
 *
 * ANSI is opt-in (parsed from --no-color / NO_COLOR); without color the
 * output is still legible and machine-parseable.
 */

import type { AlertNewEvent, BusEvent, TxNewEvent } from './events.js';

const SIGNATURE_PREFIX_LEN = 8;
const ALERT_ID_PREFIX_LEN = 8;

interface RenderOptions {
  color: boolean;
}

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';

function paint(text: string, code: string, color: boolean): string {
  if (!color) return text;
  return `${code}${text}${RESET}`;
}

function shortSig(sig: string): string {
  if (sig.length <= SIGNATURE_PREFIX_LEN * 2 + 1) return sig;
  return `${sig.slice(0, SIGNATURE_PREFIX_LEN)}…${sig.slice(-SIGNATURE_PREFIX_LEN)}`;
}

function shortId(id: string): string {
  if (id.length <= ALERT_ID_PREFIX_LEN) return id;
  return id.slice(0, ALERT_ID_PREFIX_LEN);
}

/** Format an ISO timestamp as `HH:MM:SS` for terminal compactness. */
function clockTime(at: string): string {
  // Cheap parse — the server always emits a valid ISO-8601 string. If it
  // ever doesn't, fall back to the raw string rather than crash the tail.
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  return d.toISOString().slice(11, 19);
}

function formatTx(event: TxNewEvent, color: boolean): string {
  const time = paint(clockTime(event.at), DIM, color);
  const symbol = paint('●', GREEN, color);
  const type = paint('tx.new', CYAN, color);
  const sig = paint(shortSig(event.signature), BOLD, color);
  return `${time} ${symbol} ${type}     ${sig}`;
}

function formatAlert(event: AlertNewEvent, color: boolean): string {
  const time = paint(clockTime(event.at), DIM, color);
  const severityColor =
    event.severity === 'critical' ? RED : event.severity === 'warning' ? YELLOW : CYAN;
  const symbol = paint('▲', severityColor, color);
  const type = paint(`alert.${event.severity}`.padEnd(15), severityColor, color);
  const id = paint(shortId(event.alertId), BOLD, color);
  return `${time} ${symbol} ${type} ${id}`;
}

export function renderEvent(event: BusEvent, opts: RenderOptions): string | null {
  if (event.type === 'connected') {
    // Renderer caller (watch.ts) already prints a header — swallow the
    // handshake so the visible stream starts on real events.
    return null;
  }
  if (event.type === 'tx.new') return formatTx(event, opts.color);
  if (event.type === 'alert.new') return formatAlert(event, opts.color);
  return null;
}

/** Banner printed once on connect, before the live tail begins. */
export function renderConnectBanner(agentId: string, apiUrl: string, opts: RenderOptions): string {
  const arrow = paint('→', DIM, opts.color);
  const url = paint(apiUrl, DIM, opts.color);
  const id = paint(agentId, BOLD, opts.color);
  return [
    `${paint('agentscope watch', BOLD, opts.color)} ${id}`,
    `  ${arrow} subscribed to ${url}`,
    `  ${arrow} press Ctrl+C to exit`,
    '',
  ].join('\n');
}
