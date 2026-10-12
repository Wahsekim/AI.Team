// Pure ordering only. The reducer owns admission, reservations and transitions.
export function nextTask(spec, state) {
  return spec.tasks.filter(t => ['READY', 'CANDIDATE_READY'].includes(state.tasks[t.id].status)
    && t.dependsOn.every(d => state.tasks[d].status === 'SUCCEEDED'))
    .sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0] ?? null;
}

export function admission(limits, state, reservation, now, quota = null) {
  if (now - state.startedAt >= limits.maxWallMs) return 'time_limit';
  if (limits.quotaStopRemainingPercent !== null) {
    if (!quota || !Number.isFinite(quota.remainingPercent) || quota.remainingPercent < 0 || quota.remainingPercent > 100
      || !Number.isSafeInteger(quota.at) || quota.at > now || now - quota.at > limits.quotaSampleMaxAgeMs) return 'usage_unknown';
    if (quota.remainingPercent <= limits.quotaStopRemainingPercent) return 'quota_threshold';
  }
  if (state.usage.agentCalls + reservation.agentCalls > limits.maxAgentCalls) return 'agent_call_limit';
  for (const [unit, cap, reserve] of [['tokens', 'maxTokens', 'closeoutReserveTokens'], ['costMicroUsd', 'maxCostMicroUsd', 'closeoutReserveMicroUsd']]) {
    if (limits[cap] !== null) {
      if (!Number.isSafeInteger(reservation[unit]) || reservation[unit] < 0 || state.usage[unit] === null) return 'usage_unknown';
      const outstanding = Object.values(state.dispatches).filter(d => !d.receipt).reduce((sum, d) => sum + d.reservation[unit], 0);
      if (state.usage[unit] + outstanding + reservation[unit] > limits[cap] - limits[reserve]) return `${unit}_limit`;
    }
  }
  return null;
}
