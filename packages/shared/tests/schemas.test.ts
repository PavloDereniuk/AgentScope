import { describe, expect, it } from 'vitest';
import {
  agentSchema,
  agentTransactionSchema,
  alertSchema,
  createAgentInputSchema,
  reasoningLogSchema,
  solanaPubkeySchema,
  solanaSignatureSchema,
  sseEventSchema,
  userSchema,
} from '../src/schemas.js';
import type {
  Agent,
  AgentTransaction,
  Alert,
  CreateAgentInput,
  ReasoningLog,
  SseEvent,
  User,
} from '../src/types.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────

const VALID_PUBKEY = '11111111111111111111111111111111';
const VALID_PUBKEY_2 = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const VALID_SIG =
  '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';
const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const VALID_TIMESTAMP = '2026-04-07T12:00:00.000Z';

function makeUser(): User {
  return userSchema.parse({
    id: VALID_UUID,
    privyDid: 'did:privy:abc123',
    email: 'test@example.com',
    createdAt: VALID_TIMESTAMP,
  });
}

function makeAgent(): Agent {
  return agentSchema.parse({
    id: VALID_UUID,
    userId: VALID_UUID,
    walletPubkey: VALID_PUBKEY,
    name: 'Test Agent',
    framework: 'elizaos',
    agentType: 'trader',
    tags: ['demo', 'devnet'],
    webhookUrl: null,
    alertRules: {},
    ingestToken: 'tok_abc123',
    status: 'live',
    createdAt: VALID_TIMESTAMP,
    lastSeenAt: null,
  });
}

// ─── Branded primitives ────────────────────────────────────────────────────

describe('solanaPubkeySchema', () => {
  it('accepts valid base58 pubkeys', () => {
    expect(solanaPubkeySchema.parse(VALID_PUBKEY)).toBe(VALID_PUBKEY);
    expect(solanaPubkeySchema.parse(VALID_PUBKEY_2)).toBe(VALID_PUBKEY_2);
  });

  it('rejects strings with invalid characters', () => {
    expect(() => solanaPubkeySchema.parse(`0OIl${'a'.repeat(28)}`)).toThrow();
  });

  it('rejects strings shorter than 32 chars', () => {
    expect(() => solanaPubkeySchema.parse('abc')).toThrow();
  });

  it('rejects strings longer than 44 chars', () => {
    expect(() => solanaPubkeySchema.parse('a'.repeat(50))).toThrow();
  });

  it('rejects non-strings', () => {
    expect(() => solanaPubkeySchema.parse(123)).toThrow();
    expect(() => solanaPubkeySchema.parse(null)).toThrow();
  });
});

describe('solanaSignatureSchema', () => {
  it('accepts valid base58 signatures', () => {
    expect(solanaSignatureSchema.parse(VALID_SIG)).toBe(VALID_SIG);
  });

  it('rejects too-short signatures', () => {
    expect(() => solanaSignatureSchema.parse('abc')).toThrow();
  });
});

// ─── User ──────────────────────────────────────────────────────────────────

describe('userSchema', () => {
  it('parses a valid user', () => {
    const user = makeUser();
    expect(user.privyDid).toBe('did:privy:abc123');
    expect(user.email).toBe('test@example.com');
  });

  it('accepts null email', () => {
    expect(() =>
      userSchema.parse({
        id: VALID_UUID,
        privyDid: 'did:privy:x',
        email: null,
        createdAt: VALID_TIMESTAMP,
      }),
    ).not.toThrow();
  });

  it('rejects invalid email format', () => {
    expect(() =>
      userSchema.parse({
        id: VALID_UUID,
        privyDid: 'did:privy:x',
        email: 'not-an-email',
        createdAt: VALID_TIMESTAMP,
      }),
    ).toThrow();
  });

  it('rejects malformed UUID', () => {
    expect(() =>
      userSchema.parse({
        id: 'not-a-uuid',
        privyDid: 'did:privy:x',
        email: null,
        createdAt: VALID_TIMESTAMP,
      }),
    ).toThrow();
  });
});

// ─── Agent ─────────────────────────────────────────────────────────────────

describe('agentSchema', () => {
  it('parses a valid agent with empty alertRules', () => {
    const agent = makeAgent();
    expect(agent.framework).toBe('elizaos');
    expect(agent.agentType).toBe('trader');
    expect(agent.tags).toEqual(['demo', 'devnet']);
  });

  it('accepts populated alertRules', () => {
    const agent = agentSchema.parse({
      id: VALID_UUID,
      userId: VALID_UUID,
      walletPubkey: VALID_PUBKEY,
      name: 'Tuned Agent',
      framework: 'agent-kit',
      agentType: 'yield',
      tags: [],
      webhookUrl: 'https://example.com/hook',
      alertRules: {
        slippagePctThreshold: 10,
        gasMultThreshold: 4,
      },
      ingestToken: 'tok_xyz',
      status: 'stale',
      createdAt: VALID_TIMESTAMP,
      lastSeenAt: VALID_TIMESTAMP,
    });
    expect(agent.alertRules.slippagePctThreshold).toBe(10);
  });

  it('rejects invalid framework', () => {
    expect(() =>
      agentSchema.parse({
        id: VALID_UUID,
        userId: VALID_UUID,
        walletPubkey: VALID_PUBKEY,
        name: 'X',
        framework: 'langchain',
        agentType: 'trader',
        tags: [],
        webhookUrl: null,
        alertRules: {},
        ingestToken: 'tok_x',
        status: 'live',
        createdAt: VALID_TIMESTAMP,
        lastSeenAt: null,
      }),
    ).toThrow();
  });

  it('rejects invalid wallet pubkey', () => {
    expect(() =>
      agentSchema.parse({
        id: VALID_UUID,
        userId: VALID_UUID,
        walletPubkey: 'too-short',
        name: 'X',
        framework: 'elizaos',
        agentType: 'trader',
        tags: [],
        webhookUrl: null,
        alertRules: {},
        ingestToken: 'tok_x',
        status: 'live',
        createdAt: VALID_TIMESTAMP,
        lastSeenAt: null,
      }),
    ).toThrow();
  });
});

describe('createAgentInputSchema', () => {
  it('parses minimal input', () => {
    const input: CreateAgentInput = createAgentInputSchema.parse({
      walletPubkey: VALID_PUBKEY,
      name: 'New Agent',
      framework: 'elizaos',
      agentType: 'trader',
    });
    expect(input.walletPubkey).toBe(VALID_PUBKEY);
  });

  it('accepts optional fields', () => {
    const input = createAgentInputSchema.parse({
      walletPubkey: VALID_PUBKEY,
      name: 'New Agent',
      framework: 'custom',
      agentType: 'other',
      tags: ['x'],
      webhookUrl: 'https://x.com',
      alertRules: { drawdownPctThreshold: 15 },
    });
    expect(input.tags).toEqual(['x']);
  });

  it('rejects empty name', () => {
    expect(() =>
      createAgentInputSchema.parse({
        walletPubkey: VALID_PUBKEY,
        name: '',
        framework: 'elizaos',
        agentType: 'trader',
      }),
    ).toThrow();
  });
});

// ─── Transaction ───────────────────────────────────────────────────────────

describe('agentTransactionSchema', () => {
  it('parses a valid swap tx', () => {
    const tx: AgentTransaction = agentTransactionSchema.parse({
      id: 1,
      agentId: VALID_UUID,
      signature: VALID_SIG,
      slot: 123456789,
      blockTime: VALID_TIMESTAMP,
      programId: VALID_PUBKEY,
      instructionName: 'jupiter.swap',
      parsedArgs: { inputMint: 'A', outputMint: 'B', inAmount: '1000' },
      solDelta: '-0.005000000',
      tokenDeltas: [{ mint: VALID_PUBKEY, decimals: 6, delta: '1000000' }],
      feeLamports: 5000,
      success: true,
      rawLogs: ['Program log: success'],
    });
    expect(tx.instructionName).toBe('jupiter.swap');
    expect(tx.tokenDeltas).toHaveLength(1);
  });

  it('accepts null instructionName and parsedArgs (raw, unparsed tx)', () => {
    expect(() =>
      agentTransactionSchema.parse({
        id: 2,
        agentId: VALID_UUID,
        signature: VALID_SIG,
        slot: 1,
        blockTime: VALID_TIMESTAMP,
        programId: VALID_PUBKEY,
        instructionName: null,
        parsedArgs: null,
        solDelta: '0',
        tokenDeltas: [],
        feeLamports: 0,
        success: false,
        rawLogs: [],
      }),
    ).not.toThrow();
  });
});

// ─── Reasoning ─────────────────────────────────────────────────────────────

describe('reasoningLogSchema', () => {
  it('parses a valid root span', () => {
    const log: ReasoningLog = reasoningLogSchema.parse({
      id: VALID_UUID,
      agentId: VALID_UUID,
      traceId: '0123456789abcdef0123456789abcdef',
      spanId: '0123456789abcdef',
      parentSpanId: null,
      spanName: 'decision',
      startTime: VALID_TIMESTAMP,
      endTime: VALID_TIMESTAMP,
      attributes: { 'reasoning.model': 'gpt-4', 'reasoning.confidence': 0.92 },
      txSignature: VALID_SIG,
    });
    expect(log.parentSpanId).toBeNull();
  });

  it('rejects malformed traceId (wrong length)', () => {
    expect(() =>
      reasoningLogSchema.parse({
        id: VALID_UUID,
        agentId: VALID_UUID,
        traceId: 'abc',
        spanId: '0123456789abcdef',
        parentSpanId: null,
        spanName: 'x',
        startTime: VALID_TIMESTAMP,
        endTime: VALID_TIMESTAMP,
        attributes: {},
        txSignature: null,
      }),
    ).toThrow();
  });
});

// ─── Alert ─────────────────────────────────────────────────────────────────

describe('alertSchema', () => {
  it('parses a valid pending alert', () => {
    const alert: Alert = alertSchema.parse({
      id: VALID_UUID,
      agentId: VALID_UUID,
      ruleName: 'slippage_spike',
      severity: 'critical',
      payload: { thresholdPct: 5, actualPct: 47.3 },
      triggeredAt: VALID_TIMESTAMP,
      deliveredAt: null,
      deliveryChannel: null,
      deliveryStatus: 'pending',
      deliveryError: null,
    });
    expect(alert.severity).toBe('critical');
  });

  it('rejects unknown ruleName', () => {
    expect(() =>
      alertSchema.parse({
        id: VALID_UUID,
        agentId: VALID_UUID,
        ruleName: 'mystery_rule',
        severity: 'info',
        payload: {},
        triggeredAt: VALID_TIMESTAMP,
        deliveredAt: null,
        deliveryChannel: null,
        deliveryStatus: 'pending',
        deliveryError: null,
      }),
    ).toThrow();
  });
});

// ─── SSE event union ───────────────────────────────────────────────────────

describe('sseEventSchema', () => {
  it('parses a tx event', () => {
    const event: SseEvent = sseEventSchema.parse({
      type: 'tx',
      data: {
        id: 1,
        agentId: VALID_UUID,
        signature: VALID_SIG,
        slot: 1,
        blockTime: VALID_TIMESTAMP,
        programId: VALID_PUBKEY,
        instructionName: null,
        parsedArgs: null,
        solDelta: '0',
        tokenDeltas: [],
        feeLamports: 0,
        success: true,
        rawLogs: [],
      },
    });
    expect(event.type).toBe('tx');
  });

  it('parses a ping event', () => {
    const event = sseEventSchema.parse({
      type: 'ping',
      data: { ts: VALID_TIMESTAMP },
    });
    expect(event.type).toBe('ping');
  });

  it('rejects mixed type+data combinations', () => {
    expect(() =>
      sseEventSchema.parse({
        type: 'ping',
        data: { ts: 'not-iso' },
      }),
    ).toThrow();
  });
});
