(() => {
  'use strict';
  const api = document.modelContext || navigator.modelContext;
  if (!api?.registerTool) return;
  const links = [...document.querySelectorAll('#destinations a[data-destination]')];
  const pages = links.map((link) => ({
    path: link.getAttribute('href'),
    title: link.dataset.pageTitle,
    description: link.dataset.pageDescription,
  }));
  const chapterSchema = { type: 'string', enum: pages.map((page) => page.path) };
  const schema = (properties, required = []) => ({
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  });
  let manuscript;
  const read = async (path, signal) => {
    const selected = path ? pages.findIndex((page) => page.path === path) : -1;
    if (path && selected < 0) return { status: 'invalid_chapter' };
    if (!manuscript) {
      const response = await fetch(new URL('assets/portfolio.json', document.baseURI), { signal });
      if (!response.ok) throw new Error('Manuscript unavailable');
      manuscript = await response.json();
    }
    return {
      status: 'ok',
      current_path: location.pathname,
      chapters: manuscript.filter((_, index) => selected < 0 || index === selected),
    };
  };
  const tools = [
    {
      name: 'read_portfolio',
      description:
        'Read Kallas Lima’s public portfolio and canonical chapter paths. Optionally select one chapter. Does not navigate or access private form fields.',
      inputSchema: schema({ chapter: chapterSchema }),
      annotations: { readOnlyHint: true },
      execute: (args, context) => read(args.chapter, context?.signal),
    },
    {
      name: 'open_chapter',
      description:
        'Travel to a portfolio chapter using the cockpit’s normal animation. Waits for readiness and settled URL, up to 15 seconds. Explicit reduced-motion visits retain their preference. A busy, canceled, timeout or unavailable result is not completion. Never reloads the page.',
      inputSchema: schema({ chapter: chapterSchema }, ['chapter']),
      execute: (args, context) => {
        const index = pages.findIndex((page) => page.path === args.chapter);
        if (index < 0) return { status: 'invalid_chapter' };
        return actions(context?.signal, (controller, deadline) =>
          controller.openChapter(index, context?.signal, deadline),
        );
      },
    },
    {
      name: 'set_display_state',
      description:
        'Animate a cockpit display open or folded using its existing hinge. Main tilts the whole attached display assembly. Side displays can be unavailable on small viewports or at the first/last chapter. Repeated requests set the state, never toggle it. Human input cancels the action.',
      inputSchema: schema(
        {
          display: { type: 'string', enum: ['main', 'left', 'right'] },
          state: { type: 'string', enum: ['open', 'folded'] },
        },
        ['display', 'state'],
      ),
      execute: (args, context) => {
        if (
          !['main', 'left', 'right'].includes(args.display) ||
          !['open', 'folded'].includes(args.state)
        )
          return { status: 'invalid' };
        return actions(context?.signal, (controller, deadline) =>
          controller.setDisplay(args.display, args.state, context?.signal, deadline),
        );
      },
    },
    {
      name: 'prepare_contact',
      description:
        'Prepare a visible contact draft for Kallas Lima without sending. Show the returned recipient and exact name/email/message to the visitor and obtain approval before send_contact. Preserves a different existing draft; replace_draft_id may replace an unchanged draft from a prior preparation. The returned draft ID is valid only in this document.',
      inputSchema: schema(
        {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          email: { type: 'string', format: 'email', maxLength: 254 },
          message: { type: 'string', minLength: 1, maxLength: 5000 },
          replace_draft_id: { type: 'string' },
        },
        ['name', 'email', 'message'],
      ),
      execute: (args) => window.CockpitContact.prepare(args),
    },
    {
      name: 'send_contact',
      description:
        'Actually send the exact prepared contact draft to Kallas Lima through Web3Forms. Call only after the visitor has reviewed and approved its recipient and content. Changed drafts are rejected. An accepted result means provider acceptance, not inbox delivery. Never automatically retry an unconfirmed outcome, including after a reload.',
      inputSchema: schema({ draft_id: { type: 'string' } }, ['draft_id']),
      annotations: { consequentialHint: true },
      execute: (args, context) => window.CockpitContact.send(args.draft_id, context?.signal),
    },
  ];
  async function actions(signal, run) {
    const deadline = performance.now() + 15000;
    while (!window.CockpitActions) {
      if (signal?.aborted) return { status: 'canceled' };
      if (performance.now() >= deadline) return { status: 'not_ready' };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return run(window.CockpitActions, deadline);
  }
  for (const tool of tools) {
    const execute = tool.execute;
    // Registration failures affect only optional tools, never the visible site.
    try {
      const registration = api.registerTool({
        ...tool,
        execute: async (args, context) => {
          try {
            return await execute(args || {}, context);
          } catch {
            return { status: context?.signal?.aborted ? 'canceled' : 'unavailable' };
          }
        },
      });
      // Current browsers can reject registration asynchronously (for example,
      // when tools are disabled). A rejected optional API must not leak errors.
      Promise.resolve(registration).catch(() => {});
    } catch {
      /* An unsupported/disabled draft API leaves normal controls usable. */
    }
  }
})();
