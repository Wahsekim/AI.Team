export function draftSpecFixture() {
  return {
    schemaVersion: 1, mode: 'router-worker',
    project: { name: 'Tag List Fixture', slug: 'tag-list-fixture', productRoot: '/fixture-product-not-created', ui: false },
    profiles: {
      exec: { model: 'fixture-model', effort: 'high', maxTurns: 20, tools: ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit'] },
      check: { model: 'fixture-model', effort: 'high', maxTurns: 15, tools: ['Read', 'Grep', 'Glob', 'Bash'] },
      guard: { model: 'fixture-model', effort: 'high', maxTurns: 10, tools: ['Read', 'Grep', 'Glob'] },
    },
    workflowStates: Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`WF-${String(i).padStart(2, '0')}`, {
      status: i === 16 ? 'deferred' : 'enabled',
      reason: i === 16 ? 'First release is serial' : 'Synthetic coverage fixture; not owner ratification', decisionRef: null,
    }])),
  };
}
