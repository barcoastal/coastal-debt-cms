// Join3 uses the standard CMS content fields and Coastal's existing proof assets.
const defaults = {
  badge: 'Free assessment for businesses with $20K+ in MCA debt',
  headline: 'Take control of your',
  headlineHighlight: 'MCA debt.',
  headlineLine2: 'Get back to running your business.',
  subheadline: 'When daily payments leave little room to breathe, a different path can help. Explore a debt settlement plan built around your business with Coastal Debt Resolve.',
  bulletPoints: [
    'Explore ways to reduce your MCA balance',
    'Work toward payments your cash flow can support',
    'Get a plan for multiple merchant cash advances',
    'Work with a dedicated Debt Settlement Advisor',
    'Keep your focus on running your business'
  ],
  phone: '(888) 961-5338',
  mobileCta: 'form',
  formMode: 'prequalify',
  formTitle: 'How much debt does your business have?',
  formSubtitle: 'Select your total balance to explore your relief options.',
  formButton: 'Get My Free Assessment',
  howItWorksTitle: 'A clear path from MCA debt to a fresh start.',
  howItWorksSubtitle: 'One conversation is the first step. We help you understand your options and what comes next.',
  steps: [
    {title: 'Start with a free assessment', description: 'Tell us about your business and your MCA balances. An advisor reviews your situation and helps you understand whether settlement could be a fit.'},
    {title: 'Build a plan around your business', description: 'We review your obligations and work with your creditors toward settlement terms that fit your business and its cash flow.'},
    {title: 'Move forward with support', description: 'Your dedicated advisor keeps you informed throughout the process, so you can focus on your business while working toward resolving your debt.'}
  ],
  empathyTitle: 'Your business deserves room to breathe.',
  empathyText: [
    '# A plan built around you\nYour business is more than a balance sheet. We take the time to understand your MCA obligations and your priorities before discussing a path forward.',
    '# One dedicated point of contact\nYou deserve clear answers and regular updates. Your Debt Settlement Advisor helps you understand each step of the process.',
    '# Experience at the negotiating table\nOur team works with MCA creditors to pursue negotiated settlements, with the goal of reducing your balance and helping your business move forward.'
  ],
  caseStudiesTitle: 'Real settlements. Real breathing room.',
  caseStudiesSubtitle: 'Examples of settlements Coastal negotiated for business owners. Individual results vary.',
  testimonialsTitle: 'Business owners. In their own words.',
  testimonialsSubtitle: 'A few words from Coastal Debt Resolve clients.',
  comparisonTitle: 'A different way forward for your business.',
  comparisonSubtitle: 'Understand your options before taking on another advance.',
  comparisonColBad: 'The pressure of stacked MCAs',
  comparisonColGood: 'A plan with Coastal',
  comparisonRows: [
    {label: 'Your options', bad: 'Another advance to cover existing payments', good: 'Explore settling the debt you already have'},
    {label: 'Your plan', bad: 'Multiple creditors and payment schedules', good: 'A coordinated strategy for your MCA obligations'},
    {label: 'Your support', bad: 'Trying to navigate the next step alone', good: 'A dedicated advisor to guide you'},
    {label: 'Your focus', bad: 'Less time to focus on your business', good: 'A team working on your debt settlement plan'}
  ],
  comparisonCtaText: 'Explore My Options',
  faqTitle: 'Questions business owners ask.',
  faqSubtitle: 'Start with clear answers. Then talk through your specific situation with an advisor.',
  faqItems: [
    {question: 'What is MCA debt settlement?', answer: 'MCA debt settlement involves negotiating with your merchant cash advance providers to resolve outstanding balances. Coastal reviews your situation and works toward a settlement plan for your business.'},
    {question: 'Can you help with multiple merchant cash advances?', answer: 'Yes. Coastal works with business owners who have multiple MCA obligations. Your free assessment is a chance to review those balances together and discuss your options.'},
    {question: 'Is this a new loan?', answer: 'No. This is an assessment for MCA debt relief, not an application for a new loan. The goal is to explore resolving existing MCA debt.'},
    {question: 'How much could I save?', answer: 'Savings depend on your balances, your creditors, and the terms that can be negotiated. The settlement examples on this page show past results, not a guarantee of your outcome.'},
    {question: 'How long does the process take?', answer: 'Timing varies by business and creditor. Your advisor can explain the likely process after reviewing your MCA obligations and financial situation.'},
    {question: 'Do I qualify for a free assessment?', answer: 'This program is for business owners with $20,000 or more in MCA or unsecured business debt. Start with the short form above so an advisor can review your situation. There is no obligation to enroll.'}
  ],
  ctaTitle: 'Less debt pressure. More room for your business.',
  ctaSubtitle: 'Your next chapter starts with a free, confidential conversation.',
  ctaButton: 'Start My Free Assessment',
  pageTitle: 'MCA Debt Relief & Free Assessment | Coastal Debt Resolve',
  metaDescription: 'Explore your MCA debt relief options with Coastal Debt Resolve. Get a free assessment and a settlement plan built around your business.'
};

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));

function render(html, content, visibility = {}) {
  const list = key => Array.isArray(content[key]) ? content[key] : [];
  const blocks = {
    join3Bullets: list('bulletPoints').map((text, i) => '<li data-bullet-index="' + i + '"><span class="check" aria-hidden="true">✓</span>' + escapeHtml(text) + '</li>').join(''),
    join3Steps: list('steps').map((step, i) => '<article class="step"><span class="step-number">' + (i + 1) + '</span><h3>' + escapeHtml(step.title) + '</h3><p>' + escapeHtml(step.description) + '</p></article>').join(''),
    join3Benefits: list('empathyText').map((text, i) => {
      const lines = String(text).split('\n');
      const title = lines[0].startsWith('#') ? lines.shift().replace(/^#+\s*/, '') : '';
      return '<article class="benefit"><span class="eyebrow">' + String(i + 1).padStart(2, '0') + '</span>' + (title ? '<h3>' + escapeHtml(title) + '</h3>' : '') + '<p>' + escapeHtml(lines.join(' ')) + '</p></article>';
    }).join(''),
    join3Comparison: list('comparisonRows').map(row => '<tr><td data-label="' + escapeHtml(content.comparisonColBad) + '">' + escapeHtml(row.bad) + '</td><td data-label="' + escapeHtml(content.comparisonColGood) + '"><span class="check" aria-hidden="true">✓</span><span>' + escapeHtml(row.good) + '</span></td></tr>').join(''),
    join3Faq: list('faqItems').map(item => '<details><summary>' + escapeHtml(item.question) + '<span aria-hidden="true">+</span></summary><p>' + escapeHtml(item.answer) + '</p></details>').join('')
  };
  for (const [key, value] of Object.entries(blocks)) html = html.replaceAll('{{' + key + '}}', () => value);
  // Keep content text out of executable script contexts and preserve literal $ values.
  for (const [key, value] of Object.entries(content)) {
    if (typeof value === 'string') html = html.replaceAll('{{' + key + '}}', () => escapeHtml(value));
  }
  for (const [key, visible] of Object.entries(visibility)) {
    if (visible === false && /^[a-zA-Z]+$/.test(key)) html = html.replace(new RegExp('<!-- SECTION:' + key + ' -->[\\s\\S]*?<!-- /SECTION:' + key + ' -->', 'g'), '');
  }
  return html;
}

module.exports = { defaults, render };
