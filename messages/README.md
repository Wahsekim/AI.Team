# Messages

Daily inter-agent dialogue files live here. Use `YYYY-MM-DD.md`.
Rotation: slim-active + archive (`docs/process-index.md` -> Rotation Regime) —
move old months to `messages/archive/`, noting any known gaps in this README.

Format:

```md
## {{UTC_TIME}} - {{ROLE_DISPLAY_NAME}} - {{TICKET_ID}}

One short message, handoff, or decision note.
```

Do not duplicate lifecycle close artifacts here.

Engine-mode loops: the `run-n-rounds` engine returns a preformatted
`mainSessionTodo.messagesLogBlock` per batch — the PM pastes it VERBATIM into
`messages/<date>.md`; manual re-derivation is banned (`docs/engine.md`).
