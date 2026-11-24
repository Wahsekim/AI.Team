(() => {
  const views = [...document.querySelectorAll('.ticket-view')]
  const ticketButtons = [...document.querySelectorAll('[data-select-ticket]')]
  const selectTicket = id => {
    for (const v of views) v.hidden = v.dataset.ticket !== id
    for (const b of ticketButtons) {
      const on = b.dataset.selectTicket === id
      b.classList.toggle('selected', on)
      b.setAttribute('aria-pressed', String(on))
    }
  }
  const selectNode = (view, index) => {
    for (const b of view.querySelectorAll('[data-select-node]')) {
      const on = Number(b.dataset.selectNode) === index
      b.classList.toggle('selected', on)
      b.setAttribute('aria-pressed', String(on))
    }
    for (const p of view.querySelectorAll('[data-panel]')) p.hidden = Number(p.dataset.panel) !== index
  }
  document.addEventListener('click', event => {
    const ticket = event.target.closest('[data-select-ticket]')
    if (ticket) return selectTicket(ticket.dataset.selectTicket)
    const node = event.target.closest('[data-select-node]')
    if (node) selectNode(node.closest('.ticket-view'), Number(node.dataset.selectNode))
  })
})()
