// engine/gates/approval.ts — G5 approval requirement gate

import type { RiskLevel, Author, Flags, ApprovalResult } from '../types';
import { RISK_ORDER } from './blast_radius';

interface ApprovalInput {
  riskLevel?: RiskLevel;
  author?: Author;
  flags?: Flags;
}

export function evaluateApproval(params: ApprovalInput): ApprovalResult {
  const riskLevel: RiskLevel = params.riskLevel || 'medium';
  const author: Author = params.author || 'human';
  const flags: Flags = params.flags || {};

  const req: 'human_token' | 'director' | 'none' =
    author === 'agent'
      ? (RISK_ORDER[riskLevel] >= RISK_ORDER['medium'] ? 'human_token' : 'none')
      : (riskLevel === 'critical' ? 'director' : 'none');

  let approved = true;
  let reason: string | null = null;
  if ((req === 'human_token' || req === 'director') && !flags.approval) {
    approved = false;
    reason = req === 'director'
      ? riskLevel + ' change requires director approval'
      : 'Agent change requires human approval';
  }

  return { approved, requirement: req, reason, riskLevel, author };
}
