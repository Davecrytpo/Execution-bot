type CounterMap = Map<string, number>;

const counters: CounterMap = new Map();

export function incMetric(name: string, amount = 1) {
  counters.set(name, (counters.get(name) ?? 0) + amount);
}

export function getMetric(name: string) {
  return counters.get(name) ?? 0;
}

export function getMetricsSnapshot() {
  return Object.fromEntries(counters.entries());
}
