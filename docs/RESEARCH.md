# Research notes and prior art

A note on how this document was produced, stated plainly rather than
glossed over: live web search was unavailable for the entire research
pass behind this project (every query returned a server error). What
follows is grounded in well-established, extensively documented
architectural literature that predates and doesn't depend on recent
developments — CQRS, the Saga pattern, and the transactional outbox
pattern are all 10–35-year-old, thoroughly settled ideas with stable,
canonical treatments, not fast-moving current events. That makes this a
reasonable foundation to design against without live sources — but it's
also why this document cites patterns and their originators by name and
well-known general reputation rather than linking specific articles or
quoting anyone directly: those specific links and quotes couldn't be
verified this session. Treat the attributions below as "this is the
well-known origin and standard treatment of this idea," not as sourced
citations — and re-run this research pass with live search before
publishing anything that claims to have checked primary sources, if that
matters for how this project is presented.

## CQRS (Command Query Responsibility Segregation)

**Origin and standard treatment:** CQRS as a named pattern traces to
Greg Young's work in the mid-2000s, building on Bertrand Meyer's earlier
"Command-Query Separation" principle (a much older, narrower idea about
individual methods). Martin Fowler's writing on CQRS is the most widely
cited accessible treatment of the pattern at the system-architecture
level — the idea that a system's model for *handling writes* and its
model for *serving reads* can be, and past a certain complexity should
be, genuinely different structures, not one shared object graph pressed
into serving both purposes.

**The pitfall this project is built specifically to avoid:** the most
common failure mode in real CQRS implementations isn't misunderstanding
the pattern conceptually — it's building the separation and then, under
deadline pressure or because "it's just one query, it'll be fine,"
having some write-path decision quietly read from the read model anyway.
The read model exists precisely because it's allowed to be
denormalized, cached, and stale; the moment anything that requires
correctness depends on it, the system has quietly reverted to a single
consistency model wearing CQRS's naming conventions. This project's
central discipline — a database-enforced permission boundary between the
two (see `docs/ARCHITECTURE.md` §4) — exists because a code convention
alone has a well-documented track record of not holding under real
deadline pressure.

**Eventual consistency is the trade you're actually making.** CQRS
doesn't eliminate the CAP-theorem-style tension between consistency and
availability/performance — it relocates it to an explicit, visible
boundary (the read model's staleness window) instead of leaving it
implicit and undiscussed. A system that "does CQRS" without ever having
to reckon with "how stale can the read model be, and is that
acceptable for this specific query" hasn't actually engaged with what
the pattern trades away in exchange for what it buys.

## The Saga pattern

**Origin:** the term originates from a 1987 database systems paper by
Hector Garcia-Molina and Kenneth Salem, addressing long-lived
transactions that can't practically be held as a single ACID unit. The
pattern was later popularized specifically for distributed/microservice
systems by Chris Richardson (whose "microservices.io" pattern catalog is
the standard modern reference point for both the Saga pattern and the
transactional outbox pattern below) — the core idea translating cleanly:
when a business operation spans multiple independently-owned pieces of
data that can't share one transaction, break it into a sequence of local
transactions, each with a defined **compensating transaction** that can
semantically undo it if a later step in the sequence fails.

**Orchestration vs. choreography** is the standard fork in the road for
implementing a saga: an orchestrated saga has one coordinator explicitly
directing each step and deciding when to compensate; a choreographed
saga has each participant react to events from the others with no
central coordinator. Orchestration is generally regarded as easier to
reason about, test, and debug for a moderate number of steps; choreography
scales better to a large number of loosely-coupled participants but
makes the overall flow harder to see in one place (it's implicit in the
sum of every participant's event handlers, not explicit in any single
piece of code). This project deliberately chooses orchestration — see
`docs/ARCHITECTURE.md` §6 for the specific reasoning, including the
direct tension with `@nestjs/cqrs`'s built-in `Saga` primitive, which is
actually a choreography helper, not an orchestration one.

**What this project deliberately does NOT yet build**, consistent with
the standard literature's fuller treatment of the pattern: a durable,
crash-recoverable saga log that can resume exactly where a crashed
coordinator left off; timeout-and-retry policies per step; and true
cross-service compensation where "vendor B's data" is a genuinely
separate database or service reachable only over the network, with its
own failure modes (timeouts, partial responses) distinct from a local
transaction failing. This project's saga is real — genuine compensating
transactions, genuinely modeled as if each vendor were an independent
system — but v1 accepts a real, named gap (a crash mid-saga is caught by
a timeout sweep, not resumed exactly where it left off) rather than
building the full durable-orchestration machinery the roadmap's week 15
capstone is explicitly scoped to cover.

## The transactional outbox pattern

**Standard treatment:** also catalogued by Richardson's pattern
language, addressing a specific, easy-to-miss failure mode: a service
that updates its own database and then separately publishes an event
(to a queue, a message bus, whatever) has no way to guarantee both
happen — the database write can succeed and the event publish can fail,
or vice versa, and there's no transaction spanning both because they're
different systems. The outbox pattern's fix is to write the "event to
be published" as a row in the *same* database, in the *same*
transaction, as the state change it describes — turning "publish
reliably" into "read a table," which is a problem the database's own
transactional guarantees already solve.

**This project's specific implementation choice** — a database
*trigger* populating the outbox, rather than application code
remembering to write an outbox row alongside every state change — is a
stronger, less commonly seen variant of the standard pattern. The
standard treatment usually describes application-level outbox writes
(the service's own code inserts the outbox row inside its transaction).
This project (following SearchCraft, an earlier project in this same
portfolio) goes further: the outbox row's creation is not something
application code does at all, so it's not something application code
can forget to do, through any code path, ever. This is a deliberate
strengthening of the standard pattern, not a deviation from it — the
core guarantee (the event record and the state change share a
transaction) is identical; only *which layer* is responsible for writing
the outbox row differs.

## Real-world multi-vendor order splitting

**General, well-documented industry shape, not sourced from a specific
citation this session:** large multi-vendor marketplaces (the
best-known public examples being Amazon's third-party marketplace and
Etsy) split a single buyer-facing checkout into multiple independent
fulfillment units whenever a cart spans more than one seller — each
seller ships, tracks, and is paid for their own portion independently,
and the buyer-facing "order" is a logical aggregate over what are, on
the fulfillment side, genuinely separate transactions. The buyer-facing
UI for this is typically presented as "your order has been split into N
shipments" — the user-facing acknowledgment of exactly the
`customer_order` → `vendor_suborders` decomposition this project
implements directly.

**The specific correctness question this project focuses on** — what
happens when a cart spans multiple vendors and *some but not all* of
them can actually fulfill their portion — is a genuine, unresolved-by-
convention design choice real marketplaces make differently: some
adopt an all-or-nothing policy (the whole cart fails if any vendor can't
fulfill their part), others adopt partial fulfillment (ship what's
available, refund or re-confirm the rest). This project adopts
all-or-nothing for v1, and names the reasoning explicitly in
`docs/ARCHITECTURE.md` §7 rather than presenting it as the only
reasonable choice — partial fulfillment is real, valid, and
meaningfully more complex (it needs partial-refund logic and often a
buyer confirmation step for the reduced order), and is named as a
deliberate scope cut, not an oversight.

## Preventing overselling under concurrency

**Standard techniques, well documented across e-commerce engineering
literature generally:** optimistic concurrency (a version column checked
on write, retried on conflict), pessimistic row locking (`SELECT ... FOR
UPDATE`, holding a lock for the duration of the decision), and a single
atomic conditional update (`UPDATE ... WHERE available >= requested`,
checked via affected-row count) are the three most common approaches.
This project uses the third, for the same reason it's used repeatedly
elsewhere in this portfolio (LedgerLine's balance updates, SplitStack's
optimistic locking, PyDataRex's leader election, this project's own
saga-step claiming) — it requires no held lock across any other work,
no retry loop for the common case, and expresses the entire correctness
guarantee in one statement whose result (affected-row count) is
unambiguous. See `docs/ARCHITECTURE.md` §2 for the exact statement and
why the computed-availability approach (`on_hand - reserved`, never a
separately stored and independently updated "available" column) closes
off an entire class of dual-write drift bugs before they're possible.

## Open questions this research pass did not resolve

- Whether real large-scale marketplaces implement their read-model /
  write-model boundary via database-level permission separation (this
  project's approach) or purely via service/network boundaries (a
  genuinely separate read service that simply has no code path capable
  of writing, running against its own replica) is not something this
  research pass could confirm either way without live sources — both are
  legitimate, and this project's single-Postgres-instance role
  separation is presented as a reasonable, provably-enforced middle
  ground for a project this size, not a claim about what any specific
  real company does.
- The exact terminology real marketplace engineering teams use
  internally for what this project calls a "vendor suborder" (Amazon's
  own internal terminology, for instance) is not something this pass
  could verify — the term used throughout this project's docs and code
  is this project's own choice, not a claim to match industry-standard
  vocabulary exactly.
