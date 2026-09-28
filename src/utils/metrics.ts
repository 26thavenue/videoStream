import { jobCounts } from "./jobs";

const counters = {
  served: 0,
  servedBytes: 0,
  sourceServed: 0,
  sourceServedBytes: 0,
  notFound: 0,
  errors: 0,
};

export const metrics = {
  incServed(bytes: number) {
    counters.served++;
    counters.servedBytes += bytes;
  },
  incSourceServed(bytes: number) {
    counters.sourceServed++;
    counters.sourceServedBytes += bytes;
  },
  incNotFound() {
    counters.notFound++;
  },
  incErrors() {
    counters.errors++;
  },
};

export async function renderMetrics(): Promise<string> {
  const lines: string[] = [
    "# TYPE segment_requests_total counter",
    "segment_requests_total " + counters.served,
    "# TYPE segment_bytes_total counter",
    "segment_bytes_total " + counters.servedBytes,
    "# TYPE source_requests_total counter",
    "source_requests_total " + counters.sourceServed,
    "# TYPE source_bytes_total counter",
    "source_bytes_total " + counters.sourceServedBytes,
    "# TYPE playback_404_total counter",
    "playback_404_total " + counters.notFound,
    "# TYPE playback_errors_total counter",
    "playback_errors_total " + counters.errors,
  ];

  try {
    const counts = await jobCounts();
    lines.push("# TYPE jobs_status gauge");
    for (const [status, count] of Object.entries(counts)) {
      lines.push(`jobs_status{status="${status}"} ${count}`);
    }
  } catch {
    lines.push("# note: database unavailable, jobs metrics omitted");
  }

  return lines.join("\n") + "\n";
}