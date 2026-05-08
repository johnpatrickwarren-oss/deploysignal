// engine/gates/blast_radius.ts — G4 blast-radius classifier
// Escalates risk for agent-authored changes against a per-changeType floor.

import type { RiskLevel, Author, ChangeType, BlastRadiusResult } from '../types';

export const RISK_ORDER: { [k in RiskLevel]: number } = { low: 0, medium: 1, high: 2, critical: 3 };

interface ClassifyInput {
  riskLevel?: RiskLevel;
  author?: Author;
  changeType?: ChangeType;
  filePaths?: string[] | null;
}

export function classifyRisk(d: ClassifyInput): BlastRadiusResult {
  let risk: RiskLevel = d.riskLevel || 'medium';
  const declared: RiskLevel = d.riskLevel || 'medium';
  const reasons: string[] = [];

  if (d.author === 'agent' && d.changeType !== 'documentation') {
    const floorMap: { [k in ChangeType]: RiskLevel } = {
      model_weights: 'critical',
      serving_code: 'medium',
      config: 'medium',
      infrastructure: 'low',
      documentation: 'low',
    };
    const floor: RiskLevel = (d.changeType && floorMap[d.changeType]) || 'medium';
    if (RISK_ORDER[floor] > RISK_ORDER[risk]) {
      risk = floor;
      reasons.push('agent escalation');
    }
  }

  return {
    riskLevel: risk,
    declaredRisk: declared,
    author: d.author || 'human',
    changeType: d.changeType || 'serving_code',
    escalated: risk !== declared,
    escalationReasons: reasons,
    requiresApproval: d.author === 'agent' && RISK_ORDER[risk] >= RISK_ORDER['medium'],
  };
}
