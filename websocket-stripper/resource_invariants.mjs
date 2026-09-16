// Self-checks for the resource diagnostics.
//
// These numbers exist to be ACTED ON, and one of them lied. On 2026-09-15 the
// "dropped by ALL dashboards" report named 42 of 42 resources on an install where a single
// dashboard kept 21 — it compared raw URLs against normalised paths, so nothing matched once a
// URL carried `?hacstag=`, which every HACS resource does. Two things made that expensive:
//
//   * it is the ONE report you cannot sanity-check by looking at a dashboard, because it covers
//     resources that render nothing and only act on load; and
//   * the remedy it recommends is `resources_always_forward`, so following it would have
//     un-trimmed the entire resource list one bundle at a time.
//
// It was caught by arithmetic, not by a test. So the arithmetic lives here now.
//
// The point of both checks is that they are derived DIFFERENTLY from the values they check —
// a bug in the set-membership path cannot hide in the counting path, and vice versa. A check
// computed the same way as the thing it checks (`kept + dropped === total`, where `dropped` is
// defined as `total - kept`) can never fail and is worth nothing; deliberately not included.

/**
 * @param {object} o
 * @param {number} o.total             how many resources Home Assistant has registered
 * @param {Map<string, number>} o.keptByDash    dashboard -> count of resources it is served
 * @param {string[]} o.droppedByAll    normalised URLs reported as dropped by every dashboard
 * @param {Map<string, Set<string>>} o.droppedByDash  dashboard -> normalised URLs it does NOT get
 * @returns {string[]} human-readable problems; empty when the reports are self-consistent
 */
export function resourceInvariantProblems({ total, keptByDash, droppedByAll, droppedByDash }) {
  const problems = [];

  // 1. COUNTING. A resource dropped by every dashboard cannot be one that some dashboard keeps,
  //    so the size of that set is bounded by what the most-generous dashboard leaves out. This is
  //    the check that caught the real bug: 42 reported, ceiling of 21.
  let maxKept = 0;
  let maxDash = null;
  for (const [dash, kept] of keptByDash) {
    if (kept > maxKept) { maxKept = kept; maxDash = dash; }
  }
  if (keptByDash.size) {
    const ceiling = total - maxKept;
    if (droppedByAll.length > ceiling) {
      problems.push(
        `"dropped by ALL dashboards" lists ${droppedByAll.length} of ${total} resources, but at `
        + `most ${ceiling} can be — ${maxDash} alone is served ${maxKept}`);
    }
  }

  // 2. SET MEMBERSHIP, from the per-dashboard lists rather than from the union used to build the
  //    report. If a resource really is dropped everywhere, every dashboard's own drop list has it.
  let named = 0;
  for (const url of droppedByAll) {
    for (const [dash, dropped] of droppedByDash) {
      if (!dropped.has(url)) {
        if (named < 5) {
          problems.push(`${url} is reported dropped by ALL dashboards, but ${dash} is served it`);
        }
        named++;
        break;
      }
    }
  }
  if (named > 5) problems.push(`…and ${named - 5} more resources reported as dropped but served`);

  return problems;
}
