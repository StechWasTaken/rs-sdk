# Fly server performance investigation — October 20, 2026

Four small improvements are implemented and tested locally. The largest additional
opportunity during this observation was whole-world checkpoint work during session
churn and Grand Exchange operations. Production has not been patched or restarted.

## Live evidence

Observed `rs-sdk-demo`, release 192, machine `82962dc77ee3e8` in `iad`: two
performance CPUs, 4 GB RAM, Bun 1.4.3. SHA-256 checks confirmed that all five
production source files changed by these patches matched local baseline commit
`b565f2d920bf6f5ec427bc6f66dc6fd64a2e15c1`.

Collected 24 management `/tickstats` snapshots from **7:04:20–7:06:23 a.m.
Eastern**, approximately five seconds apart, plus two five-second main-thread
profiles at 500 μs sampling intervals. The profiler is diagnostic overhead;
these are observations of a changing live workload, not a controlled load test.

| Metric | Observed range |
| --- | --- |
| Online players | 1,747–1,958 |
| Rolling average processing time | 324.1–419.3 ms |
| Rolling average tick interval | 368.2–480.8 ms |
| Processing over the 300 ms budget | 56.7–87.0% of each 300-tick window |
| Largest recorded processing time / interval | 1,147 / 1,452 ms |
| Client-output phase, rolling average | 106.9–130.3 ms |
| Logout phase, rolling average | 24.7–110.6 ms |
| Login phase, rolling average | 5.0–36.6 ms |
| Pending logins | 0–116 |
| Process RSS | 1,733–1,977 MB |

The windows overlap; their percentages must not be summed or treated as independent
ticks. Players declined during the observation, and a login backlog appeared.
The earlier “no persistent backlog” observation therefore does not describe this
entire window.

The first profile attributed **25.2%** of samples to the logout/flush stack.
The second attributed **34.7%** to the principal `checkpointPlayers` frame, with
callers including logouts, session takeovers and GE operations. Player updates
accounted for **13.9%** and **9.3%**, respectively. These are inclusive sampled
stack percentages, not additive phase timings.

The profiles independently confirmed the smaller opportunities:

- `subarray` under the rsbuf packet copier: **2.8% / 1.9%** of leaf samples.
- Receive-buffer shifting `set`: **1.6% / 1.1%**, plus view creation.
- Packet allocation under player serialization: **4.4% / 6.8%** of leaf samples.
- Zone membership scans and lookups remained visible in both profiles.

Raw evidence: [tick snapshots](live-ticks.json), [first profile](profile-1.txt),
[second profile](profile-2.txt).

## Recommended patches

1. [Network buffers](01-network-buffers.patch): reuse the source view when a
   complete cached player/NPC mask is copied. For socket reads, shift only queued
   bytes using overlap-safe `copyWithin`, and skip shifting when the queue is empty.
   Partial packet copies retain their existing behavior.
2. [Zone scans](02-zone-scans.patch): remember when zone membership or the client
   map changes. Stable memberships skip the unload scan. When the global changed
   zone set is smaller than the active set, visit that smaller set directly.
   Busy ticks retain the bounded active-zone scan. First loads, movement,
   plane changes and reconnect rebuilds still take the full path.
3. [Save buffers](03-save-buffers.patch): copy serialized save bytes into an owned,
   exact-size array and release the 30,000-byte packet to the existing pool.
   This removes repeated large allocations and stops each retained small save from
   retaining the entire packet. Save format, checkpoint timing, SQLite transactions
   and the set of saved players remain unchanged.

The save-buffer patch addresses a newly measured checkpoint cost without batching
or weakening recovery boundaries. I recommend all three patches as the first
deployment candidate.

[Combined patch](recommended.patch) also includes the
[reproducible benchmark](04-benchmark.patch). The changes are already present in
this checkout; do not apply them a second time here. The combined patch passed
`git apply --check` against the baseline snapshot and excludes unrelated workspace
changes.

## Local measurements

Compared the real methods in untouched baseline source with the patched source,
using Bun 1.3.14 on macOS arm64. Each case runs twice for warmup and reports the
median of seven timed batches, with explicit GC before each timed batch.
Baseline and candidate ran sequentially. Production uses a different Bun version
and platform, so these ratios are evidence about the operations, not forecasts of
production tick speed.

| Case | Operations per batch | Before | After | Speedup |
| --- | ---: | ---: | ---: | ---: |
| Complete packet copy, 8 bytes | 1,000,000 | 29.18 ms | 12.71 ms | 2.30× |
| Complete packet copy, 64 bytes | 1,000,000 | 30.18 ms | 12.31 ms | 2.45× |
| Complete packet copy, 256 bytes | 1,000,000 | 34.89 ms | 14.71 ms | 2.37× |
| Partial packet copy, 64 bytes | 1,000,000 | 29.41 ms | 29.38 ms | 1.00× |
| Read one byte, one queued | 100,000 | 72.59 ms | 2.77 ms | 26.17× |
| Read one byte, 64 queued | 100,000 | 79.77 ms | 4.46 ms | 17.90× |
| Read one byte, 1,024 queued | 100,000 | 88.56 ms | 4.87 ms | 18.17× |
| Read one byte, full queue | 100,000 | 92.18 ms | 72.77 ms | 1.27× |
| Stable zone update, no global changes | 100,000 | 113.17 ms | 0.55 ms | 207.48× |
| Stable zone update, 20 changed zones | 100,000 | 62.09 ms | 6.41 ms | 9.68× |
| Stable zone update, 100 changed zones | 100,000 | 65.59 ms | 37.38 ms | 1.75× |
| Serialize minimal players, no DB checkpoint | 2,000 | 3.54 ms | 1.63 ms | 2.17× |

The zone benchmark has 49 active zones and no queued event payloads; it isolates
scan overhead. It does not measure busy event encoding. The save benchmark calls
the actual serializer 2,000 times on the same minimal character with changing
coordinates; populated banks and SQLite costs are not included. For those 2,000
retained 246-byte saves, backing storage fell from
**60,000,000 bytes to 492,000 bytes**, excluding the reusable packet pool and object
overhead. Real savings depend on save sizes.

Full samples: [before](bench-before.json), [after](bench-after.json),
[comparison](benchmark-summary.json).

Run the candidate benchmark from the repository root:

```sh
bun server/engine/tools/bench/network-hotpaths.ts
```

For baseline comparison, extract `server/engine/src`, `server/engine/package.json`
and `server/engine/tsconfig.json` from the baseline commit into a temporary
directory; symlink that engine directory's `node_modules` to this checkout's engine
dependencies. Set `PERF_ENGINE_ROOT` to the extracted engine directory and run the
same command. The harness uses an isolated temporary cwd, stub workers and a
temporary ledger path.

## Validation and next steps

- `bun test server/engine/test`: **48 tests passed**, including subprocess fixtures.
- `bun run test:market:integration`: all four integration programs passed, including
  transfer recovery, pending logout saves, escrow, rollback and GE-disabled saves.
- `bunx tsc --noEmit -p server/engine/tsconfig.json`: passed.
- Additional focused tests after strengthening assertions: passed.
- Scoped whitespace check and exported-patch application check: passed.

New regression coverage checks randomized fragmented input against a byte queue,
full receive capacity, partial/overlapping packet copies, private and shared zone
events, fallback equivalence, movement and reconnect invalidation, and retained
save bytes after packet reuse. Existing market recovery tests exercise populated
inventories and recovery boundaries. See [engine test log](engine-tests.txt) and
[integration log](market-integration.txt).

After deployment, compare several unprofiled, non-overlapping tick windows at
similar player counts and session churn. Capture processing time, tick interval,
over-budget fraction, phase timings, pending logins and RSS; then profile briefly
again. No production improvement has yet been measured.

The next larger project should target repeated whole-world serialization and
checkpoint writes, with recovery tests designed first. Do not simply memoize a
checkpoint once per tick: ordinary trades and GE operations can change ownership
between calls in the same tick. Any coalescing must preserve an atomic recovery
boundary for online players, pending logouts and escrow. During busy reconnect
periods, staggering fleet reconnects remains useful operationally.
