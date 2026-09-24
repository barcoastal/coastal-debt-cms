(function () {
  'use strict';
  const form = document.getElementById('leadForm');
  const card = document.getElementById('assessment');
  if (!form || !card) return;
  const fields = Array.isArray(window.join3FormFields) ? window.join3FormFields : [];
  const skipPreQual = card.dataset.skipPrequal === 'true' || card.dataset.formMode === 'normal';
  const readStore = (store, key) => { try { return window[store].getItem(key) || ''; } catch (_) { return ''; } };
  const saveStore = (key, value) => { try { if (value) localStorage.setItem(key, value); } catch (_) {} };
  const cookie = name => {
    const entry = document.cookie.split(';').map(v => v.trim()).find(v => v.startsWith(name + '='));
    if (!entry) return '';
    try { return decodeURIComponent(entry.slice(name.length + 1)); } catch (_) { return ''; }
  };
  const params = new URLSearchParams(location.search);
  const setHidden = (name, value) => {
    let input = [...form.querySelectorAll('input[type="hidden"]')].find(el => el.name === name);
    if (!input) { input = document.createElement('input'); input.type = 'hidden'; input.name = name; form.appendChild(input); }
    input.value = value || '';
  };
  const visitorId = readStore('localStorage', '_vid_') || 'eli_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  saveStore('_vid_', visitorId);
  window._eliClickId = visitorId;
  const rtClickId = () => readStore('sessionStorage', 'rtkclickid') || params.get('rt_clickid') || cookie('rtkclickid-store') || readStore('localStorage', '_rt_clickid') || 'adblock_blocked';
  window.getRtClickId = rtClickId;
  const metaAliases = {
    fb_campaign_id: ['campaign_id', 'c_id', 'sub6', 'utm_id'], fb_adset_id: ['adset_id', 'as_id', 'sub5', 'utm_content'],
    fb_ad_id: ['ad_id', 'sub4', 'utm_term'], fb_campaign_name: ['campaign_name', 'c_name', 'utm_campaign'],
    fb_adset_name: ['adset_name', 'as_name'], fb_ad_name: ['ad_name', 'sub2'], fb_placement: ['placement', 'sub7']
  };
  function fillAttribution() {
    const keys = ['gclid','msclkid','fbclid','rdt_cid','utm_source','utm_medium','utm_campaign','utm_term','utm_content',...Object.keys(metaAliases)];
    keys.forEach(key => {
      const alias = (metaAliases[key] || []).map(k => params.get(k)).find(Boolean);
      let value = params.get(key) || alias || readStore('localStorage', '_' + key) || '';
      if (key === 'gclid' && !value) value = cookie('_gcl_aw').split('.').pop() || '';
      if (value) { saveStore('_' + key, value); setHidden(key, value); }
    });
    const affiliate = params.get('affiliate_clickid') || params.get('click_id') || params.get('clickid') || readStore('localStorage', '_click_id');
    if (affiliate) { saveStore('_click_id', affiliate); setHidden('click_id', affiliate); setHidden('affiliate_clickid', affiliate); }
    const term = params.get('utm_term') || '';
    const keyword = params.get('keyword') || (term && !/^\d+$/.test(term) ? term : '') || readStore('localStorage', '_keyword');
    if (keyword) { saveStore('_keyword', keyword); setHidden('keyword', keyword); }
    const referral = params.get('tkclid') || readStore('localStorage', '_ref_tkclid');
    if (referral) { saveStore('_ref_tkclid', referral); setHidden('affiliate_tkclid', referral); }
    setHidden('tkclid', cookie('tkclid'));
    setHidden('eli_clickid', visitorId);
    setHidden('rt_clickid', rtClickId());
    if (rtClickId() !== 'adblock_blocked') saveStore('_rt_clickid', rtClickId());
    setHidden('page_url', location.href);
    setHidden('referrer_url', document.referrer);
    setHidden('ab_variant', window._abVariant || 'A');
    setHidden('fbc', cookie('_fbc')); setHidden('fbp', cookie('_fbp'));
  }
  const post = (url, data) => fetch(url, {method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data), keepalive: true});
  function trackStep(step, value) {
    post('/api/visitors/funnel-step', {step, value, eli_clickid:visitorId}).catch(() => {});
  }

  // Assigned CMS forms retain their fields, options, required flags and hidden values.
  const container = document.getElementById('dynamicFormFields');
  const reserved = new Set(['landing_page_slug','debt_amount','has_mca','consent']);
  fields.forEach((field, index) => {
    if (!field.name || (!skipPreQual && reserved.has(field.name))) return;
    if (field.type === 'hidden') {
      if (!form.elements.namedItem(field.name)) setHidden(field.name, field.placeholder || field.value || '');
      return;
    }
    if (['landing_page_slug','consent'].includes(field.name)) return;
    if (skipPreQual && reserved.has(field.name)) {
      const initial = form.querySelector('input[type="hidden"][name="' + field.name + '"]');
      if (initial) initial.remove();
    }
    const wrapper = document.createElement('div');
    wrapper.className = 'field' + (['first_name','last_name'].includes(field.name) ? '' : ' field-wide');
    const id = 'j3field-' + index;
    const isChoice = ['radio','checkbox'].includes(field.type);
    const group = isChoice ? document.createElement('fieldset') : wrapper;
    const label = document.createElement(isChoice ? 'legend' : 'label');
    label.textContent = (field.label || field.name) + (field.required ? ' *' : '');
    if (!isChoice) label.htmlFor = id;
    group.appendChild(label);
    const options = Array.isArray(field.options) ? field.options : String(field.options || '').split(',').map(s=>s.trim()).filter(Boolean);
    if (isChoice) {
      (options.length ? options : ['Yes']).forEach((value, i) => {
        const item = document.createElement('label'); item.className = 'field-choice';
        const input = document.createElement('input');
        input.type = field.type; input.name = field.name; input.value = value; input.id = id + '-' + i;
        input.required = !!field.required; item.append(input, document.createTextNode(value)); group.appendChild(item);
      });
      wrapper.appendChild(group);
    } else {
      const type = field.type === 'select' ? 'select' : field.type === 'textarea' ? 'textarea' : 'input';
      const input = document.createElement(type);
      input.name = field.name; input.id = id; input.required = !!field.required;
      if (type === 'input') input.type = ['text','email','tel','number','date','url'].includes(field.type) ? field.type : 'text';
      if (type === 'select') {
        const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Select'; input.appendChild(placeholder);
        options.forEach(value => { const option = document.createElement('option'); option.value = value; option.textContent = value; input.appendChild(option); });
      } else input.placeholder = field.placeholder || '';
      const autocomplete = {first_name:'given-name',last_name:'family-name',company_name:'organization',email:'email',phone:'tel'};
      if (autocomplete[field.name]) input.autocomplete = autocomplete[field.name];
      if (field.type === 'tel') input.inputMode = 'tel';
      wrapper.appendChild(input);
    }
    container.appendChild(wrapper);
  });

  let currentStep = 1;
  function showStep(step, focus = true) {
    currentStep = step;
    form.querySelectorAll('[data-step]').forEach(el => {
      const active = Number(el.dataset.step) === step; el.hidden = !active; el.disabled = !active;
    });
    document.getElementById('stepNumber').textContent = skipPreQual ? '1' : String(step);
    document.getElementById('stepTotal').textContent = skipPreQual ? '1' : '3';
    document.getElementById('progressFill').style.width = (skipPreQual ? 100 : step / 3 * 100) + '%';
    if (focus) form.querySelector('[data-step="' + step + '"] input:not([type=hidden]),[data-step="' + step + '"] select')?.focus({preventScroll:true});
  }
  const debt = document.getElementById('debtSelect');
  debt.addEventListener('change', () => {
    const ineligible = debt.value === 'Under $20,000';
    document.getElementById('debtNotice').hidden = !ineligible;
    setHidden('debt_amount', debt.value);
    if (debt.value) trackStep('debt', debt.value);
    if (debt.value && !ineligible) showStep(2);
  });
  const mcaChoices = form.querySelectorAll('input[name="_qualificationMca"]');
  mcaChoices.forEach(input => input.addEventListener('change', () => {
    setHidden('has_mca', input.value);
    document.getElementById('mcaNotice').hidden = input.value !== 'No';
    trackStep('mca', input.value);
    if (input.value === 'Yes') showStep(3);
  }));
  form.querySelectorAll('[data-back]').forEach(button => button.addEventListener('click', () => {
    const step = Number(button.dataset.back);
    // Clear qualification answers on return so choosing the same answer advances again.
    mcaChoices.forEach(input => input.checked = false);
    setHidden('has_mca', '');
    document.getElementById('mcaNotice').hidden = true;
    if (step === 1) {
      debt.value = '';
      setHidden('debt_amount', '');
      document.getElementById('debtNotice').hidden = true;
    }
    showStep(step);
  }));
  if (skipPreQual) { form.querySelector('[data-back="2"]').hidden = true; showStep(3, false); }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (currentStep !== 3) return;
    if (!form.reportValidity()) return;
    if (!skipPreQual && (!debt.value || debt.value === 'Under $20,000' || form.elements.namedItem('has_mca').value !== 'Yes')) return;
    const button = form.querySelector('.submit-btn');
    if (button.disabled) return;
    const label = button.textContent;
    button.disabled = true; button.textContent = 'Submitting…';
    form.querySelectorAll('[data-back]').forEach(el => el.disabled = true);
    const error = document.getElementById('formError'); error.hidden = true;
    fillAttribution();
    const payload = Object.fromEntries(new FormData(form));
    delete payload._qualificationMca;
    try {
      const response = await post('/api/leads', payload);
      if (!response.ok) throw new Error('Submission failed');
      form.hidden = true; document.getElementById('formProgress').hidden = true;
      document.getElementById('progressFill').style.width = '100%';
      const success = document.getElementById('formSuccess'); success.hidden = false; success.focus({preventScroll:true});
    } catch (_) {
      error.textContent = 'We could not send your assessment. Please try again, or call us using the number above.';
      error.hidden = false; button.disabled = false; button.textContent = label;
      form.querySelectorAll('[data-back]').forEach(el => el.disabled = false);
    }
  });
  const mobileLink = document.getElementById('mobileCtaLink');
  const phone = document.querySelector('.header-phone');
  if (card.dataset.mobileCta === 'call' && phone) { mobileLink.href = phone.href; mobileLink.textContent = 'Call ' + phone.textContent.trim(); }
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(entries => { document.getElementById('mobileCta').hidden = entries[0].isIntersecting; }, {threshold:0}).observe(card);
  }
  const bulletLimit = Number(card.dataset.mobileBulletsCount);
  if (bulletLimit > 0) {
    const media = matchMedia('(max-width:760px)');
    const apply = () => document.querySelectorAll('[data-bullet-index]').forEach(el => el.hidden = media.matches && Number(el.dataset.bulletIndex) >= bulletLimit);
    apply(); media.addEventListener('change', apply);
  }
  fillAttribution();
  fetch('/api/visitors/ip').then(r=>r.json()).then(data=>{if(data.ip) setHidden('visitor_ip',data.ip);}).catch(()=>{});
  const ua = navigator.userAgent;
  let browser = 'Unknown', browserVersion = '', os = 'Unknown';
  for (const [name, pattern] of [['Edge',/Edg\/(\d+)/],['Chrome',/Chrome\/(\d+)/],['Firefox',/Firefox\/(\d+)/],['Safari',/Version\/(\d+).*Safari/]]) {
    const match = ua.match(pattern); if (match) {browser=name;browserVersion=match[1];break;}
  }
  if (/Android/.test(ua)) os='Android'; else if (/iPhone|iPad/.test(ua)) os='iOS'; else if (/Windows/.test(ua)) os='Windows'; else if (/Mac OS/.test(ua)) os='macOS'; else if (/Linux/.test(ua)) os='Linux';
  post('/api/visitors/track', {
    ...Object.fromEntries(new FormData(form)), eli_clickid:visitorId, user_agent:ua, browser, browser_version:browserVersion, os,
    device_type:/iPad|Tablet/.test(ua)?'Tablet':/Mobile|Android|iPhone/.test(ua)?'Mobile':'Desktop',
    screen_width:screen.width, screen_height:screen.height, language:navigator.language || '',
    timezone:Intl.DateTimeFormat().resolvedOptions().timeZone || '', landing_page:location.pathname, referrer_url:document.referrer
  }).catch(()=>{});
})();
