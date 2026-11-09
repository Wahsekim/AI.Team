function section(text, from, until) {
  const start = text.indexOf(from);
  const end = text.indexOf(until, start + from.length);
  if (start < 0 || end < 0) throw Error('Pinned blast-radius structure changed');
  return text.slice(start, end).trim();
}

export function renderBlastRadius(text) {
  return [
    'Impact review of the host-bound candidate, including uncommitted changes. Do not substitute a base...HEAD diff that omits the candidate.',
    'Use only the approved verification environment. If a needed probe exceeds permissions, report it as unproven and ask PM; do not create another agent or expand scope.',
    section(text, "## Don't trust your own writeup", '## Steps'),
    section(text, '2. Find the one fact', '6. For a big').replace(' Same rules as `why`.', ''),
    section(text, '## What to hand back', 'Write it through'),
  ].join('\n\n') + '\n';
}
