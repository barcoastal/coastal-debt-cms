const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../database');
const { authenticateToken } = require('./auth');

const router = express.Router();

// Import logActivity (loaded after initialization to avoid circular deps)
let logActivity = null;
setTimeout(() => {
  try { logActivity = require('./settings').logActivity; } catch (e) {}
}, 0);

// Default form fields
const defaultFormFields = [
  { name: 'has_mca', label: 'Do you have MCA (Merchant Cash Advance) debt?', type: 'radio', required: true, options: 'Yes,No' },
  { name: 'company_name', label: 'Company Name', type: 'text', required: true, placeholder: 'Your Company Name' },
  { name: 'first_name', label: 'First Name', type: 'text', required: true, placeholder: 'John' },
  { name: 'last_name', label: 'Last Name', type: 'text', required: true, placeholder: 'Smith' },
  { name: 'email', label: 'Email', type: 'email', required: true, placeholder: 'john@company.com' },
  { name: 'phone', label: 'Phone', type: 'tel', required: true, placeholder: '(555) 123-4567' }
];

// Authority template form fields (no MCA radio question)
const authorityFormFields = [
  { name: 'first_name', label: 'First Name', type: 'text', required: true, placeholder: 'John' },
  { name: 'last_name', label: 'Last Name', type: 'text', required: true, placeholder: 'Smith' },
  { name: 'company_name', label: 'Business Name', type: 'text', required: true, placeholder: 'Your Company Name' },
  { name: 'email', label: 'Email Address', type: 'email', required: true, placeholder: 'john@company.com' },
  { name: 'phone', label: 'Phone Number', type: 'tel', required: true, placeholder: '(555) 123-4567' },
  { name: 'debt_amount', label: 'Estimated Business Debt', type: 'select', required: true, options: '$10,000 - $50,000,$50,000 - $100,000,$100,000 - $250,000,$250,000 - $500,000,$500,000+' }
];

// Default content template
const defaultContent = {
  badge: "MCA Debt Relief",
  headline: "Drowning in MCA Debt?",
  headlineLine2: "Settle Your MCA Debt for",
  headlineHighlight: "Up to 80% Less.",
  subheadline: "Thousands of business owners escaped crushing MCA payments by settling their debt through us. Stop the daily ACH withdrawals. Keep your business running.",
  bulletPoints: [
    "Stop daily/weekly ACH withdrawals",
    "Reduce your total MCA balance by 50-80%",
    "Keep your business & revenue",
    "No upfront fees — we get paid when you save"
  ],
  formTitle: "See If You Qualify",
  formSubtitle: "Takes 60 seconds. No obligation.",
  formButton: "Get My Free MCA Analysis",
  trustLabel: "As Seen In & Trusted By",
  comparisonTitle: "Why Business Owners Choose MCA Debt Settlement",
  howItWorksTitle: "How It Works",
  howItWorksSubtitle: "Our proven 3-step process has helped over 1,500 businesses resolve MCA debt",
  steps: [
    { title: "Free MCA Debt Analysis", description: "Tell us about your MCA debt. We'll review your advances and show you exactly how much you could save through settlement." },
    { title: "We Negotiate With Your MCA Lenders", description: "Our team contacts your MCA companies directly. We negotiate to reduce your total debt by 50-80% and stop the daily withdrawals." },
    { title: "Debt Resolved, Business Saved", description: "Pay a fraction of what you owed. Your daily ACH payments stop. Your cash flow recovers and your business keeps running." }
  ],
  caseStudiesTitle: "Real MCA Settlements. Real Savings.",
  caseStudiesSubtitle: "These are actual MCA settlement agreements we negotiated for our clients",
  empathyTitle: "We Know MCA Debt Is Crushing. You're Not Alone.",
  empathyText: [
    "When MCA companies are draining your bank account every single day, it feels like there's no way out. The stacked advances, the confusing factor rates, the aggressive collections — we understand what you're going through.",
    "But here's what we want you to know: MCA debt can be settled for a fraction of what you owe. Every day, we help business owners just like you break free from the MCA debt cycle.",
    "You don't have to face this alone. Let us fight for you."
  ],
  testimonialsTitle: "Real People. Real Results.",
  testimonialsSubtitle: "Hear from business owners who found MCA debt relief with Coastal Debt",
  ctaTitle: "Stop the Daily MCA Withdrawals Today",
  ctaSubtitle: "Free consultation. See how much of your MCA debt we can settle.",
  ctaButton: "Get My Free MCA Analysis",
  pageTitle: "MCA Debt Relief | Settle Merchant Cash Advance Debt for 50-80% Less",
  metaDescription: "Struggling with MCA debt? Settle your Merchant Cash Advance debt for a fraction of what you owe. Stop daily ACH withdrawals. Free consultation.",
  comparisonSubtitle: "See why thousands of business owners chose settlement over continuing MCA payments",
  comparisonColBad: "Keeping MCA Debt",
  comparisonColGood: "MCA Debt Settlement",
  comparisonRows: [
    { label: "Daily Payments", bad: "Continue daily/weekly ACH drains", good: "Payments stop during negotiation" },
    { label: "Total Cost", bad: "Pay back 1.3x-1.5x the advance", good: "Settle for 50-80% less" },
    { label: "Cash Flow", bad: "Strangled by daily withdrawals", good: "Cash flow recovers immediately" },
    { label: "Stacked Advances", bad: "Cycle of borrowing to repay", good: "Resolve all MCAs at once" },
    { label: "Time to Resolve", bad: "Trapped for 6-18 months", good: "3-6 months average" },
    { label: "Your Business", bad: "Risk of closure from cash drain", good: "Keep operating and growing" },
    { label: "Future Financing", bad: "Stuck in MCA cycle", good: "Access better financing options" }
  ],
  comparisonCtaText: "See How Much You Could Save on Your MCA Debt",
  faqTitle: "MCA Debt Questions? We Have Answers.",
  faqSubtitle: "Get the facts about MCA debt settlement",
  faqItems: [
    { question: "Can MCA debt really be settled for less?", answer: "Yes. MCA companies often accept 20-50 cents on the dollar through negotiated settlements. We've helped thousands of businesses reduce their MCA debt by 50-80%." },
    { question: "Will the daily ACH withdrawals stop?", answer: "Yes. Once we begin negotiating on your behalf, we work to stop the daily or weekly ACH withdrawals from your bank account so your cash flow can recover." },
    { question: "I have multiple stacked MCAs — can you help?", answer: "Absolutely. Stacked MCAs are our specialty. We negotiate with all of your MCA lenders simultaneously to resolve all your advances at once." },
    { question: "How long does MCA debt settlement take?", answer: "Most MCA settlements are completed in 3-6 months, depending on the number of advances and the lenders involved." },
    { question: "Will this affect my credit score?", answer: "MCA debt is typically not reported to credit bureaus, so settlement usually has no impact on your personal credit score." },
    { question: "What if an MCA company is threatening legal action?", answer: "Don't panic. Many MCA companies threaten lawsuits as a collection tactic. We deal with MCA lenders every day and know how to negotiate even in aggressive situations. Contact us immediately so we can help." }
  ],
  phone: "",
  colors: {
    primary: "#3052FF",
    primaryLight: "#4a6aff",
    navy: "#1a2e4a",
    navyDark: "#0f1c2e",
    ctaButton: "#3052FF",
    ctaButtonHover: "#2442d4",
    headlineHighlight: "#3052FF"
  }
};

const defaultContentAuthority = {
  badge: "Business Bankruptcy Alternative 2026",
  headline: "Facing Business Bankruptcy?",
  headlineLine2: "Settle Your Debt for 50-80% Less.",
  subheadline: "With business bankruptcies rising in 2026, thousands of small business owners are choosing debt settlement instead. No court filings. No public record. Keep your business running.",
  bulletPoints: [
    "Avoid small business bankruptcies - no court filings or public record",
    "Settle business debt for 50-80% less than you owe",
    "Keep your business open and your assets protected",
    "Credit recovers in months - not 7-10 years after company bankruptcy"
  ],
  formTitle: "Find Your Path to Debt-Free Business",
  formSubtitle: "Takes 60 seconds. No obligation.",
  formButton: "Get My Free Consultation",
  trustLabel: "As Seen In & Trusted By",
  howItWorksTitle: "The 1-2-3 Path to Freedom",
  howItWorksSubtitle: "Our proven process has helped over 1,500 businesses avoid company bankruptcies",
  steps: [
    { title: "Free Business Debt Analysis", description: "Tell us about your situation. We'll review your business debt and show you how to avoid bankruptcy while reducing what you owe by 50-80%." },
    { title: "We Negotiate With Creditors", description: "Our team contacts your lenders directly - no bankruptcy attorneys or court filings needed. We negotiate to settle for a fraction of what you owe." },
    { title: "Debt Settled, Bankruptcy Avoided", description: "Pay significantly less than your total debt. No business bankruptcy on your record. Your company keeps operating and growing." }
  ],
  eduTitle: "Understanding Business Bankruptcies in 2026",
  eduSubtitle: "What every small business owner needs to know before considering bankruptcy options",
  eduStats: [
    { number: "44%", label: "Increase in business bankruptcies since 2023" },
    { number: "$50K+", label: "Average cost of filing business bankruptcy" },
    { number: "7-10yr", label: "Bankruptcy stays on your record" }
  ],
  eduSections: [
    {
      title: "Why Are Business Bankruptcies Rising?",
      content: "Business bankruptcies in 2026 are at their highest level in over a decade. High interest rates, tightening credit markets, and lingering effects of pandemic-era debt have pushed thousands of small businesses toward insolvency. Many business owners are searching for bankruptcy options for small business - but filing isn't always the best path forward."
    },
    {
      title: "Types of Company Bankruptcies",
      content: "Chapter 7 (Liquidation): The business ceases operations. Assets are sold to pay creditors. This is the most common form of small business bankruptcies, but it means closing your doors permanently.\n\nChapter 11 (Reorganization): The business continues operating under a court-approved repayment plan. Expensive (legal fees often exceed $50,000) and time-consuming (12-18 months minimum).\n\nChapter 13 (Individual): Available only to sole proprietors. Creates a 3-5 year repayment plan. Not available for LLCs or corporations."
    },
    {
      title: "The Alternative: Business Debt Settlement",
      content: "For business owners wondering how to resolve business debt without destroying their future, debt settlement offers a private, faster, and less damaging alternative. Instead of court filings and public records, we negotiate directly with your creditors to reduce what you owe - typically by 50-80%."
    }
  ],
  calcTitle: "Realize Your Savings",
  calcSubtitle: "See how much you could save through debt settlement vs. filing for business bankruptcy",
  calcMinDebt: 10000,
  calcMaxDebt: 500000,
  calcDefaultDebt: 150000,
  calcSavingsPercent: 70,
  calcCta: "Get Your Free Analysis",
  comparisonTitle: "Bankruptcy vs. Debt Settlement",
  comparisonSubtitle: "See why thousands chose settlement over small business bankruptcies",
  comparisonBad: {
    title: "Filing Business Bankruptcy",
    badge: "Not Recommended",
    items: [
      "Public record - searchable forever",
      "Credit damaged for 7-10 years",
      "Often forces business closure",
      "Court may seize business assets",
      "6-18 months in court",
      "Attorney fees $10K-$50K+",
      "Nearly impossible to get future loans"
    ]
  },
  comparisonGood: {
    title: "Business Debt Settlement",
    badge: "Better Option",
    items: [
      "Private negotiation - no public record",
      "Credit recovers in 12-24 months",
      "Keep your business open and operating",
      "Your assets stay protected",
      "Settled in 3-6 months",
      "No upfront fees - save 50-80%",
      "Access to financing within months"
    ]
  },
  caseStudiesTitle: "Real Businesses That Avoided Bankruptcy",
  caseStudiesSubtitle: "Actual settlements for business owners who explored bankruptcy options for small business",
  caseStudies: [
    {
      industry: "Home Interiors",
      story: "Facing a $107K judgment from Mulligan Funding, this interior design business was days away from filing. We negotiated a settlement that saved their company.",
      originalAmount: "$107,684",
      settledAmount: "$55,000",
      savingsPercent: "49%",
      savingsNote: "$52,684 saved",
      proofLink: "https://join.coastaldebt.com/wp-content/uploads/2026/02/Mulligan.pdf"
    },
    {
      industry: "Pumping Services",
      story: "Sued by DLP Funding over an MCA default. We stepped in and settled the lawsuit for a fraction of what was owed.",
      originalAmount: "$12,792",
      settledAmount: "$5,000",
      savingsPercent: "61%",
      savingsNote: "Lawsuit dismissed",
      proofLink: "https://join.coastaldebt.com/wp-content/uploads/2026/02/DLP.pdf"
    },
    {
      industry: "Education",
      story: "RTQ Academy was drowning in MCA debt from Byzfunder. We negotiated a settlement that let them keep serving their community.",
      originalAmount: "$40,570",
      settledAmount: "$18,000",
      savingsPercent: "56%",
      savingsNote: "$22,570 saved",
      proofLink: "https://join.coastaldebt.com/wp-content/uploads/2026/02/Bzfunder.pdf"
    },
    {
      industry: "Construction",
      story: "B Squared Carpentry faced $169K in MCA debt. Our team negotiated aggressively and kept them in business.",
      originalAmount: "$169,006",
      settledAmount: "$117,955",
      savingsPercent: "30%",
      savingsNote: "$51,051 saved",
      proofLink: "https://join.coastaldebt.com/wp-content/uploads/2026/02/AMA-B-Squared-Carpentry-LLC-dba-B-Squared-Carpentry.pdf"
    }
  ],
  personCtaTitle: "Your",
  personCtaTitleHighlight: "Financial Future Starts Today",
  personCtaText: "When creditors are calling every day and you're searching for bankruptcy options, it feels like there's no way out. But even with business bankruptcies rising, filing is not your only option. Let us fight for you.",
  personCtaButton: "Get Your Free Consultation",
  personCtaImage: "/assets/person-cta.webp",
  testimonialsTitle: "Business Owners Who Chose Settlement Over Bankruptcy",
  testimonialsSubtitle: "Real stories from business owners who avoided company bankruptcies",
  testimonials: [
    {
      quote: "They were helpful, clear communication, effective results. I couldn't have asked for a better team to help my trucking company through this difficult time.",
      name: "KMJ Trucking, LLC",
      role: "Trucking Company",
      initials: "KT"
    },
    {
      quote: "Their team was very responsive. As an auto repair shop owner, I was overwhelmed with MCA debt. Coastal Debt gave me my life back.",
      name: "AAMCO Auburn",
      role: "Auto Repair Shop",
      initials: "AA"
    },
    {
      quote: "When I thought bankruptcy was my only option, Coastal Debt showed me there was another way. I cannot thank Carlos enough.",
      name: "Edward Sweeney",
      role: "Business Owner",
      initials: "ES"
    }
  ],
  faqTitle: "Business Bankruptcy Questions? We Have Answers.",
  faqSubtitle: "Everything you need to know about avoiding small business bankruptcies",
  faqItems: [
    { question: "What are the best alternatives to business bankruptcy?", answer: "The most effective alternative to business bankruptcy is debt settlement. Instead of filing for company bankruptcy and going through the courts, a debt settlement firm negotiates directly with your creditors to reduce what you owe by 50-80%. You avoid the public record, keep your business running, and resolve your debt faster than filing for small business bankruptcies." },
    { question: "How do small business bankruptcies affect my credit?", answer: "Small business bankruptcies severely damage your personal credit for 7-10 years, especially if you personally guaranteed business loans. They also create a permanent public record and make future financing extremely difficult. Debt settlement avoids all of this - your credit can recover in 12-24 months and there's no public filing." },
    { question: "What are the bankruptcy options for small business owners in 2026?", answer: "Small business owners typically face Chapter 7 (liquidation) or Chapter 11 (reorganization). Both are expensive, time-consuming, and damaging. With business bankruptcies in 2026 rising, more owners are choosing debt settlement as a faster, more private alternative." },
    { question: "Is debt settlement really better than filing for business bankruptcy?", answer: "For most business owners, yes. Business bankruptcy stays on your record for 7-10 years, can force closure, and makes future financing nearly impossible. Debt settlement is private, faster (3-6 months vs. 6-18 months), and lets you keep operating." },
    { question: "How to handle business debt without bankruptcy?", answer: "If you're looking into how to resolve business debt, consider all options first. Chapter 7 liquidates and closes your business. Chapter 11 reorganizes debt but costs $50K+. Debt settlement is often the smarter path - resolve your debt for 50-80% less, keep your doors open, and protect your personal credit." },
    { question: "Can debt consolidation help me avoid business bankruptcy?", answer: "Consolidation combines debts into one payment but doesn't reduce what you owe. If your business debt is too high to manage even with consolidation, debt settlement is stronger - it actually reduces your total debt by 50-80%, making it the most effective bankruptcy alternative." },
    { question: "What business relief programs are available to avoid bankruptcy?", answer: "Business relief programs include SBA assistance, state-level aid, and private debt settlement programs like ours. Our program helps business owners settle debt for 50-80% less, avoiding company bankruptcies while keeping operations running." },
    { question: "How long does debt settlement take compared to business bankruptcy?", answer: "Most business debt settlements complete in 3-6 months. Small business bankruptcies take 6-18 months or longer due to court proceedings, creditor meetings, and legal filings. Settlement is faster and gets you back on track sooner." }
  ],
  ctaTitle: "Don't Let Bankruptcy Be Your Only Option",
  ctaSubtitle: "Free consultation. See how much you could save without filing for bankruptcy.",
  guideTitle: "The Complete Guide to Business Bankruptcies in 2026",
  guideSubtitle: "Everything small business owners need to know about business bankruptcy - and how to avoid it",
  guideSections: [
    {
      title: "Chapter 7 vs Chapter 11 vs Chapter 13: Which Business Bankruptcy Type Applies to You?",
      content: "When considering business bankruptcy, understanding the three main types is critical. Each chapter serves a different purpose and has different eligibility requirements depending on your business structure.\n\nChapter 7 (Liquidation) is the most common form of small business bankruptcies. The court appoints a trustee who sells your business assets to pay creditors. Once complete, remaining eligible debts are discharged. The catch: your business ceases to exist.\n\nChapter 11 (Reorganization) lets you keep operating while restructuring debt under a court-approved plan. It's the most complex and expensive form of company bankruptcy, typically costing $50,000-$200,000+ in legal fees.\n\nChapter 13 (Individual Reorganization) is only available to sole proprietors (not LLCs or corporations). It creates a 3-5 year repayment plan based on your income.",
      background: "white"
    },
    {
      title: "The True Cost of Filing for Business Bankruptcy",
      content: "Many business owners underestimate the total cost of filing business bankruptcy. Beyond the obvious attorney fees, there are court costs, administrative expenses, and significant hidden costs.\n\nChapter 7 costs: Filing fee ($338) + attorney fees ($1,500-$5,000 for simple cases, $10,000+ for complex). Total: $2,000-$15,000. But the real cost is losing your entire business.\n\nChapter 11 costs: Filing fee ($1,738) + attorney fees ($15,000-$200,000+) + quarterly trustee fees + accountant fees. Total: $50,000-$250,000+.\n\nDebt settlement comparison: No upfront fees. No court costs. No public record. Settle your business debt for 50-80% less than you owe, typically resolved in 3-6 months.",
      background: "light"
    },
    {
      title: "How Business Bankruptcy Affects Your Personal Credit",
      content: "If you signed a personal guarantee on any business loan, line of credit, or MCA advance (which most small business owners have), your personal credit is directly tied to that debt. A business bankruptcy involving personally guaranteed debts will appear on your personal credit report.\n\nBankruptcy typically drops your personal credit score by 150-250 points. Chapter 7 stays on your report for 10 years. Chapter 13 stays for 7 years.\n\nWith debt settlement: Your credit may dip temporarily during negotiations (typically 50-100 points), but begins recovering as soon as debts are settled. Most clients see recovery within 12-24 months.",
      background: "white"
    },
    {
      title: "Business Bankruptcy Timeline: What to Expect",
      content: "Chapter 7 Timeline (3-6 months): Filing, automatic stay, 341 meeting of creditors (30-45 days), trustee liquidates assets (30-90 days), discharge. But your business is gone.\n\nChapter 11 Timeline (12-36 months): Filing, automatic stay, disclosure statement (2-4 months), creditor negotiations (3-6 months), plan confirmation (1-3 months), ongoing execution.\n\nChapter 13 Timeline (3-5 years): Filing, automatic stay, plan proposal, confirmation hearing, 3-5 years of monthly payments.\n\nDebt settlement timeline (3-6 months): Free consultation, debt analysis, creditor negotiations, settlements reached, debts resolved. No court dates, no trustees.",
      background: "light"
    },
    {
      title: "Industries Most Affected by Business Bankruptcies in 2026",
      content: "Business bankruptcies in 2026 are not hitting all industries equally. Restaurants and food service have seen filings increase 38% year-over-year due to elevated lease costs and unsustainable MCA payments.\n\nRetail continues facing pressure from e-commerce. Construction companies that took multiple MCAs to bridge cash flow gaps are among the most common seeking bankruptcy alternatives.\n\nTrucking and transportation have been hit by fuel cost volatility, insurance increases, and freight rate declines. Healthcare practices that expanded during 2020-2022 are carrying debt loads that don't match current revenue.",
      background: "white"
    },
    {
      title: "What Happens to Your Employees When You File Business Bankruptcy",
      content: "Chapter 7 (Liquidation): All employees are terminated. The WARN Act requires 60 days notice for 100+ employees. Unpaid wages become priority claims but employees often wait months for partial payment.\n\nChapter 11 (Reorganization): You can keep employees during reorganization, but uncertainty causes key staff to leave. The court may require workforce reductions.\n\nWith debt settlement: Your business keeps operating normally. Employees keep their jobs, benefits, and stability. Your team never needs to know about the debt negotiation process.",
      background: "light"
    },
    {
      title: "Alternatives to Business Bankruptcy Beyond Debt Settlement",
      content: "Debt consolidation combines multiple debts into one payment but does NOT reduce what you owe. Business restructuring means renegotiating terms directly, but creditors have little incentive to negotiate with individuals.\n\nSBA disaster loans offer low interest rates but have limited availability and strict eligibility. Asset-based lending uses equipment or receivables as collateral but adds more debt.\n\nDebt settlement is the only approach that actually reduces your total debt burden (by 50-80%) without court involvement, public record, or business closure.",
      background: "white"
    },
    {
      title: "Glossary of Business Bankruptcy Terms",
      content: "Automatic Stay: A court order that stops creditors from collecting once bankruptcy is filed.\nDischarge: The court order eliminating your legal obligation to pay certain debts.\nLiquidation: Selling business assets to pay creditors (Chapter 7).\nReorganization: Restructuring debts under court supervision (Chapter 11).\nCreditor Committee: Group of largest unsecured creditors in Chapter 11 cases.\nMeans Test: Calculation for Chapter 7 eligibility based on income.\nPreference Payment: Payments to creditors within 90 days before filing that can be clawed back.\nPersonal Guarantee: Your personal promise to repay business debt, exposing personal assets.\n341 Meeting: Mandatory hearing where trustee and creditors question the debtor under oath.\nDebt Settlement: Private negotiation to accept a reduced payment. No court, no public record.",
      background: "light"
    }
  ],
  guideCta: "Talk to a Debt Specialist - Free Consultation",
  guideCtaSubtext: "Still have questions? Our team can walk you through your specific situation.",
  phone: "(888) 730-2056",
  colors: {
    primary: "#3052FF",
    primaryLight: "#7FB2FF",
    heroBg: "#F2F4F9",
    ctaButton: "#3052FF",
    ctaButtonHover: "#2442d4",
    headlineHighlight: "#3052FF",
    navy: "#0f1c2e",
    navyDark: "#0a0f18"
  },
  pageTitle: "Business Bankruptcy Alternative 2026 | Avoid Small Business Bankruptcies",
  metaDescription: "Facing business bankruptcy? Settle your business debt for 50-80% less without filing. No court, no public record. Free consultation. Call (888) 730-2056.",
  mobileCta: "both"
};

const defaultSectionsVisibleAuthority = {
  howItWorks: true, educational: true, calculator: true, comparison: true,
  caseStudies: true, personCta: true, testimonials: true, faq: true, cta: true, guide: true
};

const defaultSectionsVisible = {
  trustBar: true,
  comparison: true,
  howItWorks: true,
  caseStudies: true,
  empathy: true,
  testimonials: true,
  faq: true,
  cta: true
};

// Get all landing pages
router.get('/', authenticateToken, (req, res) => {
  const { from, to } = req.query;

  // Build lead count query with optional date filter
  let leadQuery, leadParams;
  if (from || to) {
    const conditions = [];
    const params = [];
    if (from) { conditions.push('l.created_at >= ?'); params.push(from); }
    if (to) { conditions.push('l.created_at <= ?'); params.push(to); }
    leadQuery = `
      SELECT lp.*, COUNT(CASE WHEN ${conditions.join(' AND ')} THEN l.id END) as lead_count
      FROM landing_pages lp
      LEFT JOIN leads l ON lp.id = l.landing_page_id
      GROUP BY lp.id
      ORDER BY lp.created_at DESC
    `;
    leadParams = params;
  } else {
    leadQuery = `
      SELECT lp.*, COUNT(l.id) as lead_count
      FROM landing_pages lp
      LEFT JOIN leads l ON lp.id = l.landing_page_id
      GROUP BY lp.id
      ORDER BY lp.created_at DESC
    `;
    leadParams = [];
  }

  const pages = db.prepare(leadQuery).all(...leadParams);

  // Count visitors per page with optional date filter
  let visitorCountStmt;
  if (from || to) {
    const conditions = ['landing_page LIKE ?'];
    if (from) conditions.push('first_visit >= ?');
    if (to) conditions.push('first_visit <= ?');
    visitorCountStmt = db.prepare(`SELECT COUNT(*) as c FROM visitors WHERE ${conditions.join(' AND ')}`);
  } else {
    visitorCountStmt = db.prepare('SELECT COUNT(*) as c FROM visitors WHERE landing_page LIKE ?');
  }

  pages.forEach(page => {
    try {
      page.content = JSON.parse(page.content || '{}');
      page.sections_visible = JSON.parse(page.sections_visible || '{}');
      page.hidden_fields = JSON.parse(page.hidden_fields || '{}');
    } catch (e) {}
    try {
      const args = ['%' + page.slug + '%'];
      if (from) args.push(from);
      if (to) args.push(to);
      const vc = visitorCountStmt.get(...args);
      page.visitor_count = vc ? vc.c : 0;
      page.conversion_rate = page.visitor_count > 0
        ? Math.round((page.lead_count / page.visitor_count) * 1000) / 10
        : 0;
    } catch (e) {
      page.visitor_count = 0;
      page.conversion_rate = 0;
    }
  });

  res.json(pages);
});

// Get stats for a single landing page (visitors + leads detail)
router.get('/:id/stats', authenticateToken, (req, res) => {
  const page = db.prepare('SELECT * FROM landing_pages WHERE id = ?').get(req.params.id);
  if (!page) return res.status(404).json({ error: 'Page not found' });

  // Leads for this page
  const leads = db.prepare(`
    SELECT id, first_name, last_name, email, phone, company_name, debt_amount,
           has_mca, ab_variant, gclid, fbclid, msclkid, rt_clickid, created_at,
           cost_cents, cost_currency
    FROM leads
    WHERE landing_page_id = ?
    ORDER BY created_at DESC
  `).all(req.params.id);

  // Visitors for this page
  const visitors = db.prepare(`
    SELECT id, eli_clickid, ip_address, city, region, country, device_type,
           browser, referrer_url, utm_source, utm_medium, utm_campaign,
           ab_variant, converted, visit_count, first_visit, last_visit
    FROM visitors
    WHERE landing_page LIKE ?
    ORDER BY first_visit DESC
    LIMIT 500
  `).all('%' + page.slug + '%');

  // Aggregate stats
  const totalVisitors = db.prepare('SELECT COUNT(*) as c FROM visitors WHERE landing_page LIKE ?').get('%' + page.slug + '%').c;
  const totalLeads = leads.length;
  const conversionRate = totalVisitors > 0 ? Math.round((totalLeads / totalVisitors) * 1000) / 10 : 0;

  // By UTM source
  const bySource = db.prepare(`
    SELECT utm_source, COUNT(*) as visitors, SUM(converted) as leads
    FROM visitors
    WHERE landing_page LIKE ? AND utm_source IS NOT NULL
    GROUP BY utm_source
    ORDER BY visitors DESC
  `).all('%' + page.slug + '%');

  // By day (last 30 days)
  const byDay = db.prepare(`
    SELECT DATE(first_visit) as day, COUNT(*) as visitors, SUM(converted) as leads
    FROM visitors
    WHERE landing_page LIKE ? AND first_visit >= datetime('now', '-30 days')
    GROUP BY day
    ORDER BY day DESC
  `).all('%' + page.slug + '%');

  res.json({
    page: { id: page.id, name: page.name, slug: page.slug, platform: page.platform },
    stats: {
      total_visitors: totalVisitors,
      total_leads: totalLeads,
      conversion_rate: conversionRate,
      ab_split: {
        A: { visitors: visitors.filter(v => v.ab_variant === 'A').length, leads: leads.filter(l => l.ab_variant === 'A').length },
        B: { visitors: visitors.filter(v => v.ab_variant === 'B').length, leads: leads.filter(l => l.ab_variant === 'B').length }
      }
    },
    leads,
    visitors,
    by_source: bySource,
    by_day: byDay
  });
});

// Get single landing page
router.get('/:id', authenticateToken, (req, res) => {
  const page = db.prepare('SELECT * FROM landing_pages WHERE id = ?').get(req.params.id);

  if (!page) {
    return res.status(404).json({ error: 'Page not found' });
  }

  try {
    const saved = JSON.parse(page.content || '{}');
    // Merge with defaults so editor fields show actual values
    const defaults = (page.template_type === 'authority') ? defaultContentAuthority : defaultContent;
    page.content = { ...defaults, ...saved, colors: { ...defaults.colors, ...(saved.colors || {}) } };
    page.sections_visible = JSON.parse(page.sections_visible || '{}');
    page.hidden_fields = JSON.parse(page.hidden_fields || '{}');
  } catch (e) {}

  res.json(page);
});

// Create landing page
router.post('/', authenticateToken, (req, res) => {
  const { name, slug, platform, traffic_source, form_id, template_type } = req.body;

  if (!name || !slug) {
    return res.status(400).json({ error: 'Name and slug required' });
  }

  // Check slug is URL-safe
  const safeSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const validTypes = ['call', 'game', 'article', 'authority', 'join', 'leadgen', 'mca-variant'];
  const validTemplateType = validTypes.includes(template_type) ? template_type : 'form';

  try {
    const result = db.prepare(`
      INSERT INTO landing_pages (name, slug, platform, traffic_source, form_id, content, sections_visible, hidden_fields, template_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name,
      safeSlug,
      platform || 'other',
      traffic_source || '',
      form_id || null,
      JSON.stringify(validTemplateType === 'authority' ? defaultContentAuthority : defaultContent),
      JSON.stringify(validTemplateType === 'authority' ? defaultSectionsVisibleAuthority : defaultSectionsVisible),
      JSON.stringify({}),
      validTemplateType
    );

    // Generate the landing page HTML
    generateLandingPage(result.lastInsertRowid);

    if (logActivity) logActivity(req.user.id, req.user.name || req.user.email, 'created', 'page', result.lastInsertRowid, `Created page: ${name}`, req.ip);
    res.json({ id: result.lastInsertRowid, slug: safeSlug, message: 'Page created' });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(400).json({ error: 'Slug already exists' });
    }
    res.status(500).json({ error: 'Failed to create page' });
  }
});

// Duplicate landing page
router.post('/:id/duplicate', authenticateToken, (req, res) => {
  const page = db.prepare('SELECT * FROM landing_pages WHERE id = ?').get(req.params.id);
  if (!page) {
    return res.status(404).json({ error: 'Page not found' });
  }

  try {
    // Find a unique slug
    let newSlug = page.slug + '-copy';
    let counter = 1;
    while (db.prepare('SELECT id FROM landing_pages WHERE slug = ?').get(newSlug)) {
      newSlug = page.slug + '-copy-' + counter;
      counter++;
    }

    const result = db.prepare(`
      INSERT INTO landing_pages (name, slug, platform, traffic_source, form_id, webhook_url, content, sections_visible, hidden_fields, template_type, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      page.name + ' (Copy)',
      newSlug,
      page.platform,
      page.traffic_source,
      page.form_id,
      page.webhook_url,
      page.content,
      page.sections_visible,
      page.hidden_fields,
      page.template_type,
      page.is_active
    );

    generateLandingPage(result.lastInsertRowid);

    if (logActivity) logActivity(req.user.id, req.user.name || req.user.email, 'duplicated', 'page', result.lastInsertRowid, `Duplicated page: ${page.name} → ${newSlug}`, req.ip);
    res.json({ id: result.lastInsertRowid, slug: newSlug, message: 'Page duplicated' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to duplicate page' });
  }
});

// Update landing page
router.put('/:id', authenticateToken, (req, res) => {
  const { name, slug, platform, traffic_source, webhook_url, form_id, content, sections_visible, hidden_fields, is_active, template_type } = req.body;

  const page = db.prepare('SELECT * FROM landing_pages WHERE id = ?').get(req.params.id);
  if (!page) {
    return res.status(404).json({ error: 'Page not found' });
  }

  const safeSlug = slug ? slug.toLowerCase().replace(/[^a-z0-9-]/g, '-') : page.slug;
  const validTypes = ['call', 'game', 'article', 'form', 'authority', 'join', 'leadgen', 'mca-variant'];
  const validTemplateType = validTypes.includes(template_type) ? template_type : page.template_type;

  db.prepare(`
    UPDATE landing_pages SET
      name = ?, slug = ?, platform = ?, traffic_source = ?, webhook_url = ?, form_id = ?,
      content = ?, sections_visible = ?, hidden_fields = ?, is_active = ?, template_type = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    name || page.name,
    safeSlug,
    platform || page.platform,
    traffic_source !== undefined ? traffic_source : page.traffic_source,
    webhook_url !== undefined ? webhook_url : page.webhook_url,
    form_id !== undefined ? form_id : page.form_id,
    content ? JSON.stringify(content) : page.content,
    sections_visible ? JSON.stringify(sections_visible) : page.sections_visible,
    hidden_fields ? JSON.stringify(hidden_fields) : page.hidden_fields,
    is_active !== undefined ? (is_active ? 1 : 0) : page.is_active,
    validTemplateType,
    req.params.id
  );

  // Regenerate the landing page HTML
  generateLandingPage(req.params.id);

  if (logActivity) logActivity(req.user.id, req.user.name || req.user.email, 'updated', 'page', parseInt(req.params.id), `Updated page: ${name || page.name}`, req.ip);
  res.json({ message: 'Page updated' });
});

// Update landing page content only
router.put('/:id/content', authenticateToken, (req, res) => {
  const { content } = req.body;

  const page = db.prepare('SELECT * FROM landing_pages WHERE id = ?').get(req.params.id);
  if (!page) {
    return res.status(404).json({ error: 'Page not found' });
  }

  db.prepare(`
    UPDATE landing_pages SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(JSON.stringify(content), req.params.id);

  // Regenerate the landing page HTML
  generateLandingPage(req.params.id);

  res.json({ message: 'Content updated' });
});

// Delete landing page
router.delete('/:id', authenticateToken, (req, res) => {
  const page = db.prepare('SELECT slug FROM landing_pages WHERE id = ?').get(req.params.id);

  if (page) {
    // Delete the generated HTML file
    const filePath = path.join(__dirname, '..', '..', 'public', page.slug);
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { recursive: true });
    }
  }

  db.prepare('DELETE FROM leads WHERE landing_page_id = ?').run(req.params.id);
  db.prepare('DELETE FROM landing_pages WHERE id = ?').run(req.params.id);

  if (logActivity) logActivity(req.user.id, req.user.name || req.user.email, 'deleted', 'page', parseInt(req.params.id), `Deleted page: ${page?.slug || req.params.id}`, req.ip);
  res.json({ message: 'Page deleted' });
});

// Save A/B test config (inline same-URL split testing)
router.put('/:id/ab-config', authenticateToken, (req, res) => {
  const page = db.prepare('SELECT * FROM landing_pages WHERE id = ?').get(req.params.id);
  if (!page) return res.status(404).json({ error: 'Page not found' });

  const { ab_config } = req.body;
  if (!ab_config || typeof ab_config !== 'object') {
    return res.status(400).json({ error: 'ab_config object required' });
  }

  db.prepare('UPDATE landing_pages SET ab_config = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(JSON.stringify(ab_config), req.params.id);

  // Regenerate page with new AB config
  generateLandingPage(req.params.id);

  if (logActivity) logActivity(req.user.id, req.user.name || req.user.email, 'updated', 'ab_test', parseInt(req.params.id), `${ab_config.enabled ? 'Enabled' : 'Disabled'} A/B test on page: ${page.name}`, req.ip);
  res.json({ message: 'A/B config saved' });
});

// Debug A/B test - check config and file status
router.get('/:id/ab-debug', authenticateToken, (req, res) => {
  const page = db.prepare('SELECT id, slug, ab_config FROM landing_pages WHERE id = ?').get(req.params.id);
  if (!page) return res.status(404).json({ error: 'Page not found' });

  const abCfg = JSON.parse(page.ab_config || '{}');
  const variantBPath = path.join(__dirname, '..', '..', 'public', page.slug, 'variant-b.html');
  const indexPath = path.join(__dirname, '..', '..', 'public', page.slug, 'index.html');

  res.json({
    page_id: page.id,
    slug: page.slug,
    ab_config: abCfg,
    files: {
      'index.html': fs.existsSync(indexPath),
      'variant-b.html': fs.existsSync(variantBPath)
    }
  });
});

// Get A/B test stats (per-variant visitors, leads)
router.get('/:id/ab-stats', authenticateToken, (req, res) => {
  const page = db.prepare('SELECT id, slug, ab_config FROM landing_pages WHERE id = ?').get(req.params.id);
  if (!page) return res.status(404).json({ error: 'Page not found' });

  const pageId = page.id;

  const abCfg = JSON.parse(page.ab_config || '{}');
  const variantBPageId = abCfg.variantB_page || null;

  // Count visitors & leads for both variants
  // Variant A includes visitors with empty/null ab_variant (pre-A/B or untagged)
  const visitorA = db.prepare("SELECT COUNT(*) as c FROM visitors WHERE landing_page LIKE ? AND (ab_variant = 'A' OR ab_variant = '' OR ab_variant IS NULL)").get(`%${page.slug}%`)?.c || 0;
  let visitorB = db.prepare("SELECT COUNT(*) as c FROM visitors WHERE landing_page LIKE ? AND ab_variant = 'B'").get(`%${page.slug}%`)?.c || 0;
  if (variantBPageId) {
    const bPage = db.prepare('SELECT slug FROM landing_pages WHERE id = ?').get(variantBPageId);
    if (bPage) {
      visitorB += db.prepare("SELECT COUNT(*) as c FROM visitors WHERE landing_page LIKE ?").get(`%${bPage.slug}%`)?.c || 0;
    }
  }

  // Leads: variant A from this page, variant B from this page OR the variant B page
  const leadA = db.prepare("SELECT COUNT(*) as c FROM leads WHERE landing_page_id = ? AND (ab_variant = 'A' OR ab_variant = '' OR ab_variant IS NULL)").get(pageId)?.c || 0;
  let leadB = db.prepare("SELECT COUNT(*) as c FROM leads WHERE landing_page_id = ? AND ab_variant = 'B'").get(pageId)?.c || 0;
  if (variantBPageId) {
    leadB += db.prepare("SELECT COUNT(*) as c FROM leads WHERE landing_page_id = ?").get(variantBPageId)?.c || 0;
  }

  // Get actual lead records for both variants
  const leadsA = db.prepare("SELECT id, first_name, last_name, email, phone, created_at FROM leads WHERE landing_page_id = ? AND (ab_variant = 'A' OR ab_variant = '' OR ab_variant IS NULL) ORDER BY created_at DESC LIMIT 20").all(pageId);
  let leadsB = db.prepare("SELECT id, first_name, last_name, email, phone, created_at, ab_variant FROM leads WHERE landing_page_id = ? AND ab_variant = 'B' ORDER BY created_at DESC LIMIT 20").all(pageId);
  if (variantBPageId) {
    const bPageLeads = db.prepare("SELECT id, first_name, last_name, email, phone, created_at FROM leads WHERE landing_page_id = ? ORDER BY created_at DESC LIMIT 20").all(variantBPageId);
    leadsB = [...leadsB, ...bPageLeads].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 20);
  }

  res.json({
    visitors: { A: visitorA, B: visitorB },
    leads: { A: leadA, B: leadB },
    leadRecords: { A: leadsA, B: leadsB }
  });
});

// Generate landing page HTML
function generateLandingPage(pageId) {
  const page = db.prepare('SELECT * FROM landing_pages WHERE id = ?').get(pageId);
  if (!page) return;

  const content = JSON.parse(page.content || '{}');
  const sectionsVisible = JSON.parse(page.sections_visible || '{}');
  const hiddenFields = JSON.parse(page.hidden_fields || '{}');

  // Get form if assigned
  let form = null;
  if (page.form_id) {
    form = db.prepare('SELECT * FROM forms WHERE id = ?').get(page.form_id);
    if (form) {
      form.fields = JSON.parse(form.fields || '[]');
    }
  }

  // Get all active scripts
  const allActiveScripts = db.prepare(`SELECT * FROM scripts WHERE is_active = 1`).all();

  // Filter scripts for this page (global or specifically assigned)
  const pageScripts = allActiveScripts.filter(s => {
    const pageIds = JSON.parse(s.landing_page_ids || '[]');
    return pageIds.length === 0 || pageIds.includes(pageId);
  });

  const headScripts = pageScripts.filter(s => s.position === 'head').map(s => s.code).join('\n');
  const bodyScripts = pageScripts.filter(s => s.position === 'body_start' || s.position === 'body_end').map(s => s.code).join('\n');
  const bodyStartScripts = pageScripts.filter(s => s.position === 'body_start').map(s => s.code).join('\n');
  const bodyEndScripts = pageScripts.filter(s => s.position === 'body_end').map(s => s.code).join('\n');

  // Generate hidden fields HTML (skip names already hardcoded in the template)
  const HARDCODED_HIDDEN = new Set([
    'gclid','msclkid','fbclid','rt_clickid','eli_clickid','keyword',
    'fb_campaign_id','fb_adset_id','fb_ad_id','fb_campaign_name',
    'fb_adset_name','fb_ad_name','fb_placement','visitor_ip',
    'page_url','referrer_url','landing_page_slug','debt_amount','has_mca'
  ]);
  const hiddenFieldsHtml = Object.entries(hiddenFields)
    .filter(([key]) => !HARDCODED_HIDDEN.has(key))
    .map(([key, value]) => `<input type="hidden" name="${key}" value="${value}">`)
    .join('\n            ');

  // Read the template and generate
  const templateFiles = { call: 'landing-page-call.html', game: 'landing-page-game.html', article: 'landing-page-article.html', authority: 'landing-page-authority.html', join: 'landing-page-join.html', leadgen: 'landing-page-leadgen.html', 'mca-variant': 'landing-page-mca-variant.html' };
  const templateFile = templateFiles[page.template_type] || 'landing-page.html';
  const templatePath = path.join(__dirname, '..', '..', 'templates', templateFile);

  if (!fs.existsSync(templatePath)) {
    console.log('Template not found, skipping generation');
    return;
  }

  let html = fs.readFileSync(templatePath, 'utf8');

  // Get Facebook Pixel ID from config
  let fbPixelId = '';
  try {
    const fbConfig = db.prepare('SELECT pixel_id FROM facebook_config WHERE id = 1').get();
    fbPixelId = fbConfig?.pixel_id || '';
  } catch (e) {}

  // Replace placeholders
  html = html.replace(/{{SLUG}}/g, page.slug);
  html = html.replace(/{{HEAD_SCRIPTS}}/g, headScripts);
  html = html.replace(/{{BODY_SCRIPTS}}/g, bodyScripts);
  html = html.replace(/{{HIDDEN_FIELDS}}/g, hiddenFieldsHtml);
  html = html.replace(/{{FB_PIXEL_ID}}/g, fbPixelId);

  // Authority template uses camelCase placeholders
  html = html.replace(/{{headScripts}}/g, headScripts);
  html = html.replace(/{{bodyStartScripts}}/g, bodyStartScripts);
  html = html.replace(/{{bodyEndScripts}}/g, bodyEndScripts);
  html = html.replace(/{{hiddenFieldsHtml}}/g, hiddenFieldsHtml);

  // Merge content with defaults so all template placeholders get replaced
  // If a field is explicitly set (even to empty string), respect it
  const defaults = (page.template_type === 'authority') ? defaultContentAuthority : defaultContent;
  const mergedContent = { ...defaults };
  Object.entries(content).forEach(([key, value]) => {
    if (value !== null && value !== undefined) {
      mergedContent[key] = value;
    }
  });

  // Deep merge colors so partial overrides don't lose defaults
  mergedContent.colors = { ...defaults.colors, ...(content.colors || {}) };

  // Replace content placeholders
  Object.entries(mergedContent).forEach(([key, value]) => {
    if (typeof value === 'string') {
      html = html.replace(new RegExp(`{{${key}}}`, 'g'), value);
    }
  });

  // Extra computed placeholders for join template
  const phoneDigits = (mergedContent.phone || '').replace(/[^0-9+]/g, '');
  html = html.replace(/{{phoneDigits}}/g, phoneDigits);
  html = html.replace(/{{year}}/g, new Date().getFullYear());

  // Handle colors
  if (mergedContent.colors) {
    Object.entries(mergedContent.colors).forEach(([key, value]) => {
      html = html.replace(new RegExp(`{{colors.${key}}}`, 'g'), value);
    });
  }

  // Helper: escape JSON for safe embedding in JS single-quoted strings
  // Must double-escape backslashes so \n stays as \n after JS parsing, then JSON.parse handles it
  const jsJson = (obj) => JSON.stringify(obj).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/<\//g, '<\\/');

  // Handle JSON arrays for JavaScript
  html = html.replace(/{{bulletPointsJson}}/g, jsJson(mergedContent.bulletPoints || []));
  html = html.replace(/{{mobileBulletsCount}}/g, mergedContent.mobileBulletsCount || 'all');
  html = html.replace(/{{formMode}}/g, mergedContent.formMode || 'normal');
  html = html.replace(/{{stepsJson}}/g, jsJson(mergedContent.steps || []));
  html = html.replace(/{{empathyTextJson}}/g, jsJson(mergedContent.empathyText || []));
  html = html.replace(/{{comparisonRowsJson}}/g, jsJson(mergedContent.comparisonRows || []));
  html = html.replace(/{{faqItemsJson}}/g, jsJson(mergedContent.faqItems || []));

    // Authority template JSON fields
    html = html.replace(/{{eduStatsJson}}/g, jsJson(mergedContent.eduStats || []));
    html = html.replace(/{{eduSectionsJson}}/g, jsJson(mergedContent.eduSections || []));
    html = html.replace(/{{caseStudiesJson}}/g, jsJson(mergedContent.caseStudies || []));
    html = html.replace(/{{testimonialsJson}}/g, jsJson(mergedContent.testimonials || []));
    html = html.replace(/{{comparisonBadJson}}/g, jsJson(mergedContent.comparisonBad || {}));
    html = html.replace(/{{comparisonGoodJson}}/g, jsJson(mergedContent.comparisonGood || {}));
    html = html.replace(/{{guideSectionsJson}}/g, jsJson(mergedContent.guideSections || []));

    // Authority template numeric fields (generic string replacement skips non-string values)
    html = html.replace(/{{calcMinDebt}}/g, String(mergedContent.calcMinDebt || 10000));
    html = html.replace(/{{calcMaxDebt}}/g, String(mergedContent.calcMaxDebt || 500000));
    html = html.replace(/{{calcDefaultDebt}}/g, String(mergedContent.calcDefaultDebt || 150000));
    html = html.replace(/{{calcSavingsPercent}}/g, String(mergedContent.calcSavingsPercent || 70));

  // Handle form data
  const isAuthority = page.template === 'authority';
  const formFields = form ? form.fields : (isAuthority ? authorityFormFields : defaultFormFields);
  const formWebhook = page.webhook_url || (form ? form.webhook_url : '');
  const formSubmitText = form ? form.submit_button_text : content.formButton || 'Get My Free Debt Analysis';
  const formSuccessMsg = form ? form.success_message : 'Thank you! A debt specialist will call you within 15 minutes.';

  const skipPreQual = form ? (form.skip_pre_qual ? true : false) : false;

  html = html.replace(/{{formFieldsJson}}/g, jsJson(formFields));
  html = html.replace(/{{formWebhook}}/g, formWebhook);
  html = html.replace(/{{formSubmitText}}/g, formSubmitText);
  html = html.replace(/{{formSuccessMsg}}/g, formSuccessMsg);
  html = html.replace(/{{skipPreQual}}/g, String(skipPreQual));
  html = html.replace(/{{mobileCta}}/g, content.mobileCta || 'call');

  // Remove phone elements if no phone number is set
  if (!mergedContent.phone) {
    // Remove all elements with phone-element class (handles multi-line blocks)
    html = html.replace(/<a[^>]*phone-element[\s\S]*?<\/a>/g, '');
    html = html.replace(/<p[^>]*phone-element[\s\S]*?<\/p>/g, '');
    html = html.replace(/<div[^>]*phone-element[\s\S]*?<\/div>/g, '');
  }

    // Strip hidden sections based on sectionsVisible
    if (page.template_type === 'authority') {
      const sectionKeys = ['howItWorks', 'educational', 'calculator', 'comparison', 'caseStudies', 'personCta', 'testimonials', 'faq', 'cta', 'guide'];
      for (const key of sectionKeys) {
        if (sectionsVisible[key] === false) {
          const regex = new RegExp(`<!-- SECTION:${key} -->[\\s\\S]*?<!-- /SECTION:${key} -->`, 'g');
          html = html.replace(regex, '');
        }
      }
    }

  // Inject branding from settings
  try {
    const brandingRows = db.prepare("SELECT key, value FROM settings WHERE key IN ('favicon_url', 'meta_image_url', 'site_name')").all();
    const branding = {};
    brandingRows.forEach(r => { branding[r.key] = r.value; });

    let brandingTags = '';
    if (branding.favicon_url) {
      brandingTags += `\n  <link rel="icon" href="${branding.favicon_url}">`;
    }
    if (branding.meta_image_url) {
      brandingTags += `\n  <meta property="og:image" content="${branding.meta_image_url}">`;
    }
    if (branding.site_name) {
      brandingTags += `\n  <meta property="og:site_name" content="${branding.site_name}">`;
    }
    html = html.replace(/{{siteName}}/g, branding.site_name || 'Coastal Debt Resolve');
    if (brandingTags) {
      html = html.replace('</head>', brandingTags + '\n</head>');
    }
  } catch (err) {
    console.error('Failed to inject branding:', err);
  }

  // Inject inline A/B test script (same-URL split testing)
  const abConfig = JSON.parse(page.ab_config || '{}');
  if (abConfig.enabled && abConfig.variantB) {
    const abJson = JSON.stringify({
      id: page.id,
      split: abConfig.split || 50,
      variantB: abConfig.variantB
    });
    const abScript = `<script>
(function(){
  var cfg=${abJson};
  var ck=document.cookie.match('ab_'+cfg.id+'=([^;]+)');
  var v=ck?ck[1]:(Math.random()*100<cfg.split?'B':'A');
  if(!ck)document.cookie='ab_'+cfg.id+'='+v+';path=/;max-age=2592000';
  window._abVariant=v;
  if(v==='B'){
    var c=cfg.variantB.colors||{};
    if(c.ctaButton)document.documentElement.style.setProperty('--cta-btn',c.ctaButton);
    if(c.ctaButtonHover)document.documentElement.style.setProperty('--cta-btn-hover',c.ctaButtonHover);
    if(c.headlineHighlight)document.documentElement.style.setProperty('--headline-hl',c.headlineHighlight);
    document.addEventListener('DOMContentLoaded',function(){
      var b=cfg.variantB;
      function t(sel,val){if(!val)return;var el=document.querySelector(sel);if(el)el.textContent=val;}
      if(b.headline||b.headlineLine2||b.headlineHighlight){
        var h1=document.querySelector('.hero h1');
        if(h1){
          var hl=b.headline||h1.getAttribute('data-ab-headline')||'';
          var l2=b.headlineLine2||h1.getAttribute('data-ab-line2')||'';
          var hi=b.headlineHighlight||h1.getAttribute('data-ab-highlight')||'';
          h1.innerHTML=hl+'<br>'+l2+' <span>'+hi+'</span>';
        }
      }
      t('.hero-badge',b.badge);
      t('.hero-sub',b.subheadline);
      t('.form-title',b.formTitle);
      t('.form-subtitle',b.formSubtitle);
      t('.submit-btn',b.formButton);
      t('.cta-footer h2',b.ctaTitle);
    });
  }
})();
</script>`;
    html = html.replace('</head>', abScript + '\n</head>');

    // Embed original headline data as attributes for fallback
    html = html.replace(
      /<h1>([^<]*)<br>([^<]*)<span>/,
      (match, headline, line2) => `<h1 data-ab-headline="${headline.trim()}" data-ab-line2="${line2.trim()}" data-ab-highlight="${(mergedContent.headlineHighlight || '').replace(/"/g, '&quot;')}">${headline}<br>${line2}<span>`
    );
  }

  // Create the page directory and save
  const pageDir = path.join(__dirname, '..', '..', 'public', page.slug);
  if (!fs.existsSync(pageDir)) {
    fs.mkdirSync(pageDir, { recursive: true });
  }

  fs.writeFileSync(path.join(pageDir, 'index.html'), html);
  console.log(`Generated landing page: ${page.slug}`);

  // Generate variant B if template-level A/B test is configured
  const abCfg = JSON.parse(page.ab_config || '{}');
  if (abCfg.enabled && abCfg.variantB_template) {
    const variantTemplateFiles = { call: 'landing-page-call.html', game: 'landing-page-game.html', article: 'landing-page-article.html', authority: 'landing-page-authority.html', form: 'landing-page.html', leadgen: 'landing-page-leadgen.html' };
    const variantTemplateFile = variantTemplateFiles[abCfg.variantB_template] || 'landing-page.html';
    const variantTemplatePath = path.join(__dirname, '..', '..', 'templates', variantTemplateFile);

    if (fs.existsSync(variantTemplatePath)) {
      let htmlB = fs.readFileSync(variantTemplatePath, 'utf8');

      // Use variant B content if provided, otherwise same content
      const variantContent = abCfg.variantB_content ? { ...mergedContent, ...abCfg.variantB_content } : mergedContent;
      const variantDefaults = (abCfg.variantB_template === 'authority') ? defaultContentAuthority : defaultContent;
      const mergedVariant = { ...variantDefaults, ...variantContent };
      mergedVariant.colors = { ...variantDefaults.colors, ...(variantContent.colors || {}) };

      // Replace placeholders (same logic as variant A)
      htmlB = htmlB.replace(/{{SLUG}}/g, page.slug);
      htmlB = htmlB.replace(/{{HEAD_SCRIPTS}}/g, headScripts);
      htmlB = htmlB.replace(/{{BODY_SCRIPTS}}/g, bodyScripts);
      htmlB = htmlB.replace(/{{HIDDEN_FIELDS}}/g, hiddenFieldsHtml);
      htmlB = htmlB.replace(/{{FB_PIXEL_ID}}/g, fbPixelId);
      htmlB = htmlB.replace(/{{headScripts}}/g, headScripts);
      htmlB = htmlB.replace(/{{bodyStartScripts}}/g, bodyStartScripts);
      htmlB = htmlB.replace(/{{bodyEndScripts}}/g, bodyEndScripts);
      htmlB = htmlB.replace(/{{hiddenFieldsHtml}}/g, hiddenFieldsHtml);

      // Replace all template placeholders
      for (const [key, value] of Object.entries(mergedVariant)) {
        if (typeof value === 'string') {
          htmlB = htmlB.replace(new RegExp(`{{${key}}}`, 'g'), value);
        }
      }

      // Inject JSON config for JS-driven sections
      const configJson = JSON.stringify(mergedVariant).replace(/<\//g, '<\\/');
      htmlB = htmlB.replace('</body>', `<script>window.__PAGE_CONFIG__=${configJson};</script>\n</body>`);

      fs.writeFileSync(path.join(pageDir, 'variant-b.html'), htmlB);
      console.log(`Generated variant B (${abCfg.variantB_template}) for: ${page.slug}`);
    }
  } else {
    // Clean up variant B file if A/B test disabled
    const variantBPath = path.join(pageDir, 'variant-b.html');
    if (fs.existsSync(variantBPath)) fs.unlinkSync(variantBPath);
  }
}

// Regenerate all landing pages (useful after template changes)
router.post('/regenerate-all', authenticateToken, (req, res) => {
  const pages = db.prepare('SELECT id, slug FROM landing_pages').all();
  let count = 0;
  for (const page of pages) {
    try {
      generateLandingPage(page.id);
      count++;
    } catch (err) {
      console.error(`Failed to regenerate page ${page.slug}:`, err);
    }
  }
  res.json({ message: `Regenerated ${count} landing pages` });
});

// ============ MIGRATION: Remove em-dashes from landing page content ============
(function removeEmDashes() {
  const pages = db.prepare('SELECT id, slug, content FROM landing_pages').all();
  let fixed = 0;
  for (const p of pages) {
    if (p.content && p.content.includes('\u2014')) {
      const cleaned = p.content.replace(/\u2014/g, '-');
      db.prepare('UPDATE landing_pages SET content = ? WHERE id = ?').run(cleaned, p.id);
      generateLandingPage(p.id);
      fixed++;
    }
  }
  if (fixed > 0) console.log(`[Pages] Fixed em-dashes in ${fixed} landing pages and regenerated`);
})();

// Export the generate function
module.exports = router;
module.exports.generateLandingPage = generateLandingPage;
