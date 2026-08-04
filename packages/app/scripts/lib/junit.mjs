export function summarizeJunit(xml) {
  const sum = (attr) => {
    let total = 0
    const re = new RegExp(`<testsuite\\b[^>]*\\b${attr}="(\\d+)"`, 'g')
    for (const m of xml.matchAll(re)) total += Number(m[1])
    return total
  }
  const tests = sum('tests'), failures = sum('failures'), errors = sum('errors'), skipped = sum('skipped')
  return { tests, failures, errors, skipped, ok: failures === 0 && errors === 0 }
}
