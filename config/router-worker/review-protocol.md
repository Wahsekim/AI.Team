# Router/Worker batch review

The protocol a Security or Architect reviewer follows when the kit briefs it on a batch in review (ADR 0011).
It adds to the reviewer's own role file; it replaces none of its obligations.

1. Work from the brief only. It holds the tickets' goals and acceptance, the diff, the flagged files, the rules,
   the ADRs and the output of the verification commands the kit ran. It never holds a worker's report or the
   checker's verdict; do not ask for them.
2. Open every flagged file the brief lists with the Read tool, by the absolute path given. Opening it any other
   way does not count. Report each file in `filesRead` with `read: true`, or `read: false` and the reason.
3. Check every rule the brief lists against every ticket. Report each as `pass`, `fail` or `not-checked`,
   with the file and line it rests on. A rule left out of the report, or every rule `not-checked`, means the
   review was not done.
4. Give each ticket a verdict:
   - GREEN: every rule passes.
   - AMBER: a concern that fails no rule. The ticket is still committed; the PM files the concern as a
     backlog ticket.
   - RED: at least one rule fails. Only a failed rule rejects a ticket.
5. For each failed rule, name the fix and propose a control that would catch it next time: what it detects,
   the variation it must also catch, and whether a tool (lint, test, scanner) can detect it.
6. Write nothing in the product and run no shell command. The Architect may write an ADR draft under
   `decisions/drafts/` of the team folder, and nowhere else.
7. Return the report in the schema the brief gives, as the last fenced json block of the final message,
   with the brief's `briefDigest`.
