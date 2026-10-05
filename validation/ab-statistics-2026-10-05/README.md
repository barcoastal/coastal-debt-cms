# A/B statistical verdicts

Each measured run receives a Bayesian comparison of its visitor-to-lead conversion rates. Outcomes are binary: one converted visitor is one success, even if that visitor submits multiple leads. Independent Beta(1,1) priors become Beta(converted + 1, visitors − converted + 1) posteriors. The exact finite sum computes P(B > A); complements and failure-count symmetry select the shortest sum. Calculations stay in log space for numerical stability.

Reference and formula derivation: [Evan Miller, Formulas for Bayesian A/B Testing](https://www.evanmiller.org/bayesian-ab-testing.html).

The product decision rule requires all of:

- At least 95% posterior probability that the selected variant has the higher rate.
- At least 100 measured visitors per variant.
- At least 20 converted visitors across both variants.
- At least seven elapsed days, capped at the run's end for ended tests.

These minimums are product safeguards, not a power calculation or a guarantee that enough evidence exists. The model measures any improvement, without a practical-lift threshold. Its probability is conditional on the prior and assumptions of comparable randomized visitors and stable conversion rates. It is not a frequentist error-rate guarantee. Browser changes, delayed conversions, instrumentation issues, and traffic changes remain limitations. The feature does not stop tests or change allocation.

Inference always uses the complete measured run; date filters change displayed cohort metrics only. New configurations create new runs and do not reuse previous-run evidence. Unexposed participants are excluded. Historical reconstructed estimates never receive a winner. Later conversions can update the verdict for an ended run, consistent with existing cohort reporting.

## Verification

```sh
node validation/ab-statistics-2026-10-05/check.cjs
node validation/ab-dashboard-2026-09-29/check.cjs
node validation/ab-dashboard-2026-09-29/history-check.cjs
node validation/ab-statistics-2026-10-05/browser.cjs
```

Set `NODE_PATH` to an existing project dependency directory if using an isolated worktree. `PLAYWRIGHT_MODULE` may point directly to Playwright. The browser checks run with intercepted local files and synthetic API data; no live request or production mutation is made. Screenshots default to `/private/tmp/coastal-ab-statistics-20261005` (`AB_SCREENSHOTS` can override).

Numerical references were independently computed with SciPy 1.13.1, integrating the B posterior PDF against the A posterior CDF over B's 1e−12 to 1−1e−12 quantiles, with absolute quadrature tolerance 1e−10. Checks cover realistic sparse examples, large samples, zero and complete conversion, symmetry, threshold gates, A/B winners, ended/historical runs, exposure and conversion deduplication, date-filter isolation, and new-run reset. Browser checks cover all verdict states, the full-run detail, CSV metadata, mobile overflow, and JavaScript errors.
