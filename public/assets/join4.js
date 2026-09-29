(function () {
  'use strict';
  const select = document.getElementById('debtSelect');
  if (!select) return;
  const mobile = matchMedia('(max-width:760px)');
  const wrap = document.createElement('div');
  wrap.className = 'debt-picker';
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'debt-picker-trigger';
  trigger.id = 'debtPickerTrigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', 'debtPickerOptions');
  const list = document.createElement('div');
  list.id = 'debtPickerOptions';
  list.className = 'debt-picker-options';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Total business debt');
  list.hidden = true;
  const options = [...select.options].filter(option => option.value).map(option => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = option.textContent;
    button.dataset.value = option.value;
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', 'false');
    button.tabIndex = -1;
    button.addEventListener('click', () => {
      select.value = option.value;
      close(true);
      sync();
      select.dispatchEvent(new Event('change', {bubbles:true}));
    });
    list.appendChild(button);
    return button;
  });
  wrap.append(trigger, list);
  select.after(wrap);
  function sync() {
    trigger.textContent = select.selectedOptions[0].textContent;
    trigger.setAttribute('aria-label', 'Total business debt: ' + trigger.textContent);
    options.forEach(option => option.setAttribute('aria-selected', String(option.dataset.value === select.value)));
  }
  function close(focus) {
    list.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (focus) trigger.focus({preventScroll:true});
  }
  function open(last) {
    sync();
    list.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    (options.find(option => option.dataset.value === select.value) || options[last ? options.length - 1 : 0]).focus({preventScroll:true});
  }
  trigger.addEventListener('click', () => list.hidden ? open(false) : close(false));
  trigger.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); open(event.key === 'ArrowUp');
    }
  });
  wrap.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); close(true); }
    const index = options.indexOf(document.activeElement);
    if (index < 0) return;
    let next;
    if (event.key === 'ArrowDown') next = (index + 1) % options.length;
    if (event.key === 'ArrowUp') next = (index + options.length - 1) % options.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = options.length - 1;
    if (next !== undefined) { event.preventDefault(); options[next].focus({preventScroll:true}); }
  });
  document.addEventListener('pointerdown', event => { if (!wrap.contains(event.target)) close(false); });
  wrap.addEventListener('focusout', event => { if (!wrap.contains(event.relatedTarget)) close(false); });
  select.addEventListener('change', sync);
  document.querySelectorAll('#leadForm [data-back]').forEach(button => button.addEventListener('click', sync));
  function apply() {
    close(false);
    select.hidden = mobile.matches;
    wrap.hidden = !mobile.matches;
    sync();
  }
  mobile.addEventListener('change', apply);
  apply();
})();
