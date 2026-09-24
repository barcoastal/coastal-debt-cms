/* Presentation and navigation for the existing admin. No background integrations. */
(function () {
  const sidebar = document.querySelector('.sidebar');
  if (!sidebar) return;
  document.body.classList.add('cms-workspace');
  const nav = sidebar.querySelector('.sidebar-nav');
  const main = document.querySelector('.main-content');
  const label = text => {
    const el = document.createElement('span');
    el.className = 'nav-section-label';
    el.textContent = text;
    return el;
  };
  if (nav) {
    nav.setAttribute('aria-label', 'Main navigation');
    const contentLinks = ['pages.html', 'articles.html', 'forms.html', 'ad-generator.html']
      .map(file => nav.querySelector('a[href="/admin/' + file + '"]')).filter(Boolean);
    const fragment = document.createDocumentFragment();
    const finder = document.getElementById('qfNavBtn');
    if (finder) fragment.append(finder);
    fragment.append(label('Content'));
    contentLinks.forEach(link => fragment.append(link));
    fragment.append(label('Workspace'));
    nav.prepend(fragment);
    const settings = nav.querySelector('a[href="/admin/settings.html"]');
    if (settings) settings.before(label('Administration'));
    nav.querySelectorAll('a.active').forEach(link => link.setAttribute('aria-current', 'page'));
  }

  const bar = document.createElement('div');
  bar.className = 'mobile-workspace-bar';
  bar.innerHTML = '<button type="button" aria-label="Open navigation" aria-expanded="false" aria-controls="workspaceSidebar">☰</button><strong>NAUTILUS</strong><button type="button" class="mobile-find">Find page</button>';
  document.body.prepend(bar);
  sidebar.id = 'workspaceSidebar';
  const menu = bar.querySelector('button');
  const backdrop = document.createElement('button');
  backdrop.type = 'button';
  backdrop.className = 'workspace-backdrop';
  backdrop.hidden = true;
  backdrop.tabIndex = -1;
  backdrop.setAttribute('aria-label', 'Close navigation');
  document.body.append(backdrop);
  let priorOverflow = '';
  function setNav(open, restoreFocus = true) {
    if (open) priorOverflow = document.body.style.overflow;
    sidebar.classList.toggle('workspace-open', open);
    menu.setAttribute('aria-expanded', String(open));
    backdrop.hidden = !open;
    if (main) main.inert = open;
    bar.inert = open;
    document.body.style.overflow = open ? 'hidden' : priorOverflow;
    if (open) (sidebar.querySelector('button, a') || sidebar).focus();
    else if (restoreFocus) menu.focus();
  }
  menu.addEventListener('click', () => setNav(true));
  backdrop.addEventListener('click', () => setNav(false));
  bar.querySelector('.mobile-find').addEventListener('click', () => window.openQuickFinder?.());
  sidebar.addEventListener('click', event => {
    if (sidebar.classList.contains('workspace-open') && event.target.closest('#qfNavBtn')) setNav(false, false);
  });
  const mobile = matchMedia('(max-width: 768px)');
  mobile.addEventListener('change', () => {
    if (!mobile.matches && sidebar.classList.contains('workspace-open')) setNav(false, false);
  });
  function trapFocus(event, root) {
    const nodes = [...root.querySelectorAll('a[href],button,input,select,textarea,[tabindex="0"]')]
      .filter(node => !node.disabled && node.getClientRects().length);
    if (!nodes.length) return;
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (event.shiftKey && (document.activeElement === first || !nodes.includes(document.activeElement))) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !nodes.includes(document.activeElement))) {
      event.preventDefault(); first.focus();
    }
  }
  document.addEventListener('keydown', event => {
    if (sidebar.classList.contains('workspace-open')) {
      if (event.key === 'Escape') setNav(false);
      if (event.key === 'Tab') trapFocus(event, sidebar);
    }
  });

  // Reuse the existing form and all its field handlers inside a larger workspace.
  const modal = document.getElementById('editModal');
  if (modal && document.body.classList.contains('cms-pages')) {
    const panel = modal.querySelector('.modal');
    const form = document.getElementById('editForm');
    const footer = form.querySelector('.modal-footer');
    footer.querySelector('[type="submit"]').setAttribute('form', 'editForm');
    const note = document.createElement('span');
    note.className = 'editor-save-note';
    note.id = 'editSaveNote';
    note.setAttribute('role', 'status');
    note.textContent = 'Saving updates the landing page.';
    footer.prepend(note);
    const body = document.createElement('div');
    body.className = 'editor-modal-body';
    const sections = document.createElement('nav');
    sections.className = 'editor-section-nav';
    sections.setAttribute('aria-label', 'Page sections');
    body.append(sections);
    form.before(body);
    body.append(form);
    panel.append(footer);
    const title = panel.querySelector('h2');
    title.id = 'editModalTitle';
    title.tabIndex = -1;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', title.id);
    panel.querySelector('.modal-close').setAttribute('aria-label', 'Close page editor');
    const preview = document.createElement('a');
    preview.className = 'saved-page-link';
    preview.textContent = 'View saved page ↗';
    preview.target = '_blank';
    preview.rel = 'noopener';
    panel.querySelector('.modal-close').before(preview);
    let opener = null;
    function buildSections() {
      sections.innerHTML = '<span>Page sections</span>';
      form.querySelectorAll('.edit-section').forEach(section => {
        if (getComputedStyle(section).display === 'none') return;
        const heading = section.querySelector('.section-header');
        const content = section.querySelector('.section-content');
        if (!heading || !content) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = heading.querySelector('span').textContent.replace('📄 ', '');
        button.addEventListener('click', () => {
          content.classList.remove('hidden');
          heading.querySelector('.toggle-icon').textContent = '-';
          heading.setAttribute('aria-expanded', 'true');
          sections.querySelectorAll('button').forEach(item => item.classList.toggle('active', item === button));
          form.scrollTo({top: form.scrollTop + section.getBoundingClientRect().top - form.getBoundingClientRect().top - 16});
          heading.focus({preventScroll: true});
        });
        sections.append(button);
      });
    }
    form.querySelectorAll('.section-header').forEach(heading => {
      const content = heading.nextElementSibling;
      heading.tabIndex = 0;
      heading.setAttribute('role', 'button');
      heading.setAttribute('aria-controls', content.id);
      heading.setAttribute('aria-expanded', String(!content.classList.contains('hidden')));
      heading.addEventListener('click', () => heading.setAttribute('aria-expanded', String(!content.classList.contains('hidden'))));
      heading.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); heading.click(); }
      });
    });
    form.addEventListener('invalid', event => {
      const content = event.target.closest('.section-content');
      if (content?.classList.contains('hidden')) content.previousElementSibling.click();
    }, true);
    new MutationObserver(() => {
      const open = modal.classList.contains('active');
      if (open) {
        opener = document.activeElement;
        title.textContent = document.getElementById('editName').value || 'Edit landing page';
        preview.href = '/lp/' + encodeURIComponent(document.getElementById('editSlug').value) + '/';
        note.textContent = 'Saving updates the landing page.';
        buildSections();
        form.scrollTop = 0;
        title.focus();
      } else if (opener?.isConnected) opener.focus();
    }).observe(modal, {attributes: true, attributeFilter: ['class']});
    document.getElementById('editTemplateType').addEventListener('change', buildSections);
    modal.addEventListener('keydown', event => {
      if (event.key === 'Tab') trapFocus(event, panel);
      if (event.key === 'Escape' && !footer.querySelector('[type="submit"]').disabled) hideModal('editModal');
    });
  }

  if (document.body.classList.contains('cms-editor')) {
    const panel = document.querySelector('.editor-panel');
    const jump = document.getElementById('editorSectionJump');
    panel.querySelectorAll('.editor-section').forEach((section, index) => {
      section.id = 'editor-section-' + index;
      const option = document.createElement('option');
      option.value = section.id;
      option.textContent = section.querySelector('h3').textContent.trim();
      jump.append(option);
    });
    jump.addEventListener('change', () => {
      const section = document.getElementById(jump.value);
      if (!section) return;
      panel.scrollTop += section.getBoundingClientRect().top - panel.getBoundingClientRect().top - 20;
      section.querySelector('input,textarea,button')?.focus({preventScroll: true});
    });
    document.querySelectorAll('[data-preview-size]').forEach(button => {
      button.addEventListener('click', () => {
        document.getElementById('previewFrame').classList.toggle('mobile-preview', button.dataset.previewSize === 'mobile');
        document.querySelectorAll('[data-preview-size]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
      });
    });
  }
})();
