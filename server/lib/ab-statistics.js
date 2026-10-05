// Beta-binomial comparison with independent Beta(1, 1) priors.
// Exact finite-sum identity: https://www.evanmiller.org/bayesian-ab-testing.html
// The probability is a Bayesian estimate, not a frequentist confidence level.
const POLICY = Object.freeze({ probability: 0.95, visitorsPerVariant: 100, conversions: 20, days: 7 });
const DAY = 86400000;

function logGamma(z) {
  const c = [676.5203681218851, -1259.1392167224028, 771.3234287776531,
    -176.6150291621406, 12.507343278686905, -0.13857109526572012,
    9.984369578019572e-6, 1.5056327351493116e-7];
  z -= 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < c.length; i++) x += c[i] / (z + i + 1);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
const logBeta = (a, b) => logGamma(a) + logGamma(b) - logGamma(a + b);
function logAdd(a, b) {
  if (a === -Infinity) return b;
  const high = Math.max(a, b);
  return high + Math.log1p(Math.exp(Math.min(a, b) - high));
}
function betaGreater(aA, bA, aB, bB) {
  if (aA === aB && bA === bB) return 0.5;
  // Choose the shortest of the four equivalent sums, including complements.
  const choices = [
    [aA, bA, aB, bB, false], [aB, bB, aA, bA, true],
    [bB, aB, bA, aA, false], [bA, aA, bB, aB, true]
  ].sort((a, b) => a[2] - b[2]);
  const [a, b, c, d, complement] = choices[0];
  let term = logBeta(a, b + d) - logBeta(a, b);
  let sum = -Infinity;
  for (let i = 0; i < c; i++) {
    sum = logAdd(sum, term);
    term += Math.log(a + i) + Math.log(d + i) - Math.log(a + b + d + i) - Math.log(i + 1);
  }
  const p = Math.max(0, Math.min(1, Math.exp(sum)));
  return complement ? 1 - p : p;
}

function analyzeRun(run, stats, now = Date.now()) {
  const result = { model:'beta-binomial-v1', scope:'full_run', policy:POLICY, asOf:now,
    status:'unavailable', winner:null, leadingVariant:null, probability:null, lift:null, difference:null, checks:[], stats };
  if (run.source === 'historical') return { ...result, reason:'Historical results contain estimated visitor counts and cannot establish a winner.' };
  const valid = ['A','B'].every(v => stats?.[v] && ['visitors','converted'].every(k => Number.isSafeInteger(stats[v][k]) && stats[v][k] >= 0) && stats[v].converted <= stats[v].visitors);
  if (!valid || !Number.isFinite(run.started_at) || (run.ended_at != null && (!Number.isFinite(run.ended_at) || run.ended_at < run.started_at))) {
    return { ...result, reason:'The test needs valid measured visitor and conversion counts.' };
  }
  const a = stats.A, b = stats.B;
  const days = Math.max(0, (Math.min(now, run.ended_at ?? now) - run.started_at) / DAY);
  result.checks = [
    {key:'visitorsA',label:'Variant A visitors',current:a.visitors,target:POLICY.visitorsPerVariant},
    {key:'visitorsB',label:'Variant B visitors',current:b.visitors,target:POLICY.visitorsPerVariant},
    {key:'conversions',label:'Converted visitors',current:a.converted + b.converted,target:POLICY.conversions},
    {key:'days',label:'Days running',current:days,target:POLICY.days}
  ].map(check => ({...check,met:check.current >= check.target}));
  const split = Number(run.config?.split ?? 50);
  if (!Number.isFinite(split) || split <= 0 || split >= 100) return {...result, reason:'Both variants need an active share of traffic to compare results.'};
  if (!a.visitors || !b.visitors || a.converted + b.converted === 0) {
    return {...result,status:'waiting',reason:'Waiting for visitors in both variants and at least one conversion.'};
  }
  const pB = betaGreater(a.converted + 1, a.visitors - a.converted + 1, b.converted + 1, b.visitors - b.converted + 1);
  result.probability = {A:1-pB,B:pB};
  result.leadingVariant = Math.abs(pB - 0.5) < 1e-10 ? null : pB > 0.5 ? 'B' : 'A';
  const rateA = a.converted / a.visitors, rateB = b.converted / b.visitors;
  result.difference = (rateB - rateA) * 100;
  result.lift = rateA ? (rateB / rateA - 1) * 100 : null;
  if (!result.checks.every(check => check.met)) return {...result,status:'collecting',reason:'Minimum sample and duration requirements must be met before declaring a winner.'};
  if (Math.max(pB, 1-pB) >= POLICY.probability) return {...result,status:'winner',winner:result.leadingVariant,reason:'The win probability and all minimum requirements are met.'};
  return {...result,status:'inconclusive',reason:'Neither variant has reached the 95% win probability threshold.'};
}
module.exports = { analyzeRun, betaGreater, POLICY };
